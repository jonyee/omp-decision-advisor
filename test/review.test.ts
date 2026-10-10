import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/review-result.ts";
import { buildEvidence } from "../src/evidence.ts";

test("review verdict cannot accept concrete defect findings", () => {
  const finding = { severity: "blocker", evidence: "result = 5", explanation: "2 + 2 is not 5", recommendation: "Return 4" };
  assert.throws(() => parseReview(JSON.stringify({ verdict: "accept", findings: [finding] }), "reviewer"), /contradicts/);
  assert.deepEqual(parseReview(JSON.stringify({ verdict: "revise", findings: [finding] }), "reviewer").findings, [finding]);
  assert.throws(() => parseReview('{"verdict":"revise","findings":[]}', "reviewer"), /contradicts/);
});

test("findings without evidence cannot steer the primary", () => {
  assert.throws(() => parseReview('{"verdict":"revise","findings":[{"severity":"concern","explanation":"bad","recommendation":"fix"}]}', "reviewer"), /lacks/);
  assert.throws(() => parseReview("Some prose, not a review", "reviewer"), /valid JSON/);
  assert.equal(parseReview('```json\n{"verdict":"cannot_tell","findings":[]}\n```', "reviewer").verdict, "cannot_tell");
});

test("turn evidence keeps latest request, not advisor self-feedback or replay attachments", () => {
  const history = [
    { role: "user", content: "First goal" },
    { role: "user", content: [{ type: "text", text: "Current goal" }, { type: "image", data: "binary", mimeType: "image/png" }] },
    { role: "custom", customType: "decision-feedback", content: "False blocker" },
  ];
  const evidence = buildEvidence(["rules"], history, { role: "assistant", providerPayload: { items: ["opaque-envelope"] }, responseId: "opaque-id", content: [{ type: "thinking", thinking: "inspect", thinkingSignature: "secret-signature" }] }, []);
  const serialized = JSON.stringify(evidence);
  assert.match(evidence.userRequest, /Current goal/);
  assert.match(serialized, /unavailable_attachment/);
  assert.doesNotMatch(serialized, /binary|secret-signature|False blocker|opaque-envelope|opaque-id/);
});
