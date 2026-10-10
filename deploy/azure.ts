import { runAzure, type AzureRunner } from "../src/azure-cli.ts";
import { assertReusable, eligibleModels, selectDeployment, type CatalogModel, type Deployment, type Selection, type Usage } from "./policy.ts";

const API_VERSION = "2024-10-01";

export interface Account {
  name: string;
  resourceGroup: string;
  location: string;
  kind: string;
  properties?: { provisioningState?: string; endpoint?: string; publicNetworkAccess?: string };
}
export interface DeployOptions {
  account?: string;
  resourceGroup?: string;
  subscription?: string;
  location?: string;
  deployment: string;
  sku?: string;
  capacity: number;
}
export interface Candidate {
  account: Account;
  models: CatalogModel[];
  usages: Usage[];
  deployments: Deployment[];
  selection?: Selection;
  reason?: string;
}
export interface Plan { subscription: string; account: Account; selection: Selection; deployment: string; action: "create" | "reuse" }

export class AzureDeploymentTool {
  constructor(private readonly run: AzureRunner = runAzure) {}

  private accountArgs(account: Account, subscription: string): string[] {
    return ["--name", account.name, "--resource-group", account.resourceGroup, "--subscription", subscription];
  }

  async subscription(requested?: string): Promise<string> {
    const value = await this.run<{ id: string; state: string }>(["account", "show", ...(requested ? ["--subscription", requested] : [])]);
    if (value.state !== "Enabled" || !value.id) throw new Error("Select an enabled Azure subscription with --subscription after signing in with az login.");
    return value.id;
  }

  async usages(subscription: string, region: string): Promise<Usage[]> {
    const origin = await this.run<{ endpoints: { resourceManager: string } }>(["cloud", "show"]);
    const base = safeUrl(origin.endpoints.resourceManager);
    let url: string | undefined = `${base.origin}/subscriptions/${encodeURIComponent(subscription)}/providers/Microsoft.CognitiveServices/locations/${encodeURIComponent(region)}/usages?api-version=${API_VERSION}`;
    const values: Usage[] = [];
    const visited = new Set<string>();
    while (url) {
      const next = safeUrl(url);
      if (next.origin !== base.origin || !next.pathname.startsWith(`/subscriptions/${encodeURIComponent(subscription)}/providers/Microsoft.CognitiveServices/locations/`)
        || visited.has(next.href)) throw new Error("Azure returned an unexpected regional quota pagination link.");
      visited.add(next.href);
      const page: { value: Usage[]; nextLink?: string } = await this.run(["rest", "--method", "get", "--url", next.href]);
      values.push(...page.value);
      url = page.nextLink;
    }
    return values;
  }

  async discover(options: DeployOptions): Promise<{ subscription: string; candidates: Candidate[] }> {
    const subscription = await this.subscription(options.subscription);
    const accounts = await this.run<Account[]>(["cognitiveservices", "account", "list", "--subscription", subscription]);
    const selected = accounts.filter(account => account.kind === "AIServices"
      && (!options.account || account.name.toLowerCase() === options.account.toLowerCase())
      && (!options.resourceGroup || account.resourceGroup.toLowerCase() === options.resourceGroup.toLowerCase())
      && (!options.location || account.location.toLowerCase() === options.location.toLowerCase()));
    const usageCache = new Map<string, Usage[]>();
    const candidates: Candidate[] = [];
    for (const account of selected) {
      const candidate: Candidate = { account, models: [], usages: [], deployments: [] };
      try {
        if (account.properties?.provisioningState !== "Succeeded") throw new Error("Existing account is not healthy.");
        candidate.models = await this.run<CatalogModel[]>(["cognitiveservices", "account", "list-models", ...this.accountArgs(account, subscription)]);
        if (!eligibleModels(candidate.models).length) throw new Error("Microsoft-Decision-1 is unavailable in this account's live catalog.");
        let usage = usageCache.get(account.location);
        if (!usage) { usage = await this.usages(subscription, account.location); usageCache.set(account.location, usage); }
        candidate.usages = usage;
        candidate.deployments = await this.deployments(account, subscription);
        const existing = candidate.deployments.find(value => value.name === options.deployment);
        candidate.selection = selectDeployment(candidate.models, usage, options.capacity, options.sku, existing);
      } catch (error) {
        candidate.reason = error instanceof Error ? error.message : "Account eligibility could not be confirmed.";
      }
      candidates.push(candidate);
    }
    return { subscription, candidates };
  }

