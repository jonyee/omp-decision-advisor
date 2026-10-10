import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { getAgentDir, getMarkdownTheme, Markdown, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSecretObfuscator, type SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AzureDecisionClient, DecisionError } from "./decision.ts";
import { toDecisionOptions, type DecisionSettings } from "./config.ts";
import { buildEvidence } from "./evidence.ts";
import { reviewTurn } from "./review.ts";
import { criterionIds, type DecisionReport, type ReviewResult, type TurnEvidence } from "./types.ts";
import { loadDecisionSettings } from "./settings.ts";
import { configureDecision } from "./settings-ui.ts";

interface ReviewedTurn {
  evidence: TurnEvidence;
  report?: DecisionReport;
  turn: number;
  settings?: DecisionSettings;
  feedback?: string;
  review?: Promise<void>;
  result?: ReviewResult;
}

function formatReport(report: DecisionReport): string {
  const rows = criterionIds.map(id => {
    const result = report.criteria[id];
    return `| ${id} | ${result.choice} | ${(result.probabilities.pass * 100).toFixed(1)}% |`;
  });
  return [`### Decision feedback — turn ${report.turn}`, "| Criterion | Verdict | P(pass) |", "|---|---|---:|", ...rows,
    report.flagged.length ? "Failed triage check. The advisor reviews this turn automatically." : "All criteria passed the configured threshold.",
    "Scores classify supplied evidence; they are not explanations or proof of correctness."].join("\n");
}

