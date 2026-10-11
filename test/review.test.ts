import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/review-result.ts";
import { buildEvidence } from "../src/evidence.ts";
import { awaitReviewOperation, ReviewerConfigurationError, ReviewerError, waitForReviews, type ReviewerErrorCode } from "../src/review-lifecycle.ts";
import { REVIEW_HOST_WAIT_MS } from "../src/config.ts";

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

test("bounded host wait returns without cancelling a pending review or losing its result", async () => {
  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  const findings: string[] = [];
  const review = completion.promise.then(() => { findings.push("late finding"); });
  await waitForReviews([review], controller.signal, 0);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(findings, []);
  completion.resolve();
  await review;
  assert.deepEqual(findings, ["late finding"]);
});

test("host wait observes completed failures and cancellation but never changes the review lifetime", async () => {
  await waitForReviews([Promise.resolve(), Promise.reject(new ReviewerError("provider"))], new AbortController().signal);
  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  let completed = false;
  const review = completion.promise.then(() => { completed = true; });
  const waiting = waitForReviews([review], controller.signal);
  controller.abort();
  await waiting;
  assert.equal(completed, false);
  completion.resolve();
  await review;
  assert.equal(completed, true);
  const cancelled = new AbortController();
  cancelled.abort();
  await waitForReviews([new Promise<void>(() => {})], cancelled.signal);
});

test("host wait validates only its bounded budget, not the reviewer execution budget", async () => {
  for (const waitMs of [-1, 20_001, 0.5, Infinity, NaN]) {
    await assert.rejects(waitForReviews([], new AbortController().signal, waitMs), error => error instanceof ReviewerConfigurationError && error.code === "configuration");
  }
  await waitForReviews([], new AbortController().signal, REVIEW_HOST_WAIT_MS);
  assert.equal(REVIEW_HOST_WAIT_MS, 20_000);
});

test("review operation cancellation fences an unresolved provider and rejects late completion", async () => {
  const controller = new AbortController();
  const provider = Promise.withResolvers<string>();
  let delivered = false;
  const operation = awaitReviewOperation(() => provider.promise, controller.signal).then(value => { delivered = true; return value; });
  const failure = new ReviewerError("timeout");
  const rejection = assert.rejects(operation, error => error === failure);
  controller.abort(failure);
  await rejection;
  provider.resolve("late provider body");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(delivered, false);
});

test("review operation fence prevents startup after cancellation and checks abort after await", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new ReviewerError("cancelled"));
  let calls = 0;
  await assert.rejects(awaitReviewOperation(async () => { calls++; return 1; }, cancelled.signal), error => error instanceof ReviewerError && error.code === "cancelled");
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(awaitReviewOperation(async () => {
    during.abort(new ReviewerError("cancelled"));
    return "must not deliver";
  }, during.signal), error => error instanceof ReviewerError && error.code === "cancelled");
  const thrown = new Error("private-provider-body");
  await assert.rejects(awaitReviewOperation(() => { throw thrown; }, new AbortController().signal), error => error === thrown);
  assert.equal(await awaitReviewOperation(async () => "completed", new AbortController().signal), "completed");
});

test("reviewer failures carry stable typed categories without accepting provider prose", () => {
  const categories: ReviewerErrorCode[] = ["timeout", "cancelled", "configuration", "provider", "tool", "response"];
  for (const category of categories) {
    const failure = new ReviewerError(category);
    assert.equal(failure.code, category);
    assert.equal(failure.name, "ReviewerError");
    assert.ok(failure.message.length > 0);
    assert.doesNotMatch(failure.message, /private-provider-body/);
  }
  const configuration = new ReviewerConfigurationError();
  assert.ok(configuration instanceof ReviewerError);
  assert.equal(configuration.code, "configuration");
});
