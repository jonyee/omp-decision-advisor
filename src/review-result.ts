import type { ReviewFinding, ReviewResult } from "./types.ts";

export function parseReview(text: string, model: string): ReviewResult {
  let data: unknown;
  try { data = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "")); }
  catch { throw new Error("Reviewer did not return valid JSON; no advice was applied."); }
  if (!data || typeof data !== "object") throw new Error("Reviewer returned an invalid review.");
  const object = data as Record<string, unknown>;
  if (!["accept", "revise", "cannot_tell"].includes(String(object.verdict)) || !Array.isArray(object.findings)) {
    throw new Error("Reviewer returned an invalid verdict or findings.");
  }
  const findings = object.findings.map((finding: unknown): ReviewFinding => {
    if (!finding || typeof finding !== "object") throw new Error("Reviewer returned an invalid finding.");
    const entry = finding as Record<string, unknown>;
    if (!["concern", "blocker"].includes(String(entry.severity)) ||
        ["evidence", "explanation", "recommendation"].some(key => typeof entry[key] !== "string" || !(entry[key] as string).trim())) {
      throw new Error("Reviewer finding lacks severity, evidence, explanation or recommendation.");
    }
    return { severity: entry.severity as ReviewFinding["severity"], evidence: String(entry.evidence), explanation: String(entry.explanation), recommendation: String(entry.recommendation) };
  });
  if ((object.verdict === "accept" && findings.length !== 0) || (object.verdict === "revise" && findings.length === 0)) {
    throw new Error("Reviewer verdict contradicts its findings; no advice was applied.");
  }
  return { model, verdict: object.verdict as ReviewResult["verdict"], findings };
}
