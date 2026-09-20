import { createHash } from "node:crypto";
import { roles, type CapabilityTier, type Model, type Recommendation } from "../types.js";
import { configuredContext } from "./config.js";

export function contextModelTag(model: Model, tier: CapabilityTier = "HIGH"): string {
  const hash = createHash("sha256").update(model.ollamaModel).digest("hex").slice(0, 12);
  return `local-coder-${hash}:ctx${configuredContext(model, tier)}`;
}

// Ollama's OpenAI-compatible endpoint cannot set num_ctx per request. Use a
// small derived model that shares the original weights and fixes num_ctx.
export function withContextModels(selection: Recommendation): Recommendation {
  const variants = new Map<string, Model>();
  for (const model of selection.uniqueModels) {
    const contextWindow = configuredContext(model, selection.tier);
    variants.set(model.ollamaModel, {
      ...model,
      id: `${model.id}-context-${contextWindow}`,
      name: `${model.name} (${Math.round(contextWindow / 1024)}K context)`,
      ollamaModel: contextModelTag(model, selection.tier),
      contextWindow
    });
  }
  return {
    ...selection,
    assignments: Object.fromEntries(roles.map(role => [role, variants.get(selection.assignments[role].ollamaModel)!])) as Recommendation["assignments"],
    uniqueModels: selection.uniqueModels.map(model => variants.get(model.ollamaModel)!)
  };
}
