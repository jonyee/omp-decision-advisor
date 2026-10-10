import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { AzureDeploymentTool } from "../deploy/azure.ts";

try {
  const environment = { ...process.env };
  // npm prepends the SDK's source CLI, which requires Bun; use the installed OMP binary.
  environment.PATH = (environment.PATH ?? "").split(delimiter).filter(directory => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(directory)).join(delimiter);
  // This local launcher already depends on az; skip cloud-instance identity discovery.
  environment.AZURE_TOKEN_CREDENTIALS ??= "AzureCliCredential";
  if (!environment.DECISION_ENDPOINT) {
    const tool = new AzureDeploymentTool();
    const plan = await tool.plan({
      location: environment.DECISION_LOCATION || "eastus2",
      account: environment.DECISION_ACCOUNT,
      resourceGroup: environment.DECISION_RESOURCE_GROUP,
      subscription: environment.DECISION_SUBSCRIPTION,
      deployment: environment.DECISION_DEPLOYMENT || "omp-decision-1",
      sku: "DataZoneStandard",
      capacity: Number(environment.DECISION_CAPACITY || "17"),
    });
    if (plan.action !== "reuse") throw new Error("No healthy matching Decision-1 deployment exists. Run npm run deploy -- apply first.");
    environment.DECISION_ENDPOINT = plan.account.properties?.endpoint;
    environment.DECISION_DEPLOYMENT = plan.deployment;
  }
  const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const child = spawn("omp", ["--extension", extension, ...process.argv.slice(2)], { env: environment, stdio: "inherit", shell: false });
  child.on("error", () => { console.error("Could not launch omp. Install OMP 18.8.7 or compatible."); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch {
  console.error("Cannot connect to the existing Decision-1 deployment. Check az login, deployment status, region and runtime configuration; resource details are not logged.");
  process.exitCode = 1;
}
