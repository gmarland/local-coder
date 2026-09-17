import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { recommend } from "../models/recommend.js";
import { detectHardware } from "../hardware.js";
import { installedModels, ollamaRunning } from "../ollama.js";
import { readOwnership } from "../persistence/ownership.js";
import { readRegistry } from "../persistence/registry.js";
import { roles, type Model, type SavedState } from "../types.js";

export async function statusCommand(dest: string) {
  const statePath = path.join(dest, "local-coder-state.json");
  if (!existsSync(statePath)) {
    const pending = await readOwnership(dest);
    if (pending || (await readRegistry()).scopes[dest]) console.log(`Local AI setup has pending uninstall items in ${dest}; run local-coder uninstall --dry-run with the same scope to review them.`);
    else console.log(`Local AI setup is not configured in ${dest}`);
    return;
  }
  const state = JSON.parse(await readFile(statePath, "utf8")) as SavedState;
  const running = await ollamaRunning(); const installed = await installedModels();
  const configured = existsSync(path.join(dest, "opencode.json")) || existsSync(path.join(dest, "opencode.jsonc"));
  const savedRoles = state.roles as Partial<Record<(typeof roles)[number], string>>;
  console.log(`Local AI setup\n\nOllama       ${running ? "running" : "not running"}\nOpenCode     ${configured ? "configured" : "missing"}\n\n${roles.map(r => `${r.padEnd(13)}${savedRoles[r] ?? "not assigned (legacy setup)"}`).join("\n")}\n\nModels installed: ${installed.length}\nEstimated selection size: ${state.storageGB} GB\nConfig: ${dest}`);
}
export async function modelsCommand(models: Model[], h: Awaited<ReturnType<typeof detectHardware>>) {
  const installed = new Set(await installedModels());
  let recommended = new Set<string>();
  try { recommended = new Set(recommend(models, h).uniqueModels.map(m => m.ollamaModel)); } catch { /* no compatible recommendation */ }
  console.log(`MODEL                           STORAGE  MEMORY  INSTALLED  REC  NOTES`);
  for (const m of models) console.log(`${m.ollamaModel.padEnd(31)} ${String(m.storageGB).padStart(5)} GB  ${String(m.recommendedMemoryGB).padStart(4)} GB  ${(installed.has(m.ollamaModel) ? "yes" : "no").padEnd(9)}  ${(recommended.has(m.ollamaModel) ? "yes" : "").padEnd(3)}  ${m.minimumMemoryGB <= h.totalMemoryGB ? m.notes : "Does not fit detected memory"}`);
}
