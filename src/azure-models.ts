import { runAzure, type AzureRunner } from "./azure-cli.ts";
import { normalizeDecisionSettings, toDecisionOptions } from "./config.ts";

interface AzureAccount {
  name: string;
  resourceGroup: string;
  location: string;
  kind: string;
  properties?: { provisioningState?: string; endpoint?: string };
}
interface AzureDeployment {
  name: string;
  properties?: {
    provisioningState?: string;
    model?: { name?: string; format?: string; version?: string };
  };
}
export interface DecisionDeployment {
  endpoint: string;
  deployment: string;
  location: string;
  model: string;
  version?: string;
}

/** Discover healthy existing deployments in the Azure CLI's active subscription; never mutate Azure. */
export async function discoverDecisionDeployments(run: AzureRunner = runAzure, signal?: AbortSignal): Promise<DecisionDeployment[]> {
  signal?.throwIfAborted();
  const subscription = await run<{ id: string; state: string }>(["account", "show"], signal);
  if (subscription.state !== "Enabled" || !subscription.id) {
    throw new Error("Select an enabled Azure subscription after signing in with az login, or enter the scoring endpoint and deployment manually.");
  }
  signal?.throwIfAborted();
  const accounts = await run<AzureAccount[]>(["cognitiveservices", "account", "list", "--subscription", subscription.id], signal);
  signal?.throwIfAborted();
  const choices: DecisionDeployment[] = [];
  let unreadable = false;
  for (const account of accounts) {
    signal?.throwIfAborted();
    if (account.kind !== "AIServices" || account.properties?.provisioningState !== "Succeeded" || !account.properties.endpoint) continue;
    let deployments: AzureDeployment[];
    try {
      deployments = await run<AzureDeployment[]>(["cognitiveservices", "account", "deployment", "list",
        "--name", account.name, "--resource-group", account.resourceGroup, "--subscription", subscription.id], signal);
    } catch {
      signal?.throwIfAborted();
      unreadable = true;
      continue;
    }
    signal?.throwIfAborted();
    for (const deployment of deployments) {
      const model = deployment.properties?.model;
      if (deployment.properties?.provisioningState !== "Succeeded" || model?.name !== "Microsoft-Decision-1" || model.format !== "Microsoft") continue;
      try {
        const options = toDecisionOptions(normalizeDecisionSettings({ endpoint: account.properties.endpoint, deployment: deployment.name }));
        choices.push({ endpoint: options.endpoint, deployment: options.deployment, location: account.location, model: model.name,
          ...(model.version ? { version: model.version } : {}) });
      } catch {
        // Do not offer malformed cloud endpoint/name values or print raw account metadata.
      }
    }
  }
  if (!choices.length && unreadable) {
    throw new Error("Azure deployment discovery requires account read permission. Enter the scoring endpoint and deployment manually instead.");
  }
  return choices;
}
