import type { CapabilityTier, HardwareInfo, Model, ModelRole, Preset, Recommendation, Role } from "./types.js";

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
const roleMap: Record<Role, ModelRole> = { orchestrator: "orchestrator", coder: "coding", researcher: "research", reviewer: "review" };
export function compatibleModels(models: Model[], h: HardwareInfo, role: Role): Model[] {
  const memory = effectiveMemoryGB(h);
  return models.filter(m => m.roles.includes(roleMap[role]) && m.minimumMemoryGB <= memory && m.storageGB + 5 <= h.diskAvailableGB);
}
function score(model: Model, preset: Preset, role: Role): number {
  const roleBonus = role === "coder" && model.roles.includes("coding") ? 2 : 0;
  if (preset === "fast") return model.speed * 3 + model.quality + roleBonus - model.recommendedMemoryGB / 8;
  if (preset === "quality") return model.quality * 4 + model.speed + roleBonus;
  return model.quality * 2 + model.speed + roleBonus - model.recommendedMemoryGB / 16;
}
export function recommend(models: Model[], h: HardwareInfo, preset: Preset = "balanced"): Recommendation {
  const tier = classifyHardware(h);
  const assignments = {} as Record<Role, Model>;
  const allRoles: Role[] = ["orchestrator", "coder", "researcher", "reviewer"];
  const fitting = (role: Role) => compatibleModels(models, h, role)
    .filter(m => preset === "quality" ? m.minimumMemoryGB <= effectiveMemoryGB(h) : m.recommendedMemoryGB <= effectiveMemoryGB(h))
    .sort((a, b) => score(b, preset, role) - score(a, preset, role));
  const coder = fitting("coder")[0] || compatibleModels(models, h, "coder").sort((a,b) => a.minimumMemoryGB-b.minimumMemoryGB)[0];
  if (!coder) throw new Error("No catalogue model fits this machine's memory and disk space");
  if (preset === "minimal") for (const role of allRoles) assignments[role] = coder;
  else for (const role of allRoles) assignments[role] = fitting(role)[0] || coder;
  if (tier === "VERY_HIGH" && preset !== "fast" && preset !== "minimal")
    assignments.reviewer = fitting("reviewer").find(m => m.id !== assignments.coder.id) || assignments.reviewer;
  const uniqueModels = [...new Map(allRoles.map(r => [assignments[r].id, assignments[r]])).values()];
  const storageGB = Math.round(uniqueModels.reduce((n, m) => n + m.storageGB, 0) * 10) / 10;
  const warnings: string[] = [];
  if (storageGB + 5 > h.diskAvailableGB) warnings.push(`Models need ${storageGB} GB but only ${h.diskAvailableGB} GB is free.`);
  if ((h.availableMemoryGB ?? h.totalMemoryGB) < 6) warnings.push("Available memory is currently low; close large applications before running a model.");
  return { tier, preset, assignments, uniqueModels, storageGB, warnings };
}

export function withCustomAssignments(base: Recommendation, assignments: Record<Role, Model>): Recommendation {
  const uniqueModels = [...new Map((Object.keys(assignments) as Role[]).map(r => [assignments[r].ollamaModel, assignments[r]])).values()];
  return { ...base, assignments, uniqueModels, storageGB: Math.round(uniqueModels.reduce((n, m) => n + m.storageGB, 0) * 10) / 10 };
}
