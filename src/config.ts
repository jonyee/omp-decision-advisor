import type { DecisionOptions } from "./types.js";

export const MIN_PASS_THRESHOLD = 0.5;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 120_000;

/** HTTP is accepted only with explicitly injected test credentials on literal loopback. */
export function validateDecisionOptions(options: DecisionOptions, allowTestLoopback = false): DecisionOptions {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error("DECISION_ENDPOINT must be an absolute HTTPS URL.");
  }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(allowTestLoopback && loopback && endpoint.protocol === "http:")) {
    throw new Error("DECISION_ENDPOINT must use HTTPS; HTTP is permitted only for isolated loopback tests.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("DECISION_ENDPOINT must be the account HTTPS origin, without credentials, paths, query or fragment.");
  }
  if (typeof options.deployment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.deployment)) {
    throw new Error("DECISION_DEPLOYMENT must be a deployment name of 1–128 letters, digits, dots, underscores or hyphens.");
  }
  if (!Number.isFinite(options.passThreshold) || options.passThreshold < MIN_PASS_THRESHOLD || options.passThreshold > 1) {
    throw new Error("DECISION_PASS_THRESHOLD must be a finite number between 0.5 and 1.");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < MIN_TIMEOUT_MS || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("DECISION_TIMEOUT_MS must be an integer between 100 and 120000.");
  }
  return { ...options, endpoint: endpoint.origin };
}

function numericEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    throw new Error(`${name} must be an unsigned decimal number.`);
  }
  return Number(value);
}

export function readDecisionOptions(env: NodeJS.ProcessEnv = process.env): DecisionOptions {
  if (env.DECISION_API_KEY !== undefined) {
    throw new Error("DECISION_API_KEY is unsupported by the verified System One contract. Remove it and use Azure identity (for example az login).");
  }
  if (!env.DECISION_ENDPOINT || !env.DECISION_DEPLOYMENT) {
    throw new Error("Set DECISION_ENDPOINT and DECISION_DEPLOYMENT before enabling Azure decision scoring.");
  }
  return validateDecisionOptions({
    endpoint: env.DECISION_ENDPOINT,
    deployment: env.DECISION_DEPLOYMENT,
    passThreshold: numericEnv(env, "DECISION_PASS_THRESHOLD", 0.8),
    timeoutMs: numericEnv(env, "DECISION_TIMEOUT_MS", 10_000),
  });
}
