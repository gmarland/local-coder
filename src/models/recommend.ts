import { roles, type CapabilityTier, type HardwareInfo, type Model, type ModelRole, type Preset, type Recommendation, type Role } from "../types.js";

export function effectiveMemoryGB(h: HardwareInfo): number {
  return h.gpuVramGB ? Math.min(h.totalMemoryGB, h.gpuVramGB + Math.max(8, h.totalMemoryGB * 0.15)) : h.totalMemoryGB;
}
export function classifyHardware(h: HardwareInfo): CapabilityTier {
  const memory = effectiveMemoryGB(h);
  if (memory < 20) return "LOW";
  if (memory < 36) return "MEDIUM";
  if (memory < 72) return "HIGH";
  return "VERY_HIGH";
}
const roleMap: Record<Role, ModelRole> = {
  orchestrator: "orchestrator", explorer: "exploration", planner: "planning", coder: "coding",
  verifier: "verification", researcher: "research", reviewer: "review"
};
const legacyCapability: Partial<Record<Role, ModelRole>> = { explorer: "research", planner: "orchestrator", verifier: "research" };
export interface CompatibilityOptions { includeExperimental?: boolean }
function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return true;
}
export function compatibleModels(models: Model[], h: HardwareInfo, role: Role, options: CompatibilityOptions = {}): Model[] {
  const memory = effectiveMemoryGB(h);
  const capability = models.some(m => m.roles.includes(roleMap[role]))
    ? roleMap[role] : legacyCapability[role] ?? roleMap[role];
  return models.filter(m => m.toolCalling && m.agenticCoding && m.roles.includes(capability) &&
    (options.includeExperimental || m.supportStatus !== "experimental") &&
    (!m.platforms || m.platforms.includes(h.platform)) &&
    (!m.minimumOllamaVersion || !h.ollamaVersion || versionAtLeast(h.ollamaVersion, m.minimumOllamaVersion)) &&
    m.minimumMemoryGB <= memory && m.storageGB + 5 <= h.diskAvailableGB);
}
export function summarizeAssignments(assignments: Record<Role, Model>): Pick<Recommendation, "uniqueModels" | "storageGB"> {
  const uniqueModels = [...new Map(roles.map(role => [assignments[role].ollamaModel, assignments[role]])).values()];
  return { uniqueModels, storageGB: Math.round(uniqueModels.reduce((sum, model) => sum + model.storageGB, 0) * 10) / 10 };
}
function warningsFor(h: HardwareInfo, storageGB: number): string[] {
  const warnings: string[] = [];
  if (storageGB + 5 > h.diskAvailableGB) warnings.push(`Models need ${storageGB} GB but only ${h.diskAvailableGB} GB is free.`);
  if ((h.availableMemoryGB ?? h.totalMemoryGB) < 6) warnings.push("Available memory is currently low; close large applications before running a model.");
  return warnings;
}
function score(model: Model, preset: Preset, role: Role): number {
  const roleBonus = role === "coder" && model.roles.includes("coding") ? 2 : 0;
  const lightweight = role === "explorer" || role === "verifier" || role === "researcher";
  if (lightweight) return preset === "quality"
    ? model.speed * 2 + model.quality * 2 - model.recommendedMemoryGB / 3
    : model.speed * 3 + model.quality - model.recommendedMemoryGB / 2;
  if (preset === "fast") return model.speed * 3 + model.quality + roleBonus - model.recommendedMemoryGB / 8;
  if (preset === "quality") return model.quality * 4 + model.speed + roleBonus;
  return model.quality * 2 + model.speed + roleBonus - model.recommendedMemoryGB / 16;
}
export function recommend(models: Model[], h: HardwareInfo, preset: Preset = "balanced"): Recommendation {
  const tier = classifyHardware(h);
  const assignments = {} as Record<Role, Model>;
  const allRoles = roles;
  const fitting = (role: Role) => compatibleModels(models, h, role)
    .filter(m => preset === "quality" ? m.minimumMemoryGB <= effectiveMemoryGB(h) : m.recommendedMemoryGB <= effectiveMemoryGB(h))
    .sort((a, b) => score(b, preset, role) - score(a, preset, role));
  const minimalCandidates = compatibleModels(models, h, "coder").filter(model => allRoles.every(role =>
    compatibleModels(models, h, role).some(candidate => candidate.id === model.id)));
  const coder = preset === "minimal"
    ? minimalCandidates.filter(m => m.recommendedMemoryGB <= effectiveMemoryGB(h)).sort((a, b) => score(b, preset, "coder") - score(a, preset, "coder"))[0]
      || minimalCandidates.sort((a, b) => a.minimumMemoryGB - b.minimumMemoryGB)[0]
    : fitting("coder")[0] || compatibleModels(models, h, "coder").sort((a,b) => a.minimumMemoryGB-b.minimumMemoryGB)[0];
  if (!coder) throw new Error("No catalogue model fits this machine's memory and disk space");
  if (preset === "minimal") for (const role of allRoles) assignments[role] = coder;
  else for (const role of allRoles) {
    const selected = fitting(role)[0] || compatibleModels(models, h, role).sort((a, b) => a.minimumMemoryGB - b.minimumMemoryGB)[0];
    if (!selected) throw new Error(`No compatible ${role} model fits this machine's memory and disk space`);
    assignments[role] = selected;
  }
  if (tier === "VERY_HIGH" && preset !== "fast" && preset !== "minimal")
    assignments.reviewer = fitting("reviewer").find(m => m.id !== assignments.coder.id) || assignments.reviewer;
  const summary = summarizeAssignments(assignments);
  return { tier, preset, assignments, ...summary, warnings: warningsFor(h, summary.storageGB) };
}

export function withCustomAssignments(base: Recommendation, assignments: Record<Role, Model>, h: HardwareInfo): Recommendation {
  const summary = summarizeAssignments(assignments);
  return { ...base, assignments, ...summary, warnings: warningsFor(h, summary.storageGB) };
}
