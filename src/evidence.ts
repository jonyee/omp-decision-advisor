import type { TurnEvidence } from "./types.ts";

/** Do not forward provider replay signatures or binary attachments to a text judge. */
export function textEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(textEvidence);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.type === "image" || object.type === "audio" || object.type === "video") {
    return { type: "unavailable_attachment", reason: "Text-only reviewer cannot inspect this attachment." };
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(object)) {
    if (/signature|encrypted|replay|usage|timestamp/i.test(key) || ["providerPayload", "responseId", "credentialId"].includes(key)) continue;
    result[key] = textEvidence(field);
  }
  return result;
}

export function buildEvidence(instructions: string[], history: unknown[], assistant: unknown, toolResults: unknown[]): TurnEvidence {
  const relevant = history.filter((message): message is Record<string, unknown> => {
    if (!message || typeof message !== "object") return false;
    const item = message as Record<string, unknown>;
    return ["user", "assistant", "toolResult", "compactionSummary", "branchSummary"].includes(String(item.role));
  });
  const user = relevant.findLast(message => message.role === "user");
  return {
    instructions,
    userRequest: user ? JSON.stringify(textEvidence(user.content)) : "No user request available; abstain where necessary.",
    recentHistory: relevant.slice(-8).map(textEvidence),
    assistant: textEvidence(assistant),
    toolResults: toolResults.map(textEvidence),
  };
}
