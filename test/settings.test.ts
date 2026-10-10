import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverDecisionDeployments } from "../src/azure-models.js";
import type { AzureRunner } from "../src/azure-cli.js";
import { MAX_REVIEW_INSTRUCTIONS_BYTES, normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "../src/config.js";
import { ELEVATED_REVIEW_TOOLS, parseReviewTools } from "../src/review-tools.js";

const configured: DecisionSettings = {
  enabled: true,
  endpoint: "https://example.invalid",
  deployment: "chosen-decision",
  reviewModel: "provider/chosen-advisor",
  credentialMode: "default",
  passThreshold: 0.72,
  timeoutMs: 750,
  advisorTimeoutMs: 1_250,
  reviewTools: "read,grep,glob",
  reviewInstructions: "",
  reviewHistoryTurns: 3,
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

test("missing enabled preferences retain automatic review for existing profiles", () => {
  const { enabled: _enabled, ...existing } = configured;
  assert.equal(normalizeDecisionSettings(existing).enabled, true);
  assert.equal(normalizeDecisionSettings({}).enabled, true);
});

test("disabled automatic review persists while changing threshold and advisor model", () => {
  const disabled = normalizeDecisionSettings({ ...configured, enabled: false });
  const restored = normalizeDecisionSettings(JSON.parse(JSON.stringify(disabled)));
  const tuned = normalizeDecisionSettings({ ...restored, passThreshold: 0.55 });
  const selected = normalizeDecisionSettings({ ...tuned, reviewModel: "provider/alternate-advisor" });
  for (const settings of [disabled, restored, tuned, selected]) {
    assert.equal(settings.enabled, false);
    assert.equal(Object.hasOwn(toDecisionOptions(settings), "enabled"), false);
    assert.equal(settings.enabled, false);
  }
  assert.equal(selected.passThreshold, 0.55);
  assert.equal(selected.reviewModel, "provider/alternate-advisor");
  assert.equal(toDecisionOptions(selected).deployment, configured.deployment);
  assert.equal(toDecisionOptions(selected).credentialMode, configured.credentialMode);
});

test("enabled preferences reject non-boolean stored values", () => {
  for (const enabled of ["true", "false", "", 0, 1, null, [], {}]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, enabled }), /enabled must be a boolean/);
  }
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

test("existing profiles receive bounded reviewer defaults without adding elevated grants", () => {
  const defaults = normalizeDecisionSettings({});
  assert.equal(parseReviewTools(defaults.reviewTools).some(tool => ELEVATED_REVIEW_TOOLS.includes(tool)), false);
});

test("reviewer tools normalize comma and whitespace grants in deterministic supported order", () => {
  assert.deepEqual(parseReviewTools(" GLOB, READ grep,read\nGrep\tglob "), ["read", "grep", "glob"]);
  assert.equal(normalizeDecisionSettings({ reviewTools: "write, BASH, read,read" }).reviewTools, "read,bash,write");
});

test("empty reviewer grants remain empty across normalization and preference round trips", () => {
  for (const reviewTools of ["", "  ", ", ,\n\t"]) {
    const settings = normalizeDecisionSettings({ ...configured, reviewTools });
    assert.equal(settings.reviewTools, "");
    assert.deepEqual(parseReviewTools(settings.reviewTools), []);
    assert.equal(normalizeDecisionSettings(JSON.parse(JSON.stringify(settings))).reviewTools, "");
  }
});

test("unknown and non-string reviewer grants cannot become persisted preferences", () => {
  for (const reviewTools of ["task", "spawn", "mcp", "custom_tool", "read,unknown", "read;bash", null, 0, ["read"], {}]) {
    assert.throws(() => normalizeDecisionSettings({ reviewTools }));
  }
  assert.throws(() => parseReviewTools("READ task"), /Unknown reviewer tool: task/);
});

test("saved reviewer preferences survive triage changes without granting additional tools", () => {
  const preferences = normalizeDecisionSettings({
    ...configured,
    reviewTools: "recall,read,lsp",
    reviewInstructions: "  Check evidence.\n\tExplain uncertainty.\r\n",
    reviewHistoryTurns: 8,
  });
  const restored = normalizeDecisionSettings(JSON.parse(JSON.stringify(preferences)));
  const changed = normalizeDecisionSettings({ ...restored, passThreshold: 0.9, reviewModel: "@advisor" });
  assert.equal(changed.reviewTools, "read,recall,lsp");
  assert.equal(changed.reviewInstructions, preferences.reviewInstructions);
  assert.equal(changed.reviewHistoryTurns, 8);
  assert.equal(parseReviewTools(changed.reviewTools).some(tool => ELEVATED_REVIEW_TOOLS.includes(tool)), false);
  const scoring = toDecisionOptions(changed);
  for (const key of ["reviewTools", "reviewInstructions", "reviewHistoryTurns"]) assert.equal(Object.hasOwn(scoring, key), false);
});

test("review history preferences accept only integers from zero through eight", () => {
  for (let reviewHistoryTurns = 0; reviewHistoryTurns <= 8; reviewHistoryTurns++) {
    assert.equal(normalizeDecisionSettings({ reviewHistoryTurns }).reviewHistoryTurns, reviewHistoryTurns);
  }
  for (const reviewHistoryTurns of [-1, 9, 0.5, 3.1, NaN, Infinity, -Infinity, "3", null, false, []]) {
    assert.throws(() => normalizeDecisionSettings({ reviewHistoryTurns }));
  }
});

test("reviewer instructions preserve multiline content and enforce UTF-8 byte boundaries", () => {
  for (const reviewInstructions of ["", " \t\n\r ", "x".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES), "é".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 2), "😀".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 4)]) {
    assert.equal(normalizeDecisionSettings({ reviewInstructions }).reviewInstructions, reviewInstructions);
  }
  for (const reviewInstructions of ["x".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES + 1), "é".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 2 + 1), "😀".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 4 + 1), null, 42, []]) {
    assert.throws(() => normalizeDecisionSettings({ reviewInstructions }));
  }
});

test("reviewer instructions reject forbidden controls without scanning ordinary content", () => {
  for (const control of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f", "\u007f", "\u0085", "\u009f"]) {
    assert.throws(() => normalizeDecisionSettings({ reviewInstructions: `${control}text${control}` }), /control characters/);
  }
  const reviewInstructions = "Review names such as token, password and credential as ordinary text.";
  assert.equal(normalizeDecisionSettings({ reviewInstructions }).reviewInstructions, reviewInstructions);
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

test("cancelled discovery does not begin cloud access", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const run: AzureRunner = async <T>(): Promise<T> => { calls++; throw new Error("Unexpected cloud access"); };
  await assert.rejects(discoverDecisionDeployments(run, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("cancellation during an account read never becomes a partial deployment list", async () => {
  const controller = new AbortController();
  const visited: string[] = [];
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return ["first", "second"].map(name => ({ name, resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } })) as T;
    visited.push(args[args.indexOf("--name") + 1]!);
    controller.abort();
    throw new Error("Aborted cloud read");
  };
  await assert.rejects(discoverDecisionDeployments(run, controller.signal), { name: "AbortError" });
  assert.deepEqual(visited, ["first"]);
});

test("cancellation while listing accounts does not report no deployments", async () => {
  const controller = new AbortController();
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    controller.abort();
    return [] as T;
  };
  await assert.rejects(discoverDecisionDeployments(run, controller.signal), { name: "AbortError" });
});
