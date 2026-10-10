import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type AzureRunner = <T>(args: string[], signal?: AbortSignal) => Promise<T>;

export const runAzure: AzureRunner = async <T>(args: string[], signal?: AbortSignal): Promise<T> => {
  signal?.throwIfAborted();
  try {
    const { stdout } = await execute("az", [...args, "--only-show-errors", "--output", "json"], {
      shell: false, timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      signal,
      env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: "false", AZURE_CORE_LOGGING_ENABLE_LOG_FILE: "false" },
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    signal?.throwIfAborted();
    // Azure errors and execFile error messages can contain resource IDs, endpoints and argument arrays.
    const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
    const codes = ["AuthorizationFailed", "Forbidden", "InsufficientQuota", "QuotaExceeded", "DeploymentModelNotSupported", "InvalidResourceProperties", "Conflict", "RequestDisallowedByPolicy", "ResourceNotFound"];
    const code = codes.find(value => stderr.includes(value));
    throw new Error(`Azure CLI operation failed${code ? ` (${code})` : ""}. Check local Azure sign-in, read/deployment permissions, model access, quota and policy. Raw diagnostics are suppressed to protect resource identifiers.`);
  }
};
