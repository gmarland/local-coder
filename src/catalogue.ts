import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Catalogue, Model } from "./types.js";
import { isModel, isRecord } from "./validation.js";

export async function loadCatalogue(path = fileURLToPath(new URL("../../catalog/models.json", import.meta.url))): Promise<Catalogue> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("catalogue must be an object");
  if (value.schemaVersion !== 1 || typeof value.updated !== "string" || !value.updated.trim() ||
      !Array.isArray(value.models) || value.models.length === 0) throw new Error("unsupported or empty model catalogue");
  const ids = new Set<string>();
  const tags = new Set<string>();
  const models: Model[] = [];
  for (const item of value.models) {
    if (!isModel(item)) throw new Error("catalogue contains an invalid model");
    if (ids.has(item.id)) throw new Error(`duplicate catalogue model: ${item.id}`);
    ids.add(item.id);
    if (tags.has(item.ollamaModel)) throw new Error(`duplicate Ollama model: ${item.ollamaModel}`);
    tags.add(item.ollamaModel);
    if (item.storageGB <= 0) throw new Error(`${item.id}.storageGB must be positive`);
    if (item.recommendedMemoryGB < item.minimumMemoryGB) throw new Error(`${item.id} has invalid memory limits`);
    if (!item.toolCalling || !item.agenticCoding) throw new Error(`${item.id} is unsuitable for agentic use`);
    models.push(item);
  }
  return { schemaVersion: 1, updated: value.updated, models };
}
