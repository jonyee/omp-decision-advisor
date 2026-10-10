import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { AzureDeploymentTool, environmentInstructions, safeCandidate, safePlan, type DeployOptions } from "./azure.ts";

const HELP = `Usage: npm run deploy -- <list|plan|apply> [options]
  --account NAME           Existing AIServices account (never creates accounts)
  --resource-group NAME    Existing account's resource group
  --subscription NAME_OR_ID  Optional; defaults to authenticated current subscription
  --location REGION        Filter existing accounts (for example eastus2)
  --deployment NAME        Default: omp-decision-1
  --sku NAME               Optional live supported SKU; prefers DataZoneStandard
  --capacity NUMBER        Default: 1; requires supported capacity and confirmed quota
  --show-identifiers       list only: reveal account/group names in a private terminal
  --print-env              plan/apply only: print real endpoint exports in a private terminal
  --help                   Show this help

Default output excludes account, group, subscription, endpoint and deployment names.
Apply may incur Azure charges. It only creates Microsoft-Decision-1 deployment, never
changes account security, identity, network, roles, resource groups or reviewer models.
A matching healthy deployment is reused; conflicting deployments are never updated.
Do not concurrently deploy the same name elsewhere: Azure create is create-or-update.
Model catalog and quota do not guarantee allocation or permission; Azure is authoritative.
Prerequisites: az login, enabled subscription, existing healthy AIServices account,
read access to account/models/deployments/regional usage and deployment write permission.
Inference also requires existing Azure identity/data-plane permission and network access.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    account: { type: "string" }, "resource-group": { type: "string" }, subscription: { type: "string" },
    location: { type: "string" },
    deployment: { type: "string", default: "omp-decision-1" }, sku: { type: "string" }, capacity: { type: "string", default: "1" },
    "print-env": { type: "boolean", default: false }, "show-identifiers": { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["list", "plan", "apply"].includes(command ?? "")) throw new Error("Specify exactly one command: list, plan or apply. Use --help for options.");
  if (values["print-env"] && command === "list") throw new Error("--print-env requires plan or apply.");
  if (values["show-identifiers"] && command !== "list") throw new Error("--show-identifiers is supported only by list.");
  for (const value of [values.account, values["resource-group"], values.subscription, values.location, values.deployment, values.sku]) {
    if (value !== undefined && (!value.trim() || value.startsWith("-") || /[\r\n\0]/u.test(value))) throw new Error("Option values must be nonempty and must not contain control characters or start with a dash.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(values.deployment!)) throw new Error("Deployment name must be 1–64 letters, numbers, underscores, dots or hyphens and start with a letter or number.");
  if (!/^\d+$/u.test(values.capacity!) || !Number.isSafeInteger(Number(values.capacity)) || Number(values.capacity) < 1) throw new Error("Capacity must be a positive safe integer.");
  const options: DeployOptions = { account: values.account, resourceGroup: values["resource-group"], subscription: values.subscription,
    location: values.location, deployment: values.deployment!, sku: values.sku, capacity: Number(values.capacity) };
  const tool = new AzureDeploymentTool();
  if (command === "list") {
    const discovery = await tool.discover(options);
    console.log(JSON.stringify({ accounts: discovery.candidates.map((candidate, index) => safeCandidate(candidate, index, values["show-identifiers"])),
      note: "Eligibility includes requested deployment/capacity and confirmed live quota, not guaranteed allocation. Use --show-identifiers only in a private terminal to select among accounts." }, null, 2));
    return;
  }
  const plan = await tool.plan(options);
  if (command === "apply") {
    const result = await tool.apply(plan);
    console.log(JSON.stringify({ ...safePlan(plan), result }, null, 2));
  } else console.log(JSON.stringify(safePlan(plan), null, 2));
  if (values["print-env"]) process.stdout.write(environmentInstructions(plan));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // parseArgs diagnostics can echo user-provided identifiers: never print them.
    const parseError = typeof error === "object" && error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS");
    console.error(parseError ? "Invalid CLI arguments. Use --help for accepted options." : error instanceof Error ? error.message : "Deployment command failed; raw diagnostics suppressed.");
    process.exitCode = 1;
  });
}
