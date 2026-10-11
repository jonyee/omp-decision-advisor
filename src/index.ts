import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSecretObfuscator, type SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AzureDecisionClient, CurrentEvidenceOverflowError, DecisionError, MAX_EVIDENCE_TOKENS, packEvidence } from "./decision.ts";
import { toDecisionOptions, type DecisionSettings } from "./config.ts";
import { buildEvidence } from "./evidence.ts";
import { countEvidenceTokens } from "./evidence-tokens.ts";

const evidenceBudget = { count: countEvidenceTokens, max: MAX_EVIDENCE_TOKENS, unit: "tokens" as const };
import { reviewTurn } from "./review.ts";
import { ReviewerConfigurationError, ReviewerError, waitForReviews, type ReviewerErrorCode } from "./review-lifecycle.ts";
import { criterionIds, type DecisionReport, type ReviewResult, type TurnEvidence } from "./types.ts";
import { loadDecisionSettings, saveDecisionSettings } from "./settings.ts";
import { configureDecision } from "./settings-ui.ts";
import { showDecisionStatus } from "./status-ui.ts";
import { ReviewHistory } from "./review-history.ts";

interface ReviewedTurn {
  evidence: TurnEvidence;
  report?: DecisionReport;
  turn: number;
  settings?: DecisionSettings;
  review?: Promise<void>;
  result?: ReviewResult;
  error?: { category: ReviewerErrorCode; detail: string };
}

function formatReport(report: DecisionReport, verbose = false): string {
  const rows = criterionIds.map(id => {
    const result = report.criteria[id];
    return `| ${id} | ${result.choice} | ${(result.probabilities.pass * 100).toFixed(1)}% |`;
  });
  return [`### Decision feedback — turn ${report.turn}`, "| Criterion | Verdict | P(pass) |", "|---|---|---:|", ...rows,
    report.flagged.length ? "Failed triage check. The escalation reviewer checks this turn automatically." : "All criteria passed the configured threshold.",
    ...(verbose ? ["```json", JSON.stringify(report, null, 2), "```"] : []),
    "Scores classify supplied evidence; they are not explanations or proof of correctness."].join("\n");
}

