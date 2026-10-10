import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewHistory, type ReviewHistoryEntry } from "../src/review-history.ts";
import { parseReview } from "../src/review-result.ts";

const MAX_HISTORY_BYTES = 16_384;

function completedReview(turn: number, userRequest = `Request ${turn}`, evidence = `Assistant returned the wrong value on turn ${turn}`): ReviewHistoryEntry {
  return {
    turn,
    userRequest,
    result: parseReview(JSON.stringify({
      verdict: "revise",
      findings: [{
        severity: "concern",
        evidence,
        explanation: "The returned value does not satisfy the request.",
        recommendation: "Correct the value and explain the correction.",
      }],
    }), "reviewer-model"),
  };
}

function serializedBytes(entries: ReviewHistoryEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

function sizedReview(turn: number, bytes: number): ReviewHistoryEntry {
  const entry = completedReview(turn, "");
  const remaining = bytes - serializedBytes([entry]);
  assert.ok(remaining >= 0);
  entry.userRequest = "x".repeat(remaining);
  assert.equal(serializedBytes([entry]), bytes);
  return entry;
}

test("out-of-order completed reviews expose only prior turns, newest first selection and ascending delivery", () => {
  const history = new ReviewHistory();
  const first = completedReview(1, "First request");
  first.result = parseReview('{"verdict":"accept","findings":[]}', "reviewer-model");
  const second = completedReview(2, "Second request");
  const third = completedReview(3, "Third request");
  third.result = parseReview('{"verdict":"cannot_tell","findings":[]}', "reviewer-model");
  const fourth = completedReview(4, "Fourth request");

  history.record(second, 8);
  history.record(fourth, 8);
  history.record(first, 8);
  const priorToThird = history.snapshot(3, 3);
  assert.deepEqual(priorToThird, [first, second]);
  history.record(third, 8);

  assert.deepEqual(history.snapshot(3, 8), [first, second]);
  assert.deepEqual(history.snapshot(3, 1), [second]);
  assert.deepEqual(history.snapshot(5, 2), [third, fourth]);
  assert.deepEqual(history.snapshot(5, 8), [first, second, third, fourth]);
  assert.deepEqual(priorToThird, [first, second]);
  assert.deepEqual(history.snapshot(1, 8), []);
});

test("count bounds keep newest primary turns despite late older completions and a reduced limit", () => {
  const history = new ReviewHistory();
  const entries = [1, 2, 3, 4, 5].map(turn => completedReview(turn));
  for (const index of [2, 0, 4, 1]) history.record(entries[index], 3);
  assert.deepEqual(history.snapshot(6, 8), [entries[1], entries[2], entries[4]]);
  history.record(entries[3], 2);
  assert.deepEqual(history.snapshot(6, 8), [entries[3], entries[4]]);
  history.record(entries[0], 2);
  assert.deepEqual(history.snapshot(6, 8), [entries[3], entries[4]]);
  assert.deepEqual(history.snapshot(4, 8), []);

  history.clear();
  for (let turn = 1; turn <= 10; turn++) history.record(completedReview(turn), 8);
  assert.deepEqual(history.snapshot(11, 8).map(entry => entry.turn), [3, 4, 5, 6, 7, 8, 9, 10]);
});

test("a completed replacement updates the exact request and result without duplicating its turn", () => {
  const history = new ReviewHistory();
  const first = completedReview(1, "Original request", "Original evidence");
  const second = completedReview(2);
  history.record(first, 3);
  history.record(second, 3);

  const replacement = completedReview(1, "  Corrected request\n\"雪\"\\  ", "  Corrected evidence\n\"é\"\\  ");
  replacement.result.findings[0].severity = "blocker";
  history.record(replacement, 3);
  assert.deepEqual(history.snapshot(3, 3), [replacement, second]);
});

test("a single full summary at the exact UTF-8 array budget is retained without truncation", () => {
  const history = new ReviewHistory();
  const entry = completedReview(1, "  Request with \"quotes\",\\,\n and 雪: ", "Evidence with \"quotes\",\\,\n and 雪.");
  const remaining = MAX_HISTORY_BYTES - serializedBytes([entry]);
  entry.userRequest += "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  assert.equal(serializedBytes([entry]), MAX_HISTORY_BYTES);
  assert.ok(entry.userRequest.length < Buffer.byteLength(entry.userRequest, "utf8"));

  history.record(entry, 8);
  const snapshot = history.snapshot(2, 8);
  assert.deepEqual(snapshot, [entry]);
  assert.equal(serializedBytes(snapshot), MAX_HISTORY_BYTES);

  const oversized = { ...entry, userRequest: `${entry.userRequest}x` };
  assert.equal(serializedBytes([oversized]), MAX_HISTORY_BYTES + 1);
  history.record(oversized, 8);
  assert.deepEqual(history.snapshot(2, 8), []);
});

test("array commas and brackets count toward the shared byte bound including replacement accounting", () => {
  const history = new ReviewHistory();
  const first = sizedReview(1, 8192);
  const second = sizedReview(2, 8193);
  assert.equal(serializedBytes([first, second]), MAX_HISTORY_BYTES);
  history.record(second, 8);
  history.record(first, 8);
  assert.deepEqual(history.snapshot(3, 8), [first, second]);
  assert.equal(serializedBytes(history.snapshot(3, 8)), MAX_HISTORY_BYTES);

  const replacement = sizedReview(2, 8194);
  assert.equal(serializedBytes([first, replacement]), MAX_HISTORY_BYTES + 1);
  history.record(replacement, 8);
  assert.deepEqual(history.snapshot(3, 8), [replacement]);
  assert.equal(serializedBytes(history.snapshot(3, 8)), 8194);
});

test("byte eviction discards whole oldest entries rather than trimming requests or results", () => {
  const history = new ReviewHistory();
  const first = sizedReview(1, 6000);
  const second = sizedReview(2, 6000);
  const third = sizedReview(3, 6000);
  assert.ok(serializedBytes([first, second, third]) > MAX_HISTORY_BYTES);
  history.record(third, 8);
  history.record(first, 8);
  history.record(second, 8);
  const snapshot = history.snapshot(4, 8);
  assert.deepEqual(snapshot, [second, third]);
  assert.ok(serializedBytes(snapshot) <= MAX_HISTORY_BYTES);
});

test("oversized findings are omitted whole and supersede any old result for the same turn", () => {
  const history = new ReviewHistory();
  const first = completedReview(1);
  const second = completedReview(2);
  const third = completedReview(3);
  for (const entry of [first, second, third]) history.record(entry, 8);
  const oversized = completedReview(2, "Replacement request", "雪".repeat(MAX_HISTORY_BYTES));
  assert.ok(serializedBytes([oversized]) > MAX_HISTORY_BYTES);

  history.record(oversized, 8);
  assert.deepEqual(history.snapshot(4, 8), [first, third]);
  assert.equal(oversized.result.findings[0].evidence, "雪".repeat(MAX_HISTORY_BYTES));

  history.record(completedReview(4, "New oversized request", oversized.result.findings[0].evidence), 1);
  assert.deepEqual(history.snapshot(5, 8), [third]);
});

test("disabled and cleared histories cannot leak earlier session summaries when re-enabled", () => {
  const history = new ReviewHistory();
  const first = completedReview(1, "First session request");
  history.record(first, 3);
  history.record(completedReview(2), 0);
  assert.deepEqual(history.snapshot(3, 8), []);

  history.record(first, 3);
  assert.deepEqual(history.snapshot(2, 0), []);
  assert.deepEqual(history.snapshot(2, 8), []);

  history.record(first, 3);
  history.clear();
  assert.deepEqual(history.snapshot(2, 8), []);
  history.clear();
  const nextSession = completedReview(1, "Different session request");
  history.record(nextSession, 3);
  assert.deepEqual(history.snapshot(2, 8), [nextSession]);
});

test("record inputs and snapshots cannot mutate stored requests, findings or subsequent snapshots", () => {
  const history = new ReviewHistory();
  const entry = completedReview(1, "Original request", "Original evidence");
  const original = completedReview(1, "Original request", "Original evidence");
  history.record(entry, 3);
  entry.turn = 7;
  entry.userRequest = "Mutated caller request";
  entry.result.model = "mutated-model";
  entry.result.verdict = "cannot_tell";
  entry.result.findings[0].evidence = "Mutated caller evidence";
  entry.result.findings.push({ ...entry.result.findings[0], recommendation: "Caller-added finding" });
  assert.deepEqual(history.snapshot(2, 3), [original]);

  const snapshot = history.snapshot(2, 3);
  snapshot[0].turn = 8;
  snapshot[0].userRequest = "Mutated snapshot request";
  snapshot[0].result.model = "mutated-snapshot-model";
  snapshot[0].result.findings[0].explanation = "Mutated snapshot explanation";
  snapshot[0].result.findings.length = 0;
  snapshot.push(completedReview(9));
  assert.deepEqual(history.snapshot(2, 3), [original]);
});

test("invalid limits and turn boundaries reject before modifying completed summaries", () => {
  const history = new ReviewHistory();
  const entry = completedReview(1);
  history.record(entry, 3);
  for (const limit of [-1, 9, 1.5, NaN, Infinity]) {
    assert.throws(() => history.record(completedReview(2), limit), /limit must be an integer/);
    assert.throws(() => history.snapshot(3, limit), /limit must be an integer/);
  }
  for (const turn of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => history.record({ ...entry, turn }, 3), /turn must be a positive safe integer/);
    assert.throws(() => history.snapshot(turn, 3), /boundary turn must be a positive safe integer/);
  }
  assert.deepEqual(history.snapshot(3, 3), [entry]);
});

