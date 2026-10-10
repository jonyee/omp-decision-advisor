import { Text, type Component } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { ReviewResult } from "./types.ts";

/** Presentation only: do not route cards through native advisor scheduling or primary queues. */
export function reviewDisplay(result: ReviewResult): { text: string; component: (theme: Theme) => Component } {
  if (result.verdict === "accept") {
    const text = "The advisor was requested but had no findings.";
    return { text, component: () => new Text(text, 0, 0) };
  }
  if (!result.findings.length) {
    const text = "The advisor was requested but could not determine whether a correction is needed.";
    return { text, component: () => new Text(text, 0, 0) };
  }
  const notes = result.findings.map(finding => ({
    severity: finding.severity,
    advisor: "Decision reviewer",
    note: `${finding.explanation}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`,
  }));
  const text = [`Advisor — ${notes.length} ${notes.length === 1 ? "note" : "notes"}`,
    ...notes.map(note => `[${note.severity.toUpperCase()}] [${note.advisor}] ${note.note}`),
  ].join("\n\n");
  return { text, component: theme => {
    const blockers = notes.filter(note => note.severity === "blocker").length;
    const header = new Text(`${theme.fg("customMessageLabel", theme.bold(`${theme.status.info} Advisor`))} ${theme.fg("dim", `${notes.length} ${notes.length === 1 ? "note" : "notes"}`)}${blockers ? ` ${theme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`)}` : ""}`, 0, 0);
    const bodies = notes.map(note => {
      const tone = note.severity === "blocker" ? "error" : "warning";
      return { rail: theme.fg(tone, theme.symbol("advisor.rail")),
        text: new Text(`${theme.fg(tone, theme.bold(note.severity.toUpperCase()))} ${theme.fg("dim", `[${note.advisor}]`)} ${theme.fg("customMessageText", note.note)}`, 0, 0) };
    });
    return {
      render(width: number) { return [...header.render(width), ...bodies.flatMap(body => body.text.render(Math.max(1, width - 4)).map(line => `  ${body.rail} ${line}`))]; },
      invalidate() { header.invalidate(); for (const body of bodies) body.text.invalidate(); },
    };
  } };
}
