import assert from "node:assert/strict";
import { test } from "node:test";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildEvidence, textEvidence } from "../src/evidence.ts";
import { CurrentEvidenceOverflowError, DecisionError, MAX_EVIDENCE_TOKENS, packEvidence } from "../src/decision.ts";
import { countEvidenceTokens } from "../src/evidence-tokens.ts";
import type { TurnEvidence } from "../src/types.ts";

const tokenBudget = { count: countEvidenceTokens, max: MAX_EVIDENCE_TOKENS, unit: "tokens" as const };
const pack = (evidence: TurnEvidence) => packEvidence(evidence, tokenBudget);

const core: TurnEvidence = {
  instructions: ["Preserve current evidence and assess only supported claims."],
  userRequest: "Inspect the current result.",
  recentHistory: [],
  assistant: { role: "assistant", content: [{ type: "text", text: "The current result is 42." }] },
  toolResults: [{ role: "toolResult", toolCallId: "current-read", content: [{ type: "text", text: "result = 42" }] }],
};

function assertCurrentUnchanged(packed: TurnEvidence, original: TurnEvidence) {
  assert.strictEqual(packed.instructions, original.instructions);
  assert.strictEqual(packed.userRequest, original.userRequest);
  assert.strictEqual(packed.assistant, original.assistant);
  assert.strictEqual(packed.toolResults, original.toolResults);
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "isolated", model: "test",
    timestamp: 100, stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

for (const detached of [false, true]) {
  test(`buildEvidence deduplicates current messages from ${detached ? "detached" : "identical"} history`, () => {
    const older = { role: "user" as const, content: "Earlier request", timestamp: 1 };
    const current = assistant("Current answer");
    const tool: ToolResultMessage = { role: "toolResult", toolCallId: "read-current", toolName: "read", content: [{ type: "text", text: "Current output" }], isError: false, timestamp: 101 };
    const request = { role: "user" as const, content: "Current request", timestamp: 2 };
    const projected = [older, request, current, tool];
    const history = detached ? structuredClone(projected) : projected;
    const evidence = buildEvidence(["Rules"], history, current, [tool]);
    assert.deepEqual(evidence.recentHistory, [textEvidence(older)]);
    assert.equal(evidence.userRequest, JSON.stringify(request.content));
    assert.deepEqual(evidence.assistant, textEvidence(current));
    assert.deepEqual(evidence.toolResults, [textEvidence(tool)]);
  });
}

test("deduplication compares sanitized content independent of key order and replay metadata", () => {
  const current = { role: "assistant", content: [{ type: "text", text: "Current" }], timestamp: 2, responseId: "opaque" };
  const tool = { role: "toolResult", toolCallId: "read-current", content: [{ type: "text", text: "Output" }], timestamp: 3 };
  const priorTool = { ...tool, toolCallId: "read-prior" };
  const history = [
    { role: "user", content: "Request" },
    priorTool,
    { content: [{ text: "Current", type: "text" }], role: "assistant", timestamp: 999 },
    { content: [{ text: "Output", type: "text" }], toolCallId: "read-current", role: "toolResult", usage: { input: 9 } },
  ];
  const evidence = buildEvidence([], history, current, [tool]);
  assert.deepEqual(evidence.recentHistory, [textEvidence(priorTool)]);
  assert.deepEqual(evidence.assistant, textEvidence(current));
  assert.deepEqual(evidence.toolResults, [textEvidence(tool)]);
});

test("deduplication retains older identical replies across and within a user turn", () => {
  const firstRequest = { role: "user", content: "What is 2 + 2?" };
  const previousTurn = { role: "assistant", content: "4", timestamp: 1 };
  const latestRequest = { role: "user", content: "Check again." };
  const earlierIteration = { role: "assistant", content: "4", timestamp: 2 };
  const current = { role: "assistant", content: "4", timestamp: 3 };
  const history = [firstRequest, previousTurn, latestRequest, earlierIteration, structuredClone(current)];
  const evidence = buildEvidence([], history, current, []);
  assert.deepEqual(evidence.recentHistory, [textEvidence(firstRequest), textEvidence(previousTurn), textEvidence(earlierIteration)]);
  assert.equal(evidence.userRequest, JSON.stringify(latestRequest.content));
  assert.deepEqual(evidence.assistant, textEvidence(current));
});

test("a prior matching reply is retained when the current reply is not yet projected", () => {
  const previous = { role: "assistant", content: "4", timestamp: 1 };
  const request = { role: "user", content: "What is 2 + 2?" };
  const current = { role: "assistant", content: "4", timestamp: 2 };
  const evidence = buildEvidence([], [previous, request], current, []);
  assert.deepEqual(evidence.recentHistory, [textEvidence(previous)]);
  assert.deepEqual(evidence.assistant, textEvidence(current));
});

test("all eligible history reaches packing instead of an incidental message-count cutoff", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({ role: "assistant", content: `Earlier ${index}` }));
  history.push({ role: "user", content: "Latest request" });
  const evidence = buildEvidence([], history, { role: "assistant", content: "Current" }, []);
  assert.deepEqual(evidence.recentHistory, history.slice(0, -1));
  assert.equal(evidence.userRequest, JSON.stringify("Latest request"));
});

