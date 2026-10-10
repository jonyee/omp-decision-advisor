import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { getAgentDir, getMarkdownTheme, Markdown, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildSecretObfuscator, type SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AzureDecisionClient, DecisionError } from "./decision.ts";
import { readDecisionOptions } from "./config.ts";
import { buildEvidence } from "./evidence.ts";
import { reviewTurn } from "./review.ts";
import { criterionIds, type DecisionReport, type TurnEvidence } from "./types.ts";

function formatReport(report: DecisionReport): string {
  const rows = criterionIds.map(id => {
    const result = report.criteria[id];
    return `| ${id} | ${result.choice} | ${(result.probabilities.pass * 100).toFixed(1)}% |`;
  });
  return [`### Decision feedback — turn ${report.turn}`, "| Criterion | Verdict | P(pass) |", "|---|---|---:|", ...rows,
    report.flagged.length ? "Flagged or uncertain. Use `/decision review` for a larger-model investigation." : "All criteria passed the configured threshold.",
    "Scores classify supplied evidence; they are not explanations or proof of correctness."].join("\n");
}

export default function decisionAdvisor(pi: ExtensionAPI) {
  let controller = new AbortController();
  let obfuscator: SecretObfuscator | undefined;
  let client: AzureDecisionClient | undefined;
  let configurationError: string | undefined;
  let last: { evidence: TurnEvidence; report?: DecisionReport; turn: number } | undefined;
  const pending = new Map<number, string>();
  const scoring = new Set<Promise<void>>();
  const finalized = new Set<Promise<void>>();
  const finishTurns: Array<() => void> = [];
  let turn = 0;
  let reviewing = false;

  const reset = () => {
    controller.abort();
    controller = new AbortController();
    last = undefined;
    pending.clear();
    scoring.clear();
    for (const finish of finishTurns.splice(0)) finish();
    finalized.clear();
    turn = 0;
  };
  pi.setLabel("Decision advisor");
  pi.registerMessageRenderer("decision-feedback", message => new Markdown(String(message.content), 0, 0, getMarkdownTheme()));
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    reset();
    obfuscator = await buildSecretObfuscator(ctx.cwd, getAgentDir());
    try {
      client = new AzureDecisionClient(readDecisionOptions(process.env), { evidenceFits: state => countTokens(state, Encoding.Qwen3) <= 24_000 });
    }
    catch { configurationError = "Set DECISION_ENDPOINT and DECISION_DEPLOYMENT; authenticate with az login. See the repository README."; }
    if (configurationError) ctx.ui.notify(configurationError, "warning");
  });
  pi.on("session_switch", reset);
  pi.on("session_branch", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  pi.on("context", event => ({ messages: event.messages.filter(message => !(message.role === "custom" && message.customType === "decision-feedback")) }));
  pi.on("assistant_message", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    // This hook is awaited before dispatch; turn_end observers may arrive after session_stop.
    const ticket = new Promise<void>(resolve => finishTurns.push(resolve));
    finalized.add(ticket);
    void ticket.then(() => finalized.delete(ticket));
  });
  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent.kind === "main") await Promise.allSettled([...finalized, ...scoring]);
  });
  pi.on("turn_end", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const finishTurn = finishTurns.shift();
    const signal = controller.signal;
    const currentTurn = ++turn;
    const history = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
    const raw = buildEvidence(ctx.getSystemPrompt(), history, event.message, event.toolResults);
    const job = (async () => {
      obfuscator ??= await buildSecretObfuscator(ctx.cwd, getAgentDir());
      const evidence = obfuscator ? obfuscator.obfuscateObject(raw) : raw;
      if (currentTurn === turn && !signal.aborted) last = { evidence, turn: currentTurn };
      let text: string;
      let report: DecisionReport | undefined;
      try {
        if (!client) throw new Error(configurationError ?? "Decision client is not configured.");
        const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        report = await client.evaluate(evidence, currentTurn, boundedSignal);
        if (signal.aborted) return;
        if (currentTurn === turn) last = { evidence, report, turn: currentTurn };
        pi.appendEntry("decision-report", report);
        text = formatReport(report);
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof DecisionError ? error.code : "configuration";
        text = `### Decision feedback — turn ${currentTurn}\nStatus: **not evaluated** (${reason}). No pass was recorded. Check configuration, Azure access, evidence size and service availability. Use \`/decision review\` to investigate with a larger model.`;
        pi.appendEntry("decision-error", { turn: currentTurn, status: "not_evaluated" });
      }
      pending.set(currentTurn, text);
      if (ctx.mode === "tui" && currentTurn === turn) ctx.ui.setWidget("decision-feedback", text.split("\n"));
      else if (ctx.mode === "json" || ctx.mode === "print") console.log(JSON.stringify({ type: "decision_feedback", turn: currentTurn, report: report ?? null, status: report ? "evaluated" : "not_evaluated" }));
      else if (ctx.mode !== "tui") ctx.ui.notify(text, !report || report.flagged.length ? "warning" : "info");
    })();
    scoring.add(job);
    void job.finally(() => { scoring.delete(job); finishTurn?.(); }).catch(() => {});
    return job;
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const signal = controller.signal;
    // OMP emits turn observers concurrently; drain all of this run's bounded scoring first.
    await Promise.allSettled([...scoring]);
    if (signal.aborted || !pending.size) return;
    const content = [...pending].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n\n");
    pending.clear();
    // Headless output already emitted each report. A card queued during unwind can start a hidden turn.
    if (ctx.mode === "print" || ctx.mode === "json") return;
    if (ctx.mode === "tui") ctx.ui.setWidget("decision-feedback", undefined);
    pi.sendMessage({ customType: "decision-feedback", content, display: true }, { triggerTurn: false });
  });
  pi.registerCommand("decision", {
    description: "Show the latest scores, or /decision review to investigate with the larger model",
    handler: async (args, ctx) => {
      if (!last) { ctx.ui.notify("No turn evidence captured in this session yet.", "warning"); return; }
      if (args.trim() !== "review") {
        pi.sendMessage({ customType: "decision-feedback", content: last.report ? formatReport(last.report) : "Latest turn was not evaluated. Use `/decision review`.", display: true }, { triggerTurn: false });
        return;
      }
      if (reviewing) { ctx.ui.notify("A decision review is already running.", "warning"); return; }
      reviewing = true;
      const captured = last;
      const signal = controller.signal;
      try {
        const result = await reviewTurn(ctx, captured.evidence, captured.report, signal);
        if (signal.aborted) return;
        const content = `### Larger-model review — turn ${captured.turn}\n${JSON.stringify(result, null, 2)}\nReview findings are advisory; continue the primary when you want it to act.`;
        pi.appendEntry("decision-review", { turn: captured.turn, ...result });
        pi.sendMessage({ customType: "decision-feedback", content, display: true }, { triggerTurn: false });
        if (result.findings.length) pi.sendMessage({ customType: "decision-advice", content: JSON.stringify({ turn: captured.turn, findings: result.findings }), display: false }, { deliverAs: "nextTurn", triggerTurn: false });
      } catch {
        if (!signal.aborted) ctx.ui.notify("Larger-model review failed; no advice was applied. Check DECISION_REVIEW_MODEL and its OMP credentials.", "error");
      } finally { reviewing = false; }
    },
  });
}
