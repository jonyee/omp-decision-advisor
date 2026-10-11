import { Container, Text } from "@oh-my-pi/pi-tui";
import { getAgentDir, getMarkdownTheme, Markdown, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSecretObfuscator, type SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AzureDecisionClient, DecisionError } from "./decision.ts";
import { toDecisionOptions, type DecisionSettings } from "./config.ts";
import { buildEvidence } from "./evidence.ts";
import { reviewTurn, ReviewerConfigurationError } from "./review.ts";
import { criterionIds, type DecisionReport, type ReviewResult, type TurnEvidence } from "./types.ts";
import { loadDecisionSettings, saveDecisionSettings } from "./settings.ts";
import { configureDecision } from "./settings-ui.ts";
import { showDecisionStatus } from "./status-ui.ts";
import { ReviewHistory } from "./review-history.ts";
import { reviewDisplay } from "./review-display.ts";
import { feedbackWidget, feedbackPreview } from "./feedback-widget.ts";

interface ReviewedTurn {
  evidence: TurnEvidence;
  report?: DecisionReport;
  turn: number;
  settings?: DecisionSettings;
  feedback?: string;
  review?: Promise<void>;
  result?: ReviewResult;
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

export default function decisionAdvisor(pi: ExtensionAPI) {
  let controller = new AbortController();
  let obfuscator: SecretObfuscator | undefined;
  let client: AzureDecisionClient | undefined;
  let configurationError: string | undefined;
  let configuration: DecisionSettings | undefined;
  let last: ReviewedTurn | undefined;
  const pending = new Map<number, string>();
  const reviewCards = new Map<number, ReviewResult>();
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
    pending.clear();
    reviewCards.clear();
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
      client = new AzureDecisionClient(toDecisionOptions(settings));
    } catch { configurationError = "Decision scoring is not configured. Run /decision to choose the deployment."; }
  };
  const showFailure = (captured: ReviewedTurn, text: string, ctx: ExtensionContext, record: object, severity: "info" | "warning" = "warning") => {
    captured.feedback = text;
    pending.set(captured.turn, text);
    if (ctx.mode === "tui") {
      const content = [...pending].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n\n");
      ctx.ui.setWidget("decision-feedback", feedbackWidget(ctx.ui, () => new Markdown(content, 0, 0, getMarkdownTheme())));
    }
    else if (ctx.mode === "json") console.log(JSON.stringify(record));
    else if (ctx.mode === "print") console.log(text);
    else ctx.ui.notify(text, severity);
  };
  const displayReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean) => {
    const result = captured.result;
    if (!result) return;
    if (captured.settings?.verbose) {
      const prefix = captured.report ? formatReport(captured.report, true) : "Decision scoring was not evaluated.";
      const text = `${prefix}\n\n### Escalation review — turn ${captured.turn}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
      if (ctx.mode === "print") { captured.feedback = text; pending.set(captured.turn, text); console.log(text); }
      else showFailure(captured, text, ctx, { type: "decision_review", turn: captured.turn, automatic, review: result }, result.verdict === "accept" ? "info" : "warning");
      return;
    }
    const display = reviewDisplay(result);
    captured.feedback = display.text;
    pending.set(captured.turn, display.text);
    reviewCards.set(captured.turn, result);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("decision-feedback", feedbackWidget(ctx.ui, (_tui, theme) => display.component(theme)));
    }
    else if (ctx.mode === "print") console.log(display.text);
    else if (ctx.mode === "json") console.log(JSON.stringify(result.verdict === "accept"
      ? { type: "decision_review", turn: captured.turn, automatic, verdict: "accept", note: display.text }
      : { type: "decision_review", turn: captured.turn, automatic, review: result }));
    else ctx.ui.notify(display.text, result.verdict === "accept" ? "info" : "warning");
  };

  const startReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean): Promise<void> => {
    if (captured.review) return captured.review;
    const generation = controller.signal;
    const job = (async () => {
      try {
        const settings = captured.settings;
        if (!settings) throw new Error("Decision settings are unavailable.");
        const signal = AbortSignal.any([generation, AbortSignal.timeout(settings.advisorTimeoutMs)]);
        if (settings.verbose) {
          const text = `${captured.feedback ?? ""}\n\nAdvisor requested for turn ${captured.turn}; waiting for findings.`.trim();
          if (ctx.mode === "print") console.log(`Advisor requested for turn ${captured.turn}; waiting for findings.`);
          else showFailure(captured, text, ctx, { type: "decision_review_requested", turn: captured.turn, automatic }, "info");
        }
        const result = await reviewTurn(ctx, captured.evidence, captured.report, signal, {
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
        if (result.findings.length) pi.sendMessage({ customType: "decision-advice", content: JSON.stringify({ turn: captured.turn, findings: result.findings }), display: false }, { deliverAs: "nextTurn", triggerTurn: false });
      } catch (error) {
        if (generation.aborted) return;
        const detail = error instanceof ReviewerConfigurationError ? error.message : "Check the reviewer model, its OMP credentials and review timeout in /decision settings.";
        const text = `### Escalation review failed — turn ${captured.turn}\nNo reviewer findings were applied. ${detail}`;
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
  pi.registerMessageRenderer<{ entries: Array<{ text: string; result?: ReviewResult }> }>("decision-feedback", (message, options, theme) => {
    const component = new Container();
    const entries = message.details?.entries ?? [{ text: String(message.content) }];
    for (const [index, entry] of entries.entries()) {
      if (index) component.addChild(new Text("", 0, 1));
      component.addChild(entry.result ? reviewDisplay(entry.result).component(theme) : new Markdown(entry.text, 0, 0, getMarkdownTheme()));
    }
    return { render: width => feedbackPreview(component.render(width), width, theme, options.expanded), invalidate: () => component.invalidate() };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !pending.size) return;
    const entries = [...pending].sort(([a], [b]) => a - b).map(([turn, text]) => ({ text, result: reviewCards.get(turn) }));
    return { message: { customType: "decision-feedback", content: entries.map(entry => entry.text).join("\n\n"), details: { entries }, display: true } };
  });
  pi.on("session_branch", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  pi.on("context", event => ({ messages: event.messages.filter(message => !(message.role === "custom" && message.customType === "decision-feedback")) }));
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    pending.clear();
    reviewCards.clear();
    if (ctx.mode === "tui") ctx.ui.setWidget("decision-feedback", undefined);
  });
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
    if (ctx.agent.kind === "main") await Promise.allSettled([...reviews]);
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
      try {
        if (!client) throw new Error(configurationError ?? "Decision client is not configured.");
        const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        report = await client.evaluate(evidence, currentTurn, boundedSignal);
        if (signal.aborted) return;
        captured.report = report;
        if (currentTurn === turn) last = captured;
        pi.appendEntry("decision-report", report);
        if (!report.flagged.length) {
          if (captured.settings?.verbose) {
            const text = formatReport(report, true);
            if (ctx.mode === "print") { captured.feedback = text; pending.set(currentTurn, text); console.log(text); }
            else showFailure(captured, text, ctx, { type: "decision_feedback", turn: currentTurn, report, status: "evaluated" }, "info");
          }
          return;
        }
        text = formatReport(report, captured.settings?.verbose);
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof DecisionError ? error.code : "configuration";
        text = `### Decision feedback — turn ${currentTurn}\nStatus: **not evaluated** (${reason}). No pass was recorded. The escalation reviewer checks this turn without a decision score.`;
        pi.appendEntry("decision-error", { turn: currentTurn, status: "not_evaluated" });
      }
      showFailure(captured, text, ctx, { type: "decision_feedback", turn: currentTurn, report: report ?? null, status: report ? "evaluated" : "not_evaluated" });
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
      if (captured.review) {
        await captured.review;
        if (captured.result) displayReview(captured, ctx, false);
        else ctx.ui.notify("The escalation review did not complete. Inspect reviewer settings in /decision settings.", "warning");
      } else await startReview(captured, ctx, false);
    },
  });
}
