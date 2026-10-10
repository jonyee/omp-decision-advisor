import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverDecisionDeployments } from "../src/azure-models.js";
import type { AzureRunner } from "../src/azure-cli.js";
import { normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "../src/config.js";

const configured: DecisionSettings = {
  endpoint: "https://example.invalid",
  deployment: "chosen-decision",
  reviewModel: "provider/chosen-advisor",
  credentialMode: "default",
  passThreshold: 0.72,
  timeoutMs: 750,
  advisorTimeoutMs: 1_250,
};

test("unconfigured preferences are readable but cannot create scoring options", () => {
  const settings = normalizeDecisionSettings({ endpoint: "", deployment: "", reviewModel: configured.reviewModel });
  assert.throws(() => toDecisionOptions(settings), /endpoint and deployment/);
  for (const partial of [{ endpoint: configured.endpoint }, { deployment: configured.deployment }]) {
    assert.throws(() => toDecisionOptions(normalizeDecisionSettings(partial)), /endpoint and deployment/);
  }
  const selected = toDecisionOptions(normalizeDecisionSettings({ ...configured }));
  assert.equal(selected.endpoint, configured.endpoint);
  assert.equal(selected.deployment, configured.deployment);
});

test("changing triage tuning preserves explicit advisor and Azure identity choices", () => {
  const tuned = normalizeDecisionSettings({ ...configured, passThreshold: 0.55, timeoutMs: 5_000 });
  assert.equal(tuned.reviewModel, "provider/chosen-advisor");
  assert.equal(toDecisionOptions(tuned).credentialMode, "default");
  const role = normalizeDecisionSettings({ ...tuned, reviewModel: "@advisor", credentialMode: "azure-cli" });
  assert.equal(role.reviewModel, "@advisor");
  assert.equal(toDecisionOptions(role).credentialMode, "azure-cli");
});

test("stored host deadlines and pass probability have bounded numeric semantics", () => {
  for (const passThreshold of [0.5, 1]) {
    assert.equal(toDecisionOptions(normalizeDecisionSettings({ ...configured, passThreshold })).passThreshold, passThreshold);
  }
  for (const passThreshold of [NaN, Infinity, -Infinity, 0.49, 1.01, "0.8", null]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, passThreshold }));
  }
  for (const key of ["timeoutMs", "advisorTimeoutMs"] as const) {
    for (const value of [100, 20_000]) {
      const settings = normalizeDecisionSettings({ ...configured, [key]: value });
      assert.equal(settings[key], value);
    }
    for (const value of [99, 20_001, 100.5, Infinity, NaN, "1000", null]) {
      assert.throws(() => normalizeDecisionSettings({ ...configured, [key]: value }));
    }
  }
  assert.throws(() => toDecisionOptions({ ...configured, timeoutMs: 20_001 }));
});

test("stored provider endpoints reject credentials and non-origin URLs even before deployment selection", () => {
  const endpoints = ["http://example.invalid", "http://127.0.0.1", "ftp://example.invalid", "https://user:password@example.invalid",
    "https://example.invalid/path", "https://example.invalid?key=test", "https://example.invalid#test", "not-a-url"];
  for (const endpoint of endpoints) {
    assert.throws(() => normalizeDecisionSettings({ endpoint, deployment: "" }));
  }
  const normalized = normalizeDecisionSettings({ ...configured, endpoint: " https://example.invalid/ " });
  assert.equal(toDecisionOptions(normalized).endpoint, "https://example.invalid");
  for (const deployment of ["bad/name", "bad name", "x".repeat(129), 123]) {
    assert.throws(() => normalizeDecisionSettings({ endpoint: "", deployment }));
  }
});

test("invalid advisor selectors and unknown credential modes cannot become persisted preferences", () => {
  for (const reviewModel of ["", "   ", "provider/model\nprivate", null, 42]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, reviewModel }));
  }
  for (const credentialMode of ["cli", "key", "", null]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, credentialMode }));
  }
});

test("Azure model selection offers only healthy existing Decision-1 deployments", async () => {
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return [
      { name: "healthy-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } },
      { name: "unhealthy-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Failed", endpoint: configured.endpoint } },
      { name: "other-kind-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "OpenAI", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } },
    ] as T;
    return [
      { name: "selected", properties: { provisioningState: "Succeeded", model: { name: "Microsoft-Decision-1", format: "Microsoft", version: "fixture" } } },
      { name: "unhealthy", properties: { provisioningState: "Failed", model: { name: "Microsoft-Decision-1", format: "Microsoft" } } },
      { name: "wrong-model", properties: { provisioningState: "Succeeded", model: { name: "Other", format: "Microsoft" } } },
      { name: "wrong-format", properties: { provisioningState: "Succeeded", model: { name: "Microsoft-Decision-1", format: "Other" } } },
    ] as T;
  };
  const choices = await discoverDecisionDeployments(run);
  assert.deepEqual(choices.map(choice => choice.deployment), ["selected"]);
  assert.equal(choices[0]?.location, "region-fixture");
  assert.equal(choices[0]?.model, "Microsoft-Decision-1");
});

test("deployment discovery can use readable accounts when another account denies cloud reads", async () => {
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return ["denied", "readable"].map(name => ({ name, resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } })) as T;
    if (args[args.indexOf("--name") + 1] === "denied") throw new Error("denied fixture");
    return [{ name: "available", properties: { provisioningState: "Succeeded", model: { name: "Microsoft-Decision-1", format: "Microsoft" } } }] as T;
  };
  assert.deepEqual((await discoverDecisionDeployments(run)).map(choice => choice.deployment), ["available"]);
});

test("denied Azure discovery explains the manual configuration alternative without leaking metadata", async () => {
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return [{ name: "account-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } }] as T;
    throw new Error("private-fixture-marker");
  };
  await assert.rejects(discoverDecisionDeployments(run), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /manually/);
    assert.equal(error.message.includes("private-fixture-marker"), false);
    return true;
  });
});
