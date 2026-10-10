import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { discoverDecisionDeployments } from "./azure-models.ts";
import { normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "./config.ts";
import { loadDecisionSettings, saveDecisionSettings } from "./settings.ts";

async function selectScoringProvider(ctx: ExtensionCommandContext, draft: DecisionSettings): Promise<DecisionSettings | undefined> {
  const method = await ctx.ui.select("Scoring model — Microsoft-Decision-1", [
    { label: "Choose existing Azure deployment", description: "Read-only discovery in the Azure CLI's active subscription; requires az login and account read permission." },
    { label: "Enter endpoint and deployment manually", description: "Use an existing Microsoft-Decision-1 deployment; no cloud resources will be created." },
  ]);
  if (method === undefined) return undefined;
  if (method === "Choose existing Azure deployment") {
    try {
      const deployments = await discoverDecisionDeployments();
      if (deployments.length) {
        const rows = deployments.map((deployment, index) => ({
          label: `${index + 1}. ${deployment.model}${deployment.version ? ` ${deployment.version}` : ""} · ${deployment.location} · ${deployment.deployment}`,
          description: "Healthy existing deployment; no cloud changes.",
        }));
        const choice = await ctx.ui.select("Choose existing scoring deployment", rows);
        if (choice === undefined) return undefined;
        const selected = deployments[rows.findIndex(row => row.label === choice)];
        if (!selected) return undefined;
        return { ...draft, endpoint: selected.endpoint, deployment: selected.deployment };
      }
      ctx.ui.notify("No healthy existing Microsoft-Decision-1 deployment was found. Enter the endpoint and deployment manually, or cancel.", "warning");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Azure discovery is unavailable. Enter the endpoint and deployment manually, or cancel.", "warning");
    }
  }
  const endpoint = await ctx.ui.input("Account HTTPS endpoint (blank with blank deployment leaves scoring unconfigured)", draft.endpoint);
  if (endpoint === undefined) return undefined;
  const deployment = await ctx.ui.input("Existing Microsoft-Decision-1 deployment name", draft.deployment);
  if (deployment === undefined) return undefined;
  const next = normalizeDecisionSettings({ ...draft, endpoint, deployment });
  if (next.endpoint || next.deployment) toDecisionOptions(next);
  return next;
}

async function selectAdvisorModel(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
  const models = ctx.models.list().filter(model => model.kind === undefined || model.kind === "chat");
  const selectors = [...new Set(models.map(model => `${model.provider}/${model.id}`))];
  const choice = await ctx.ui.select(`Advisor model — current: ${current}`, [
    { label: "Use OMP advisor role (@advisor)", description: "Follow the advisor role configured in OMP." },
    { label: "Enter explicit OMP model selector", description: "Provider/model ID or an OMP role alias available in this session." },
    ...selectors.map(selector => ({ label: selector, description: "Authenticated chat model available in this session." })),
  ]);
  if (choice === undefined) return undefined;
  if (choice === "Use OMP advisor role (@advisor)") return "@advisor";
  if (choice !== "Enter explicit OMP model selector") return choice;
  const entered = await ctx.ui.input("OMP advisor model selector", current);
  if (entered === undefined) return undefined;
  const selector = entered.trim();
  const model = ctx.models.resolve(selector);
  if (!model || (model.kind !== undefined && model.kind !== "chat")) {
    throw new Error("Choose an available OMP chat model or use the OMP advisor role (@advisor).");
  }
  return selector;
}

/** Native TUI/RPC dialogs. Nothing is persisted until the user explicitly confirms Save. */
export async function configureDecision(ctx: ExtensionCommandContext): Promise<DecisionSettings | undefined> {
  if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
    ctx.ui.notify("Configure Decision advisor in interactive OMP with /decision, or use: omp plugin config set omp-decision-advisor <key> <value>. Inspect preferences with: omp plugin config list omp-decision-advisor --json. Select a profile with omp --profile <name> before plugin.", "warning");
    return undefined;
  }
  let draft = await loadDecisionSettings(ctx.cwd);
  for (;;) {
    const choice = await ctx.ui.select("Decision advisor preferences — edits are not saved yet", [
      { label: "Scoring model", description: draft.endpoint && draft.deployment ? `${draft.deployment} · ${draft.endpoint}` : "Not configured; choose an existing Azure deployment or enter it manually." },
      { label: "Advisor model", description: draft.reviewModel },
      { label: "Azure credentials", description: draft.credentialMode === "azure-cli" ? "Azure CLI identity (az login)" : "DefaultAzureCredential" },
      { label: "Pass threshold", description: `${draft.passThreshold} · lower means fewer reviews; higher is stricter (0.5–1).` },
      { label: "Scoring timeout", description: `${draft.timeoutMs} ms (100–20000).` },
      { label: "Automatic advisor timeout", description: `${draft.advisorTimeoutMs} ms (100–20000).` },
      { label: "Save", description: "Persist preferences in the active OMP profile; Azure credentials are never saved." },
      { label: "Cancel", description: "Discard this draft without changing preferences." },
    ]);
    if (choice === undefined || choice === "Cancel") return undefined;
    try {
      if (choice === "Scoring model") {
        const next = await selectScoringProvider(ctx, draft);
        if (next) draft = next;
      } else if (choice === "Advisor model") {
        const reviewModel = await selectAdvisorModel(ctx, draft.reviewModel);
        if (reviewModel !== undefined) draft = normalizeDecisionSettings({ ...draft, reviewModel });
      } else if (choice === "Azure credentials") {
        const mode = await ctx.ui.select("Azure credential mode", [
          { label: "Azure CLI identity", description: "Use the signed-in az login identity (recommended); no custom environment settings." },
          { label: "DefaultAzureCredential", description: "Use Azure SDK credential discovery, such as managed identity or development credentials." },
        ]);
        if (mode !== undefined) draft = { ...draft, credentialMode: mode === "Azure CLI identity" ? "azure-cli" : "default" };
      } else if (choice === "Pass threshold" || choice === "Scoring timeout" || choice === "Automatic advisor timeout") {
        const key = choice === "Pass threshold" ? "passThreshold" : choice === "Scoring timeout" ? "timeoutMs" : "advisorTimeoutMs";
        const title = choice === "Pass threshold" ? "Pass threshold (0.5–1; lower means fewer reviews, higher is stricter)" : `${choice} in milliseconds (100–20000)`;
        const value = await ctx.ui.input(title, String(draft[key]));
        if (value !== undefined) {
          if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) throw new Error("Enter a decimal number without units.");
          draft = normalizeDecisionSettings({ ...draft, [key]: Number(value.trim()) });
        }
      } else if (choice === "Save") {
        const validated = normalizeDecisionSettings({ ...draft });
        if (validated.endpoint || validated.deployment) toDecisionOptions(validated);
        const confirmed = await ctx.ui.confirm("Save Decision advisor preferences?", "Save to the active OMP profile's plugin settings. Project overrides may take precedence; effective preferences will be reloaded. No Azure credentials will be stored.");
        if (!confirmed) continue;
        const effective = await saveDecisionSettings(ctx.cwd, validated);
        const shadowed = (Object.keys(validated) as Array<keyof DecisionSettings>).filter(key => effective[key] !== validated[key]);
        ctx.ui.notify(shadowed.length
          ? `Profile preferences saved, but project overrides take precedence for: ${shadowed.join(", ")}. The effective preferences have been reloaded.`
          : "Decision advisor preferences saved to the active OMP profile.", shadowed.length ? "warning" : "info");
        return effective;
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Decision advisor preferences could not be updated.", "error");
    }
  }
}
