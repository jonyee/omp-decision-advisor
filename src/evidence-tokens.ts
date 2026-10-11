import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Tokenizer } from "@huggingface/tokenizers";

// Qwen/Qwen3.5-9B, revision c202236235762e1c871ad0ccb60c8ee5ba337b9a.
// Unmodified tokenizer.json, gzip-compressed; Apache-2.0 (qwen35-tokenizer.LICENSE).
// Original SHA-256: 5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42.
let tokenizer: Tokenizer | undefined;

export function countEvidenceTokens(state: string): number {
  tokenizer ??= new Tokenizer(JSON.parse(gunzipSync(readFileSync(new URL("./qwen35-tokenizer.json.gz", import.meta.url))).toString("utf8")), {});
  return tokenizer.tokenize(state, { add_special_tokens: false }).length;
}