export default function decisionAdvisor(pi: ExtensionAPI, options: { reviewWaitMs?: number } = {}) {
  let controller = new AbortController();
  let obfuscator: SecretObfuscator | undefined;
  let client: AzureDecisionClient | undefined;
  let configurationError: string | undefined;
  let configuration: DecisionSettings | undefined;
  let last: ReviewedTurn | undefined;
  const scoring = new Set<Promise<void>>();
  const reviews = new Set<Promise<void>>();
  const finalized = new Set<Promise<void>>();
  const finishTurns: Array<() => void> = [];
  const reviewHistory = new ReviewHistory();
  let turn = 0;

  const reset = () => {
    controller.abort();
    controller = new AbortController();
    last = undefined;
    scoring.clear();
    reviews.clear();
    for (const finish of finishTurns.splice(0)) finish();
    finalized.clear();
    reviewHistory.clear();
    turn = 0;
  };
  const applySettings = (settings: DecisionSettings) => {
    reset();
    configuration = settings;
    client = undefined;
    configurationError = undefined;
    try {
      client = new AzureDecisionClient(toDecisionOptions(settings), { evidenceBudget });
    } catch { configurationError = "Decision scoring is not configured. Run /decision to choose the deployment."; }
  };
  const showFeedback = (text: string, ctx: ExtensionContext, record: object) => {
    if (ctx.mode === "print") console.log(text);
    else if (ctx.mode === "json") console.log(JSON.stringify(record));
    else pi.sendMessage({ customType: "decision-feedback", content: text, display: true, attribution: "agent" }, { triggerTurn: false });
  };
  const displayReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean) => {
    const result = captured.result;
    if (!result) return;
    const notes = result.findings.map(finding => ({
      advisor: "Decision reviewer",
      severity: finding.severity,
      turn: captured.turn,
      note: `${finding.explanation}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`,
    }));
    pi.sendMessage({
      customType: "advisor",
      content: notes.map(note => note.note).join("\n\n"),
      display: true,
      attribution: "agent",
      details: { notes, ...(!notes.length && result.verdict !== "revise" ? { status: result.verdict } : {}) },
    }, { triggerTurn: false });
    if (captured.settings?.verbose) {
      const text = `### Escalation review — turn ${captured.turn}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
      showFeedback(text, ctx, { type: "decision_review", turn: captured.turn, automatic, review: result });
    }
  };

  const startReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean): Promise<void> => {
    if (captured.review) return captured.review;
    const generation = controller.signal;
    const job = (async () => {
      try {
        const settings = captured.settings;
        if (!settings) throw new ReviewerConfigurationError("Decision settings are unavailable. Reload the extension or configure /decision settings.");
        if (settings.verbose) {
          const text = `Advisor requested for turn ${captured.turn}; waiting for findings.`;
          showFeedback(text, ctx, { type: "decision_review_requested", turn: captured.turn, automatic });
        }
        const result = await reviewTurn(ctx, captured.evidence, captured.report, generation, {
          model: settings.reviewModel,
          timeoutMs: settings.advisorTimeoutMs,
          tools: settings.reviewTools,
          instructions: settings.reviewInstructions,
          history: reviewHistory.snapshot(captured.turn, settings.reviewHistoryTurns),
        });
        if (generation.aborted) return;
        captured.result = result;
        reviewHistory.record({ turn: captured.turn, userRequest: captured.evidence.userRequest, result }, settings.reviewHistoryTurns);
        pi.appendEntry("decision-review", { turn: captured.turn, automatic, ...result });
        displayReview(captured, ctx, automatic);
      } catch (error) {
        if (generation.aborted) return;
        const failure = error instanceof ReviewerError ? error : new ReviewerError("provider");
        const detail = failure.message;
        captured.error = { category: failure.code, detail };
        const text = `### Escalation review failed — turn ${captured.turn}\nCategory: **${failure.code}**. No reviewer findings were applied. ${detail}`;
        pi.appendEntry("decision-review-error", { turn: captured.turn, automatic, category: failure.code, detail });
        showFeedback(text, ctx, { type: "decision_review_error", turn: captured.turn, automatic, category: failure.code, detail });
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
    let enabled = true;
    try {
      obfuscator = await buildSecretObfuscator(ctx.cwd, getAgentDir());
      const settings = await loadDecisionSettings(ctx.cwd);
      enabled = settings.enabled;
      applySettings(settings);
    } catch { configurationError = "Decision settings could not be loaded. Open /decision to configure them."; }
    if (configurationError && enabled) ctx.ui.notify(configurationError, "warning");
  };
  pi.setLabel("Decision advisor");
  pi.on("session_start", (_event, ctx) => initializeSettings(ctx));
  pi.on("session_switch", (_event, ctx) => initializeSettings(ctx));
  pi.on("session_branch", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  pi.on("context", event => ({ messages: event.messages.filter(message => !(message.role === "custom" && message.customType === "decision-feedback")) }));
  pi.on("assistant_message", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !configuration?.enabled) return;
    // This hook is awaited before dispatch; turn_end observers may arrive after session_stop.
    const ticket = new Promise<void>(resolve => finishTurns.push(resolve));
    finalized.add(ticket);
    void ticket.then(() => finalized.delete(ticket));
  });
  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent.kind === "main") await Promise.allSettled([...finalized, ...scoring]);
  });
  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent.kind === "main") await waitForReviews(reviews, controller.signal, options.reviewWaitMs);
  });
  pi.on("turn_end", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !configuration?.enabled) return;
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
      let failure: { reason: string; detail?: string } | undefined;
      try {
        captured.evidence = packEvidence(captured.evidence, evidenceBudget).evidence;
        if (!client) throw new Error(configurationError ?? "Decision client is not configured.");
        const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        report = await client.evaluate(captured.evidence, currentTurn, boundedSignal);
        if (signal.aborted) return;
        captured.report = report;
        if (currentTurn === turn) last = captured;
        pi.appendEntry("decision-report", report);
        if (!report.flagged.length) {
          if (captured.settings?.verbose) showFeedback(formatReport(report, true), ctx,
            { type: "decision_feedback", turn: currentTurn, report, status: "evaluated" });
          return;
        }
        text = formatReport(report, captured.settings?.verbose);
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof DecisionError ? error.code : "configuration";
        const detail = error instanceof CurrentEvidenceOverflowError ? error.message : undefined;
        failure = { reason, ...(detail ? { detail } : {}) };
        text = `### Decision feedback — turn ${currentTurn}\nStatus: **not evaluated** (${reason}). No pass was recorded.${detail ? ` ${detail}` : ""} The escalation reviewer checks this turn without a decision score.`;
        pi.appendEntry("decision-error", { turn: currentTurn, status: "not_evaluated", ...failure });
      }
      showFeedback(text, ctx, { type: "decision_feedback", turn: currentTurn, report: report ?? null, status: report ? "evaluated" : "not_evaluated", ...failure });
      void startReview(captured, ctx, true);
    })();
    scoring.add(job);
    void job.finally(() => { scoring.delete(job); finishTurn?.(); }).catch(() => {});
    return job;
  });
  pi.registerCommand("decision", {
    description: "Decision controls: on, off, status, settings, review, or verbose [on|off]",
    handler: async (args, ctx) => {
      let action = args.trim();
      if (!action) {
        if (ctx.mode !== "tui" && ctx.mode !== "rpc") { ctx.ui.notify("Use /decision on, off, status, settings, review or verbose [on|off].", "warning"); return; }
        const choice = await ctx.ui.select(`Decision advisor — automatic review ${configuration?.enabled ? "on" : "off"}`, [
          { label: "on", description: "Enable automatic turn scoring and failure review; save to this OMP profile." },
          { label: "off", description: "Disable automatic scoring and escalation reviews; explicit status smoke remains available." },
          { label: "status", description: "Show configuration and stored scores, and run one Decision-model smoke request." },
          { label: "settings", description: "Choose deployment, escalation-reviewer model, tools, instructions, history and triage tuning." },
        ]);
        if (!choice) return;
        action = choice;
      }
      if (action === "verbose" || action === "verbose on" || action === "verbose off") {
        const current = configuration ?? await loadDecisionSettings(ctx.cwd);
        const verbose = action === "verbose" ? !current.verbose : action === "verbose on";
        const saved = await saveDecisionSettings(ctx.cwd, { ...current, verbose });
        applySettings(saved);
        ctx.ui.notify(`Decision verbose output is ${saved.verbose ? "on" : "off"}.${saved.verbose !== verbose ? " A project override takes precedence." : ""}`, "info");
        return;
      }
      if (action === "on" || action === "off") {
        const current = configuration ?? await loadDecisionSettings(ctx.cwd);
        const requested = action === "on";
        const saved = await saveDecisionSettings(ctx.cwd, { ...current, enabled: requested });
        applySettings(saved);
        const message = `Automatic Decision review is ${saved.enabled ? "on" : "off"}.${saved.enabled !== requested ? " A project override takes precedence." : ""}${saved.enabled && configurationError ? " Choose a scoring model in /decision settings." : ""}`;
        if (ctx.mode === "print" || ctx.mode === "json") console.log(JSON.stringify({ type: "decision_enabled", enabled: saved.enabled }));
        else ctx.ui.notify(message, saved.enabled !== requested || (saved.enabled && configurationError) ? "warning" : "info");
        return;
      }
      if (action === "settings") {
        const saved = await configureDecision(ctx);
        if (saved) applySettings(saved);
        return;
      }
      if (action === "status") {
        await showDecisionStatus(ctx, configuration ?? await loadDecisionSettings(ctx.cwd), last, controller.signal);
        return;
      }
      if (action !== "review") { ctx.ui.notify("Use /decision on, off, status, settings or review.", "warning"); return; }
      if (!last) { ctx.ui.notify("No turn evidence captured in this session yet.", "warning"); return; }
      const captured = last;
      const generation = controller.signal;
      const existing = captured.review !== undefined;
      await waitForReviews([captured.review ?? startReview(captured, ctx, false)], generation, options.reviewWaitMs);
      if (generation.aborted) return;
      if (captured.result) {
        if (existing) displayReview(captured, ctx, false);
      } else if (captured.error) {
        ctx.ui.notify(`Review ${captured.error.category}: ${captured.error.detail}`, "warning");
      } else {
        ctx.ui.notify("The escalation review is still running. Its findings will appear when it completes; no primary turn will be triggered.", "info");
      }
    },
  });
}