test("packing favors newer complete messages and retains chronological order", () => {
  const oldest = { role: "assistant", content: "7".repeat(16_000) };
  const oversized = { role: "toolResult", content: "7".repeat(MAX_EVIDENCE_TOKENS) };
  const newer = { role: "assistant", content: "8".repeat(16_000) };
  const newest = { role: "user", content: "Latest historical detail" };
  const evidence = { ...core, recentHistory: [oldest, oversized, newer, newest] };
  const packed = pack(evidence);
  assert.deepEqual(packed.evidence.recentHistory, [newer, newest]);
  assert.equal(packed.removedHistoryMessages, 2);
  assert.equal(packed.count, countEvidenceTokens(packed.state));
  assert.ok(packed.count <= MAX_EVIDENCE_TOKENS);
  assertCurrentUnchanged(packed.evidence, evidence);
  assert.deepEqual(evidence.recentHistory, [oldest, oversized, newer, newest]);
});

test("an oversized newest historical message does not exclude older messages that fit", () => {
  const older = { role: "user", content: "Relevant earlier request" };
  const newest = { role: "assistant", content: "7".repeat(MAX_EVIDENCE_TOKENS) };
  const packed = pack({ ...core, recentHistory: [older, newest] });
  assert.deepEqual(packed.evidence.recentHistory, [older]);
  assert.equal(packed.removedHistoryMessages, 1);
});

test("packing measures the whole serialized evidence and accepts the exact token boundary", () => {
  const sample = { role: "assistant", content: "7" };
  const remaining = MAX_EVIDENCE_TOKENS - countEvidenceTokens(JSON.stringify({ ...core, recentHistory: [sample] })) + 1;
  const boundary = { ...sample, content: "7".repeat(remaining) };
  const evidence = { ...core, recentHistory: [boundary] };
  const intact = pack(evidence);
  assert.equal(intact.count, MAX_EVIDENCE_TOKENS);
  assert.strictEqual(intact.evidence, evidence);
  assert.equal(intact.state, JSON.stringify(evidence));
  assert.equal(intact.removedHistoryMessages, 0);
  const older = { role: "user", content: "Older" };
  const oversized = { ...core, recentHistory: [older, boundary] };
  const packed = pack(oversized);
  assert.equal(packed.count, MAX_EVIDENCE_TOKENS);
  assert.deepEqual(packed.evidence.recentHistory, [boundary]);
  assert.equal(packed.removedHistoryMessages, 1);
  assertCurrentUnchanged(packed.evidence, oversized);
});

test("an old duplicate payload is discarded without truncating its current counterpart", () => {
  const current = { role: "toolResult", toolCallId: "current", content: "7".repeat(16_000) };
  const older = { ...current, toolCallId: "older" };
  const evidence = { ...core, recentHistory: [older], toolResults: [current] };
  assert.ok(countEvidenceTokens(JSON.stringify(evidence)) > MAX_EVIDENCE_TOKENS);
  const packed = pack(evidence);
  assert.deepEqual(packed.evidence.recentHistory, []);
  assertCurrentUnchanged(packed.evidence, evidence);
  assert.deepEqual(JSON.parse(packed.state), { ...evidence, recentHistory: [] });
  assert.ok(packed.count <= MAX_EVIDENCE_TOKENS);
});

