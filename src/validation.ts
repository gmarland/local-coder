import { roles, type CapabilityTier, type Model, type Preset, type Role } from "./types.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const modelRoles = new Set(["orchestrator", "coding", "research", "review"]);
const presets = new Set<Preset>(["balanced", "quality", "fast", "minimal"]);
const tiers = new Set<CapabilityTier>(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function isModel(value: unknown): value is Model {
  if (!isRecord(value)) return false;
  return nonempty(value.id) && nonempty(value.name) && nonempty(value.ollamaModel) &&
    Array.isArray(value.roles) && value.roles.length > 0 && value.roles.every(role => modelRoles.has(role)) &&
    positive(value.minimumMemoryGB) && positive(value.recommendedMemoryGB) &&
    typeof value.storageGB === "number" && Number.isFinite(value.storageGB) && value.storageGB >= 0 &&
    positive(value.contextWindow) && positive(value.speed) && positive(value.quality) &&
    typeof value.toolCalling === "boolean" && typeof value.agenticCoding === "boolean" &&
    typeof value.notes === "string";
}

export const isPreset = (value: unknown): value is Preset => presets.has(value as Preset);
export const isTier = (value: unknown): value is CapabilityTier => tiers.has(value as CapabilityTier);

export interface SavedStateData {
  version: 1 | 2;
  configuredAt: string;
  preset: Preset;
  tier: CapabilityTier;
  roles: Record<Role, string>;
  storageGB?: unknown;
  assignments?: unknown;
}
export function isSavedState(value: unknown): value is SavedStateData {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) ||
      !nonempty(value.configuredAt) || !isPreset(value.preset) || !isTier(value.tier) ||
      !isRecord(value.roles)) return false;
  const assignedRoles = value.roles;
  if (!roles.every(role => nonempty(assignedRoles[role]))) return false;
  return true;
}
