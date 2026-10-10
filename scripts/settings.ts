import { execFile } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeDecisionSettings, type DecisionSettings } from "../src/config.js";

const execute = promisify(execFile);

export class SettingsSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsSetupError";
  }
}

/** npm prepends the SDK source CLI, which needs Bun rather than standalone Node. */
export function installedOmpEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  environment.PATH = (environment.PATH ?? "").split(delimiter)
    .filter(directory => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(directory)).join(delimiter);
  return environment;
}

/** Probe flags use the same profile and project selection as an OMP launch. */
function settingsContext(args: readonly string[]): { cwd: string; profileArgs: string[] } {
  let cwd = process.cwd();
  let profile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (flag !== "--profile" && flag !== "--cwd") {
      throw new SettingsSetupError("Probe accepts only --profile <name> and --cwd <directory>; use the same values as your OMP launch.");
    }
    const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
    if (!value || (flag === "--profile" && value.startsWith("-"))) {
      throw new SettingsSetupError("Provide a value for --profile or --cwd; use the same profile and project directory as your OMP launch.");
    }
    if (flag === "--profile") profile = value;
    else cwd = resolve(process.cwd(), value);
  }
  return { cwd, profileArgs: profile === undefined ? [] : ["--profile", profile] };
}

/** Read the host's store without importing its Bun-dependent SDK or writing config files. */
export async function readStoredDecisionSettings(args: readonly string[] = []): Promise<DecisionSettings> {
  const { cwd, profileArgs } = settingsContext(args);
  let stdout: string;
  try {
    // `list` precedes the plugin name. Plugin commands do not accept --cwd;
    // their PluginManager resolves project overrides from the subprocess cwd.
    ({ stdout } = await execute("omp", [...profileArgs, "plugin", "config", "list", "omp-decision-advisor", "--json"], {
      cwd, env: installedOmpEnvironment(), shell: false, timeout: 30_000, maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new SettingsSetupError("Cannot read OMP plugin settings. Install a compatible OMP binary, make omp-decision-advisor discoverable with omp plugin link <local-plugin-directory> in the selected profile, then launch npm run omp -- with the same --profile/--cwd flags and configure /decision. Raw CLI diagnostics are suppressed.");
  }
  try {
    const result: unknown = JSON.parse(stdout);
    if (result === null || typeof result !== "object" || Array.isArray(result) || !("settings" in result)) throw new Error();
    const settings = result.settings;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
    return normalizeDecisionSettings(settings as Record<string, unknown>);
  } catch {
    throw new SettingsSetupError("OMP returned invalid decision settings. Open /decision in the same profile/project to save valid provider, model, threshold and timeout settings; raw settings and diagnostics are suppressed.");
  }
}
