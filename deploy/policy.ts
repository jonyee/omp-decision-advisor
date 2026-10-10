export const MODEL_NAME = "Microsoft-Decision-1";

export interface ModelSku {
  name: string;
  usageName?: string;
  capacity?: { minimum?: number | null; maximum?: number | null; step?: number | null; allowedValues?: number[] | null } | null;
}
export interface CatalogModel {
  name: string;
  format: string;
  version: string;
  isDefaultVersion?: boolean;
  lifecycleStatus?: string;
  maxCapacity?: number | null;
  deprecation?: { inference?: string | null } | null;
  skus?: ModelSku[] | null;
}
export interface Usage {
  name: { value: string };
  currentValue: number;
  limit: number;
  status?: string;
}
export interface Deployment {
  name: string;
  sku?: { name?: string; capacity?: number };
  properties?: { model?: { name?: string; format?: string; version?: string }; provisioningState?: string };
}
export interface Selection {
  model: CatalogModel;
  sku: ModelSku;
  capacity: number;
  quota: { limit: number; used: number; remaining: number };
}

export function eligibleModels(models: CatalogModel[], now = Date.now()): CatalogModel[] {
  return models.filter(model => model.name === MODEL_NAME && model.format === "Microsoft" && typeof model.version === "string" && model.version.length > 0
    && model.lifecycleStatus !== "Retired" && model.lifecycleStatus !== "Deprecated"
    && (!model.deprecation?.inference || Date.parse(model.deprecation.inference) > now));
}

export function selectModel(models: CatalogModel[]): CatalogModel {
  const available = eligibleModels(models);
  const defaults = available.filter(model => model.isDefaultVersion);
  const choices = defaults.length ? defaults : available;
  if (choices.length !== 1) throw new Error(choices.length ? "The live model catalog has ambiguous versions; no deployment will be changed." : "Microsoft-Decision-1 is unavailable for this existing account.");
  return choices[0]!;
}

function validCapacity(model: CatalogModel, sku: ModelSku, capacity: number): boolean {
  if (!Number.isSafeInteger(capacity) || capacity < 1) return false;
  const config = sku.capacity;
  const minimum = config?.minimum ?? 1;
  return capacity >= minimum && capacity <= (config?.maximum ?? Infinity)
    && capacity <= (model.maxCapacity ?? Infinity)
    && (!config?.allowedValues?.length || config.allowedValues.includes(capacity))
    && (!config?.step || (capacity - minimum) % config.step === 0);
}

export function selectDeployment(models: CatalogModel[], usages: Usage[], capacity: number, requestedSku?: string, existing?: Deployment): Selection {
  const model = selectModel(models);
  if (existing) assertModelMatches(existing, model);
  const wanted = requestedSku ?? existing?.sku?.name;
  // Azure may reduce advertised maxCapacity after allocation; a healthy exact match is authoritative.
  const supported = (model.skus ?? []).filter(sku => existing
    ? Number.isSafeInteger(capacity) && capacity > 0 && existing.sku?.capacity === capacity
    : validCapacity(model, sku, capacity));
  const skus = wanted ? supported.filter(sku => sku.name === wanted) : ["DataZoneStandard", "GlobalStandard", "Standard"].flatMap(name => supported.filter(sku => sku.name === name));
  for (const sku of skus) {
    const usage = usages.find(value => value.name?.value === sku.usageName);
    if (!usage || !Number.isFinite(usage.limit) || !Number.isFinite(usage.currentValue) || usage.status === "Blocked" || usage.status === "Unknown") continue;
    const remaining = Math.max(0, usage.limit - usage.currentValue);
    // Existing healthy capacity is already included in regional usage: do not charge it twice.
    if (remaining >= capacity || existing) {
      const selection = { model, sku, capacity, quota: { limit: usage.limit, used: usage.currentValue, remaining } };
      if (existing) assertReusable(existing, selection);
      return selection;
    }
  }
  throw new Error("No eligible live SKU with confirmed quota supports the requested capacity. Check model availability, regional quota and capacity constraints; no deployment will be changed.");
}

function assertModelMatches(existing: Deployment, model: CatalogModel): void {
  const actual = existing.properties?.model;
  if (actual?.name !== model.name || actual?.format !== model.format || actual?.version !== model.version) {
    throw new Error("The requested deployment already exists with a different model or version; refusing to overwrite it.");
  }
}

export function assertReusable(existing: Deployment, selection: Selection): void {
  assertModelMatches(existing, selection.model);
  if (existing.sku?.name !== selection.sku.name || existing.sku?.capacity !== selection.capacity) {
    throw new Error("The requested deployment already exists with a different SKU or capacity; refusing to overwrite it.");
  }
  if (existing.properties?.provisioningState !== "Succeeded") {
    throw new Error("The requested deployment already exists but is not healthy; refusing to modify it. Inspect its status locally in Azure.");
  }
}
