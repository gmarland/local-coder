import { createHash } from "node:crypto";
import { roles, type Model, type Recommendation } from "../types.js";
import { configuredContext } from "./config.js";

export function contextModelTag(model: Model): string {
  const hash = createHash("sha256").update(model.ollamaModel).digest("hex").slice(0, 12);
  return `localstack-${hash}:ctx${configuredContext(model)}`;
}

// Ollama's OpenAI-compatible endpoint cannot set num_ctx per request. Use a
// small derived model that shares the original weights and fixes num_ctx.
export function withContextModels(selection: Recommendation): Recommendation {
  const variants = new Map<string, Model>();
  for (const model of selection.uniqueModels) {
    variants.set(model.ollamaModel, {
      ...model,
      id: `${model.id}-context-${configuredContext(model)}`,
      name: `${model.name} (${Math.round(configuredContext(model) / 1024)}K context)`,
      ollamaModel: contextModelTag(model),
      contextWindow: configuredContext(model)
    });
  }
  return {
    ...selection,
    assignments: Object.fromEntries(roles.map(role => [role, variants.get(selection.assignments[role].ollamaModel)!])) as Recommendation["assignments"],
    uniqueModels: selection.uniqueModels.map(model => variants.get(model.ollamaModel)!)
  };
}