  async deployments(account: Account, subscription: string): Promise<Deployment[]> {
    return this.run(["cognitiveservices", "account", "deployment", "list", ...this.accountArgs(account, subscription)]);
  }

  async plan(options: DeployOptions): Promise<Plan> {
    const { subscription, candidates } = await this.discover(options);
    const eligible = candidates.filter(candidate => candidate.selection);
    if (eligible.length !== 1) {
      if (candidates.length === 1 && candidates[0]?.reason) throw new Error(candidates[0].reason);
      throw new Error(eligible.length ? `There are ${eligible.length} eligible existing accounts; refusing ambiguous selection. Run list, then specify --account and --resource-group (use list --show-identifiers only in a private terminal).` : "No eligible existing AIServices account was found. Run list to inspect regional model, SKU and quota availability; select an existing account with --account and --resource-group.");
    }
    const candidate = eligible[0]!;
    return { subscription, account: candidate.account, selection: candidate.selection!, deployment: options.deployment,
      action: candidate.deployments.some(value => value.name === options.deployment) ? "reuse" : "create" };
  }

  async apply(plan: Plan): Promise<"created" | "reused"> {
    // Recheck immediately before create: Azure's create command is a create-or-update API.
    // Do not run concurrent deployments with the same name outside this tool.
    const existing = (await this.deployments(plan.account, plan.subscription)).find(value => value.name === plan.deployment);
    if (existing) { assertReusable(existing, plan.selection); return "reused"; }
    if (plan.action === "reuse") throw new Error("The planned existing deployment disappeared; run plan again before creating anything.");
    const { model, sku, capacity } = plan.selection;
    const created = await this.run<Deployment>(["cognitiveservices", "account", "deployment", "create", ...this.accountArgs(plan.account, plan.subscription),
      "--deployment-name", plan.deployment, "--model-name", model.name, "--model-format", model.format, "--model-version", model.version,
      "--sku-name", sku.name, "--sku-capacity", String(capacity)]);
    assertReusable(created, plan.selection);
    return "created";
  }
}

export function safeCandidate(candidate: Candidate, index: number, showIdentifiers = false): object {
  return {
    choice: index + 1, region: candidate.account.location, eligible: Boolean(candidate.selection),
    ...(showIdentifiers ? { account: candidate.account.name, resourceGroup: candidate.account.resourceGroup } : {}),
    models: eligibleModels(candidate.models).map(model => ({ name: model.name, format: model.format, version: model.version,
      skus: (model.skus ?? []).map(sku => {
        const usage = candidate.usages.find(value => value.name?.value === sku.usageName);
        return { name: sku.name, capacity: sku.capacity, ...(usage ? { quota: { limit: usage.limit, used: usage.currentValue, remaining: Math.max(0, usage.limit - usage.currentValue), status: usage.status ?? "reported" } } : { quota: "unknown" }) };
      }) })),
    ...(candidate.reason ? { reason: candidate.reason } : {}),
  };
}

export function safePlan(plan: Plan): object {
  return { action: plan.action, region: plan.account.location, model: { name: plan.selection.model.name, format: plan.selection.model.format, version: plan.selection.model.version },
    sku: plan.selection.sku.name, capacity: plan.selection.capacity, quota: plan.selection.quota,
    networkAccess: plan.account.properties?.publicNetworkAccess ?? "unknown", changes: plan.action === "create" ? "Only the requested model deployment" : "None" };
}


function safeUrl(value: string): URL {
  try { return new URL(value); }
  catch { throw new Error("Azure returned an invalid URL; raw value suppressed."); }
}