export default function decisionAdvisor(pi: ExtensionAPI) {
  let controller = new AbortController();
  let obfuscator: SecretObfuscator | undefined;
  let client: AzureDecisionClient | undefined;
  let configurationError: string | undefined;
  let configuration: DecisionSettings | undefined;
  let last: ReviewedTurn | undefined;
  const pending = new Map<number, string>();
  const scoring = new Set<Promise<void>>();
  const reviews = new Set<Promise<void>>();
  const finalized = new Set<Promise<void>>();
  const finishTurns: Array<() => void> = [];
  let turn = 0;

  const reset = () => {
    controller.abort();
    controller = new AbortController();
    last = undefined;
    pending.clear();
    scoring.clear();
    reviews.clear();
    for (const finish of finishTurns.splice(0)) finish();
    finalized.clear();
    turn = 0;
  };
  const applySettings = (settings: DecisionSettings) => {
    reset();
    configuration = settings;
    client = undefined;
    configurationError = undefined;
    try {
      client = new AzureDecisionClient(toDecisionOptions(settings), { evidenceFits: state => countTokens(state, Encoding.Qwen3) <= 24_000 });
    } catch { configurationError = "Decision scoring is not configured. Run /decision to choose the deployment."; }
  };
  const showFailure = (captured: ReviewedTurn, text: string, ctx: ExtensionContext, record: object) => {
    captured.feedback = text;
    pending.set(captured.turn, text);
    if (ctx.mode === "tui" && captured.turn === turn) ctx.ui.setWidget("decision-feedback", text.split("\n"));
    else if (ctx.mode === "json" || ctx.mode === "print") console.log(JSON.stringify(record));
    else if (ctx.mode !== "tui") ctx.ui.notify(text, "warning");
  };

  const startReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean): Promise<void> => {
    if (captured.review) return captured.review;
    const generation = controller.signal;
    const job = (async () => {
      try {
        const settings = captured.settings;
        if (!settings) throw new Error("Decision settings are unavailable.");
        const signal = AbortSignal.any([generation, AbortSignal.timeout(settings.advisorTimeoutMs)]);
        const result = await reviewTurn(ctx, captured.evidence, captured.report, signal, { model: settings.reviewModel, timeoutMs: settings.advisorTimeoutMs });
        if (generation.aborted) return;
        captured.result = result;
        pi.appendEntry("decision-review", { turn: captured.turn, automatic, ...result });
        const reviewText = `### Advisor review — turn ${captured.turn}\n${JSON.stringify(result, null, 2)}\nFindings are advisory; the primary acts on them when you continue.`;
        if (automatic) {
          showFailure(captured, `${captured.feedback ?? ""}\n\n${reviewText}`.trim(), ctx,
            { type: "decision_review", turn: captured.turn, automatic, review: result });
        } else {
          pi.sendMessage({ customType: "decision-feedback", content: reviewText, display: true }, { triggerTurn: false });
        }
        if (result.findings.length) pi.sendMessage({ customType: "decision-advice", content: JSON.stringify({ turn: captured.turn, findings: result.findings }), display: false }, { deliverAs: "nextTurn", triggerTurn: false });
      } catch {
        if (generation.aborted) return;
        const text = `### Advisor review failed — turn ${captured.turn}\nNo advisor findings were applied. Check the advisor model, its OMP credentials and review timeout in /decision.`;
        pi.appendEntry("decision-review-error", { turn: captured.turn, automatic });
        if (automatic) showFailure(captured, `${captured.feedback ?? ""}\n\n${text}`.trim(), ctx,
          { type: "decision_review_error", turn: captured.turn, automatic });
        else ctx.ui.notify(text, "error");
      }
    })();
    captured.review = job;
    reviews.add(job);
    void job.finally(() => reviews.delete(job)).catch(() => {});
    return job;
  };
  const initializeSettings = async (ctx: ExtensionContext) => {
    if (ctx.agent.kind !== "main") return;
    reset();
    configuration = undefined;
    client = undefined;
    configurationError = undefined;
    try {
      obfuscator = await buildSecretObfuscator(ctx.cwd, getAgentDir());
      applySettings(await loadDecisionSettings(ctx.cwd));
    } catch { configurationError = "Decision settings could not be loaded. Open /decision to configure them."; }
    if (configurationError) ctx.ui.notify(configurationError, "warning");
  };
  pi.setLabel("Decision advisor");
  pi.registerMessageRenderer("decision-feedback", message => new Markdown(String(message.content), 0, 0, getMarkdownTheme()));
  pi.on("session_start", (_event, ctx) => initializeSettings(ctx));
  pi.on("session_switch", (_event, ctx) => initializeSettings(ctx));
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
  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent.kind === "main") await Promise.allSettled([...reviews]);
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
      const captured: ReviewedTurn = { evidence, turn: currentTurn, settings: configuration };
      if (currentTurn === turn && !signal.aborted) last = captured;
      let text: string;
      let report: DecisionReport | undefined;
      try {
        if (!client) throw new Error(configurationError ?? "Decision client is not configured.");
        const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        report = await client.evaluate(evidence, currentTurn, boundedSignal);
        if (signal.aborted) return;
        captured.report = report;
        if (currentTurn === turn) last = captured;
        pi.appendEntry("decision-report", report);
        if (!report.flagged.length) return;
        text = formatReport(report);
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof DecisionError ? error.code : "configuration";
        text = `### Decision feedback — turn ${currentTurn}\nStatus: **not evaluated** (${reason}). No pass was recorded. The advisor reviews this turn without a decision score.`;
        pi.appendEntry("decision-error", { turn: currentTurn, status: "not_evaluated" });
      }
      showFailure(captured, text, ctx, { type: "decision_feedback", turn: currentTurn, report: report ?? null, status: report ? "evaluated" : "not_evaluated" });
      void startReview(captured, ctx, true);
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
    description: "Configure decision scoring and advisor review; /decision status shows stored scores",
    handler: async (args, ctx) => {
      if (!args.trim() || args.trim() === "configure") {
        const saved = await configureDecision(ctx);
        if (saved) applySettings(saved);
        return;
      }
      if (!last) { ctx.ui.notify("No turn evidence captured in this session yet.", "warning"); return; }
      if (args.trim() === "status") {
        pi.sendMessage({ customType: "decision-feedback", content: last.report ? formatReport(last.report) : "Latest turn was not evaluated; an automatic advisor review was requested.", display: true }, { triggerTurn: false });
        return;
      }
      if (args.trim() !== "review") { ctx.ui.notify("Use /decision, /decision status or /decision review.", "warning"); return; }
      const captured = last;
      if (captured.review) {
        await captured.review;
        if (captured.result) pi.sendMessage({ customType: "decision-feedback", content: `### Advisor review — turn ${captured.turn}\n${JSON.stringify(captured.result, null, 2)}`, display: true }, { triggerTurn: false });
      } else await startReview(captured, ctx, false);
    },
  });
}
