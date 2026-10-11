import { REVIEW_HOST_WAIT_MS } from "./config.ts";

export type ReviewerErrorCode = "timeout" | "cancelled" | "configuration" | "provider" | "tool" | "response";

const REVIEW_ERROR_ACTIONS: Record<ReviewerErrorCode, string> = {
  timeout: "Reviewer reached its execution deadline. Increase the reviewer execution timeout in /decision settings if more time is needed.",
  cancelled: "Reviewer was cancelled. Request /decision review again when ready.",
  configuration: "Check reviewer configuration in /decision settings.",
  provider: "Reviewer provider request failed. Check provider availability, OMP credentials and connectivity before requesting another review.",
  tool: "Reviewer tool operation failed or was denied. Check the granted tools and OMP operation approvals before requesting another review.",
  response: "Reviewer returned an incomplete or invalid review response. Request another review or select a different reviewer model in /decision settings.",
};

export class ReviewerError extends Error {
  constructor(readonly code: ReviewerErrorCode) {
    super(REVIEW_ERROR_ACTIONS[code]);
    this.name = "ReviewerError";
  }
}

export class ReviewerConfigurationError extends ReviewerError {
  constructor(message = REVIEW_ERROR_ACTIONS.configuration) {
    super("configuration");
    this.name = "ReviewerConfigurationError";
    this.message = message;
  }
}

/** Bound the host's wait without cancelling reviews or losing later findings. */
export async function waitForReviews(reviews: Iterable<Promise<void>>, signal: AbortSignal, waitMs = REVIEW_HOST_WAIT_MS): Promise<void> {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > REVIEW_HOST_WAIT_MS) {
    throw new ReviewerConfigurationError(`Host review wait must be between 0 and ${REVIEW_HOST_WAIT_MS} milliseconds.`);
  }
  if (signal.aborted) return;
  const pending = [...reviews];
  if (!pending.length) return;
  const { promise: budget, resolve: release } = Promise.withResolvers<void>();
  const onAbort = () => release();
  const timer = setTimeout(release, waitMs);
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([Promise.allSettled(pending), budget]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
}

/** Fence both sides of awaits, including SDK/providers that do not honor cancellation. */
export async function awaitReviewOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise: interrupted, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([operation(), interrupted]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}
