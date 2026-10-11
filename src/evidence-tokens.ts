import { countTokens, Encoding } from "@oh-my-pi/pi-natives";

// Use the tokenizer already supplied by OMP; do not ship model assets.
// Cache complete states only, with bounded memory and no approximate counts.
const counts = new Map<string, number>();
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_STATE_BYTES = 128 * 1024;

export function countEvidenceTokens(state: string): number {
  const cached = counts.get(state);
  if (cached !== undefined) return cached;
  const count = countTokens(state, Encoding.Qwen3);
  if (Buffer.byteLength(state, "utf8") <= MAX_CACHE_STATE_BYTES) {
    if (counts.size >= MAX_CACHE_ENTRIES) counts.delete(counts.keys().next().value!);
    counts.set(state, count);
  }
  return count;
}
