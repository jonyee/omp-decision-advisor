import assert from "node:assert/strict";
import test from "node:test";
import { AzureDeploymentTool, environmentInstructions, safeCandidate, safePlan, type Account, type AzureRunner, type Plan } from "../deploy/azure.ts";
import { assertReusable, eligibleModels, selectDeployment, selectModel, type CatalogModel, type Deployment, type Usage } from "../deploy/policy.ts";

const model: CatalogModel = {
  name: "Microsoft-Decision-1", format: "Microsoft", version: "1", isDefaultVersion: true, lifecycleStatus: "Stable",
  skus: [
    { name: "GlobalStandard", usageName: "AIServices.GlobalStandard.Microsoft-Decision-1", capacity: { maximum: 5000 } },
    { name: "DataZoneStandard", usageName: "AIServices.DataZoneStandard.Microsoft-Decision-1", capacity: { maximum: 5000 } },
  ],
};
const usages: Usage[] = [
  { name: { value: "AIServices.GlobalStandard.Microsoft-Decision-1" }, currentValue: 0, limit: 50 },
  { name: { value: "AIServices.DataZoneStandard.Microsoft-Decision-1" }, currentValue: 0, limit: 17 },
];
const account: Account = { name: "fixture-account", resourceGroup: "fixture-group", location: "eastus", kind: "AIServices",
  properties: { provisioningState: "Succeeded", endpoint: "https://fixture-account.example.invalid/", publicNetworkAccess: "Enabled" } };
const selection = selectDeployment([model], usages, 1);
const deployment: Deployment = { name: "fixture-deployment", properties: { model: { name: model.name, format: model.format, version: model.version }, provisioningState: "Succeeded" }, sku: { name: selection.sku.name, capacity: 1 } };
const plan: Plan = { subscription: "fixture-subscription", account, selection, deployment: deployment.name, action: "create" };

// These are synthetic consumer fixtures; no live Azure identifiers are recorded.
test("only live Microsoft Decision versions are eligible, with unambiguous version selection", () => {
  assert.equal(selectModel([model]).version, "1");
  assert.deepEqual(eligibleModels([{ ...model, format: "OpenAI" }, { ...model, lifecycleStatus: "Retired" }, { ...model, deprecation: { inference: "2000-01-01T00:00:00Z" } }]), []);
  assert.throws(() => selectModel([]), /unavailable/);
  assert.throws(() => selectModel([model, { ...model, version: "2" }]), /ambiguous/);
  assert.equal(selectModel([{ ...model, isDefaultVersion: false }, { ...model, version: "2" }]).version, "2");
});

test("selects the live data-zone SKU preferentially, obeying explicit SKU and quota", () => {
  assert.equal(selection.sku.name, "DataZoneStandard");
  assert.equal(selectDeployment([model], usages, 1, "GlobalStandard").sku.name, "GlobalStandard");
  const exhausted = usages.map(usage => usage.name.value.includes("DataZone") ? { ...usage, currentValue: usage.limit } : usage);
  assert.equal(selectDeployment([model], exhausted, 1).sku.name, "GlobalStandard");
  assert.throws(() => selectDeployment([model], exhausted, 1, "DataZoneStandard"), /confirmed quota/);
  assert.throws(() => selectDeployment([model], [], 1), /confirmed quota/);
  assert.throws(() => selectDeployment([model], usages.map(usage => ({ ...usage, status: "Blocked" })), 1), /confirmed quota/);
});

test("capacity selection honors catalog constraints instead of silently increasing capacity", () => {
  const restricted: CatalogModel = { ...model, skus: [{ ...model.skus![1]!, capacity: { minimum: 2, maximum: 10, step: 2 } }] };
  assert.throws(() => selectDeployment([restricted], usages, 1), /capacity/);
  assert.equal(selectDeployment([restricted], usages, 4).capacity, 4);
  assert.throws(() => selectDeployment([restricted], usages, 3), /capacity/);
  assert.throws(() => selectDeployment([model], usages, 0), /capacity/);
  assert.throws(() => selectDeployment([model], usages, 1.5), /capacity/);
});

test("healthy matching deployment reuses its quota, but every conflict is rejected", () => {
  const full = usages.map(usage => ({ ...usage, currentValue: usage.limit }));
  assert.equal(selectDeployment([model], full, 1, undefined, deployment).sku.name, deployment.sku!.name);
  const allocated = { ...deployment, sku: { ...deployment.sku, capacity: 17 } };
  assert.equal(selectDeployment([{ ...model, maxCapacity: 3 }], full, 17, "DataZoneStandard", allocated).capacity, 17);
  assert.throws(() => selectDeployment([{ ...model, maxCapacity: 3 }], usages, 17, "DataZoneStandard"), /capacity/);
  const conflicts: Deployment[] = [
    { ...deployment, properties: { ...deployment.properties, model: { ...deployment.properties!.model, name: "another-model" } } },
    { ...deployment, properties: { ...deployment.properties, model: { ...deployment.properties!.model, version: "2" } } },
    { ...deployment, sku: { ...deployment.sku, capacity: 2 } },
    { ...deployment, sku: { ...deployment.sku, name: "GlobalStandard" } },
    { ...deployment, properties: { ...deployment.properties, provisioningState: "Failed" } },
  ];
  for (const conflict of conflicts) assert.throws(() => assertReusable(conflict, selection), /refusing/);
});

test("apply is idempotent and rejects a conflicting deployment appearing after planning", async () => {
  for (const existing of [deployment, { ...deployment, sku: { name: "GlobalStandard", capacity: 1 } }]) {
    let mutations = 0;
    const runner: AzureRunner = async <T>(args: string[]): Promise<T> => {
      if (args.includes("create")) mutations++;
      return [existing] as T;
    };
    const tool = new AzureDeploymentTool(runner);
    if (existing === deployment) assert.equal(await tool.apply(plan), "reused");
    else await assert.rejects(tool.apply(plan), /refusing/);
    assert.equal(mutations, 0);
  }
});

test("discovery requires an unambiguous eligible existing account", async () => {
  const runner: AzureRunner = async <T>(args: string[]): Promise<T> => {
    let result: unknown;
    if (args[0] === "account") result = { id: "fixture-subscription", state: "Enabled" };
    else if (args[0] === "cloud") result = { endpoints: { resourceManager: "https://management.azure.com/" } };
    else if (args[0] === "rest") result = { value: usages };
    else if (args.includes("list-models")) result = [model];
    else if (args.includes("deployment")) result = [];
    else result = [account, { ...account, name: "second-fixture-account", location: "eastus2" }];
    return result as T;
  };
  const tool = new AzureDeploymentTool(runner);
  await assert.rejects(tool.plan({ deployment: "fixture-deployment", capacity: 1 }), /ambiguous/);
  assert.equal((await tool.plan({ account: account.name, resourceGroup: account.resourceGroup, deployment: "fixture-deployment", capacity: 1 })).account.name, account.name);
  assert.equal((await tool.plan({ location: "eastus2", deployment: "fixture-deployment", capacity: 1 })).account.location, "eastus2");
});

test("default summaries never expose identifiers; endpoint exports are an explicit separate operation", () => {
  const candidate = { account, models: [model], usages, deployments: [], selection };
  const summary = JSON.stringify([safeCandidate(candidate, 0), safePlan(plan)]);
  for (const sensitive of [account.name, account.resourceGroup, plan.subscription, account.properties!.endpoint!, deployment.name]) assert.equal(summary.includes(sensitive), false);
  assert.throws(() => environmentInstructions({ ...plan, account: { ...account, properties: { endpoint: "https://user:password@example.invalid/" } } }), /unexpected/);
});