for (const recentHistory of [[], [{ role: "user", content: "Older" }]]) {
  test(`current-only overflow preserves evidence with ${recentHistory.length ? "nonempty" : "empty"} history`, () => {
    const evidence = { ...core, recentHistory, toolResults: [{ content: "7".repeat(MAX_EVIDENCE_TOKENS), marker: "private-current-marker" }] };
    const snapshot = structuredClone(evidence);
    const expectedTokens = countEvidenceTokens(JSON.stringify({ ...evidence, recentHistory: [] }));
    assert.throws(() => pack(evidence), (error: unknown) => {
      assert.ok(error instanceof CurrentEvidenceOverflowError);
      assert.equal(error.currentTokens, expectedTokens);
      assert.equal(error.maxTokens, MAX_EVIDENCE_TOKENS);
      assert.equal(error.code, "evidence_current_overflow");
      assert.equal(error.message.includes("private-current-marker"), false);
      return true;
    });
    assert.deepEqual(evidence, snapshot);
  });
}

test("serialization failures remain failures even in history that would otherwise be discarded", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const evidence of [
    { ...core, assistant: cycle },
    { ...core, recentHistory: [{ content: "7".repeat(MAX_EVIDENCE_TOKENS) }, cycle] },
    { ...core, toolResults: [1n] },
    { ...core, recentHistory: [{ toJSON() { throw new Error("private-serialization-marker"); } }] },
    { ...core, toJSON() { return undefined; } },
  ]) {
    assert.throws(() => pack(evidence), (error: unknown) => {
      assert.ok(error instanceof DecisionError);
      assert.equal(error.code, "evidence_serialization");
      assert.equal(error.message.includes("private-serialization-marker"), false);
      return true;
    });
  }
});

test("cached state counting equals the complete host tokenizer for JSON, Unicode and special tokens", () => {
  const samples = [
    "", "Hello, world! We're checking John's output.\r\n  next\tline   ",
    "界你好 日本語 한국어 العربية हिन्दी é e\u0301 👩🏽‍💻 🧪",
    "0123456789".repeat(100),
    "<>[]{}!@#$%^&*()".repeat(100),
    JSON.stringify(core),
    JSON.stringify({ content: "\\n\n\t\"quote\" \\path", unicode: "e\u0301\u0000\ud800", number: 12345 }),
    JSON.stringify({ ...core, recentHistory: [{ role: "assistant", content: "Repeated core words 界".repeat(500) }] }),
    ...["<|im_start|>", "<|im_end|>", "<|endoftext|>"].map(token => `Before ${token}  after 界`),
  ];
  // Second pass exercises cache hits rather than only initial encoding.
  for (let pass = 0; pass < 2; pass++) {
    for (const sample of samples) {
      const expected = countTokens(sample, Encoding.Qwen3);
      assert.equal(countEvidenceTokens(sample), expected);
    }
  }
});

test("large uncached states retain complete host-tokenizer measurements", () => {
  const sample = JSON.stringify({ content: "Unique uncached sequence 7391264.".repeat(6000) });
  const expected = countTokens(sample, Encoding.Qwen3);
  assert.equal(countEvidenceTokens(sample), expected);
  assert.equal(countEvidenceTokens(sample), expected);
});

test("standalone packing defaults to bytes and reports byte overflow without token counts", () => {
  const evidence = { ...core, userRequest: "界".repeat(28_000) };
  assert.throws(() => packEvidence(evidence), (error: unknown) => {
    assert.ok(error instanceof CurrentEvidenceOverflowError);
    assert.equal(error.budget.unit, "bytes");
    assert.equal(error.currentCount, Buffer.byteLength(JSON.stringify(evidence), "utf8"));
    assert.equal(error.currentTokens, undefined);
    assert.match(error.message, /bytes/);
    return true;
  });
});
