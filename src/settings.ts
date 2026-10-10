import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "./config.ts";

const PLUGIN_NAME = "omp-decision-advisor";

/** Read effective preferences, including project overrides, without writing any settings. */
export async function loadDecisionSettings(cwd: string): Promise<DecisionSettings> {
  const manager = new PluginManager(cwd);
  return normalizeDecisionSettings(await manager.getPluginSettings(PLUGIN_NAME));
}

/** Save only validated preference keys to the active OMP profile, then return effective values. */
export async function saveDecisionSettings(cwd: string, settings: DecisionSettings): Promise<DecisionSettings> {
  const normalized = normalizeDecisionSettings({ ...settings });
  if (normalized.endpoint || normalized.deployment) toDecisionOptions(normalized);
  const manager = new PluginManager(cwd);
  for (const [key, value] of Object.entries(normalized)) {
    await manager.setPluginSetting(PLUGIN_NAME, key, value);
  }
  return normalizeDecisionSettings(await manager.getPluginSettings(PLUGIN_NAME));
}
