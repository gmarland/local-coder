import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Catalogue, Model } from "./types.js";

export async function loadCatalogue(path = fileURLToPath(new URL("../../catalog/models.json", import.meta.url))): Promise<Catalogue> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("catalogue must be an object");
  const c = value as Partial<Catalogue>;
  if (c.schemaVersion !== 1 || !Array.isArray(c.models) || c.models.length === 0) throw new Error("unsupported or empty model catalogue");
  const ids = new Set<string>();
  for (const item of c.models as Model[]) {
    if (!item.id || !item.name || !item.ollamaModel || !Array.isArray(item.roles)) throw new Error("catalogue contains an invalid model");
    if (ids.has(item.id)) throw new Error(`duplicate catalogue model: ${item.id}`);
    ids.add(item.id);
    for (const key of ["minimumMemoryGB", "recommendedMemoryGB", "storageGB", "contextWindow", "speed", "quality"] as const)
      if (!Number.isFinite(item[key]) || item[key] <= 0) throw new Error(`${item.id}.${key} must be positive`);
    if (item.recommendedMemoryGB < item.minimumMemoryGB) throw new Error(`${item.id} has invalid memory limits`);
    if (!item.toolCalling || !item.agenticCoding) throw new Error(`${item.id} is unsuitable for agentic use`);
  }
  return c as Catalogue;
}
