import { readFile } from "node:fs/promises";
import path from "node:path";
import { roles, type CapabilityTier, type Model, type Preset, type Recommendation, type Role } from "../types.js";
import { summarizeAssignments } from "../models/recommend.js";
import { isModel, isRecord } from "../models/validation.js";

interface SavedStateData {
  version: 1 | 2;
  configuredAt: string;
  preset: Preset;
  tier: CapabilityTier;
  roles: Record<"orchestrator" | "coder" | "researcher" | "reviewer", string> & Partial<Record<Role, string>>;
  storageGB?: unknown;
  assignments?: unknown;
}
const presets = new Set<Preset>(["balanced", "quality", "fast", "minimal"]);
const tiers = new Set<CapabilityTier>(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function isSavedState(value: unknown): value is SavedStateData {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) ||
      !nonempty(value.configuredAt) || !presets.has(value.preset as Preset) || !tiers.has(value.tier as CapabilityTier) ||
      !isRecord(value.roles)) return false;
  const assignedRoles = value.roles;
  return (["orchestrator", "coder", "researcher", "reviewer"] as const).every(role => nonempty(assignedRoles[role])) &&
    roles.every(role => assignedRoles[role] === undefined || nonempty(assignedRoles[role]));
}

function fallbackModel(ollamaModel: string): Model {
  return { id: `restored-${ollamaModel}`, name: ollamaModel, ollamaModel,
    roles: ["orchestrator", "exploration", "planning", "coding", "verification", "research", "review"], minimumMemoryGB: 1, recommendedMemoryGB: 1,
    storageGB: 0, contextWindow: 32768, toolCalling: true, agenticCoding: true, speed: 1, quality: 1,
    notes: "Restored from saved LocalStack state." };
}
export async function readSavedRecommendation(destination: string, catalogueModels: Model[]): Promise<Recommendation> {
  const statePath = path.join(destination, "localstack-state.json");
  let value: unknown;
  try { value = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) {
    const reason = error instanceof Error && "code" in error && error.code === "ENOENT" ? "is missing" : "is invalid";
    throw new Error(`Saved setup state ${reason} at ${statePath}; run localstack setup to choose a configuration.`);
  }
  if (!isSavedState(value))
    throw new Error(`Saved setup state is invalid at ${statePath}; run localstack setup to choose a configuration.`);
  const state = value;
  const assignments = {} as Record<Role, Model>;
  const legacySource: Partial<Record<Role, Role>> = { explorer: "researcher", planner: "orchestrator", verifier: "researcher" };
  for (const role of roles) {
    const source = state.roles[role] ? role : legacySource[role];
    const tag = source ? state.roles[source] : undefined;
    if (!tag) throw new Error(`Saved setup state is invalid at ${statePath}; run localstack setup to choose a configuration.`);
    const snapshot = state.version === 2 && isRecord(state.assignments) ? state.assignments[source!] : undefined;
    assignments[role] = isModel(snapshot) && snapshot.ollamaModel === tag
      ? snapshot
      : catalogueModels.find(model => model.ollamaModel === tag) ?? fallbackModel(tag);
  }
  const summary = summarizeAssignments(assignments);
  const storedSize = typeof state.storageGB === "number" && Number.isFinite(state.storageGB) && state.storageGB >= 0 ? state.storageGB : undefined;
  return { preset: state.preset, tier: state.tier, assignments, ...summary, storageGB: storedSize ?? summary.storageGB, warnings: [] };
}
