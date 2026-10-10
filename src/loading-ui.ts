import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { CancellableLoader } from "@oh-my-pi/pi-tui";

/** Keep focus off the main editor until an explicitly requested operation settles. */
export async function withLoading<T>(ctx: ExtensionCommandContext, message: string, run: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T | undefined> {
  if (outerSignal?.aborted) return undefined;
  if (ctx.mode !== "tui") return run(outerSignal ?? new AbortController().signal);
  type Result = { kind: "ready"; value: T } | { kind: "error"; error: unknown } | { kind: "cancelled" };
  const result = await ctx.ui.custom<Result>((tui, theme, _keys, done) => {
    const request = new AbortController();
    let settled = false;
    const finish = (value: Result) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    const loader = new (class extends CancellableLoader {
      override dispose() { request.abort(); super.dispose(); }
    })(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), `${message} (Esc cancels)`);
    loader.onAbort = () => finish({ kind: "cancelled" });
    const signal = AbortSignal.any([request.signal, loader.signal, ...(outerSignal ? [outerSignal] : [])]);
    void run(signal).then(
      value => finish({ kind: "ready", value }),
      error => finish(signal.aborted ? { kind: "cancelled" } : { kind: "error", error }),
    );
    return loader;
  }, { signal: outerSignal });
  if (result.kind === "error") throw result.error;
  return result.kind === "ready" ? result.value : undefined;
}
