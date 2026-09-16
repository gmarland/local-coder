import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as p from "@clack/prompts";
import { loadCatalogue } from "../models/catalogue.js";
import { generateAgent, generalInstructions } from "../opencode/agents.js";
import { readSavedRecommendation } from "../opencode/saved-state.js";
import { deleteModel, installedModelDigests } from "../ollama.js";
import { applyCleanupPlan, planCleanupFiles, readOwnership } from "../persistence/ownership.js";
import { finishUninstall, modelsToDelete, readRegistry } from "../persistence/registry.js";
import { roles, type Recommendation } from "../types.js";
import { cancelled, type Options } from "./common.js";

async function cleanupLegacyFiles(dest: string, dryRun: boolean) {
  const result = { removed: [] as string[], conflicts: [] as string[] };
  let recommendation: Recommendation;
  try { recommendation = await readSavedRecommendation(dest, (await loadCatalogue()).models); }
  catch { result.conflicts.push("legacy state is invalid"); return result; }
  const expected = new Map<string, string>([["AGENTS.md", generalInstructions],
    ...roles.map(role => [`agents/${role}.md`, generateAgent(role, recommendation)] as [string, string])]);
  for (const [relative, content] of expected) {
    const file = path.join(dest, relative);
    if (!existsSync(file)) continue;
    if (await readFile(file, "utf8") !== content) { result.conflicts.push(relative); continue; }
    result.removed.push(relative);
    if (!dryRun) await rm(file);
  }
  return result;
}

export async function uninstall(options: Options, dest: string) {
  if (options.preset || options.catalog || options.noPull || options.skipValidation || options.backup)
    throw new Error("uninstall accepts only --project, --yes, and --dry-run");
  const ownership = await readOwnership(dest);
  const registry = await readRegistry();
  const scope = registry.scopes[dest];
  const statePath = path.join(dest, "local-coder-state.json");
  if (!ownership && !scope && !existsSync(statePath)) { console.log(`Local AI setup is not configured in ${dest}`); return; }
  const filePlan = await planCleanupFiles(dest);
  const files = filePlan.preview;
  const models = modelsToDelete(registry, dest);
  const legacy = !ownership && existsSync(statePath);
  const legacyFiles = legacy ? await cleanupLegacyFiles(dest, true) : { removed: [] as string[], conflicts: [] as string[] };
  p.intro("Uninstall local-coder setup");
  p.note([`Scope: ${dest}`,
    `Remove files: ${[...files.removed, ...legacyFiles.removed].length ? [...files.removed, ...legacyFiles.removed].join(", ") : "none"}`,
    `Restore files: ${files.restored.length ? files.restored.join(", ") : "none"}`,
    `Delete Ollama models: ${models.remove.length ? models.remove.join(", ") : "none"}`,
    `Shared models kept: ${models.shared.length ? models.shared.join(", ") : "none"}`,
    `Conflicts: ${[...files.conflicts, ...legacyFiles.conflicts].length ? [...files.conflicts, ...legacyFiles.conflicts].join(", ") : "none"}`,
    legacy ? "Legacy setup has no ownership record; its models and config cannot be removed safely." : ""].filter(Boolean).join("\n"), "Removal plan");
  if (options.dryRun) { p.outro("Dry run complete; no changes were made."); return; }
  if (!options.yes && !process.stdin.isTTY) throw new Error("Interactive input is unavailable; rerun with --yes");
  if (!options.yes) {
    const proceed = await p.confirm({ message: "Remove this local-coder setup and its owned models?", initialValue: false });
    cancelled(proceed);
    if (!proceed) { p.cancel("No changes were made."); return; }
  }
  const cleaned = await applyCleanupPlan(filePlan);
  const legacyCleaned = legacy ? await cleanupLegacyFiles(dest, false) : { removed: [] as string[], conflicts: [] as string[] };
  const deleted: string[] = [];
  const failed: string[] = [];
  if (models.remove.length) {
    let digests: Map<string, string | null> | undefined;
    try { digests = await installedModelDigests(); }
    catch (error) { p.log.warn(`Could not list Ollama models: ${error instanceof Error ? error.message : error}`); failed.push(...models.remove); }
    if (digests) for (const model of models.remove) {
      const actual = digests.get(model);
      if (actual === undefined) { deleted.push(model); continue; }
      if (registry.managed[model] && registry.managed[model] !== actual) {
        p.log.warn(`Kept ${model}: its digest changed since local-coder pulled it.`); failed.push(model); continue;
      }
      try { await deleteModel(model); deleted.push(model); p.log.info(`Deleted ${model}`); }
      catch (error) { p.log.warn(error instanceof Error ? error.message : String(error)); failed.push(model); }
    }
  }
  await finishUninstall(dest, deleted, failed);
  if (cleaned.conflicts.length || legacyCleaned.conflicts.length || failed.length || legacy) {
    p.log.warn(`Needs manual review: ${[...cleaned.conflicts, ...legacyCleaned.conflicts, ...failed, ...(legacy ? ["legacy configuration and models"] : [])].join(", ")}`);
    process.exitCode = 1;
    p.outro("Uninstall is incomplete; rerun after resolving the reported items.");
  } else p.outro("Local-coder setup removed.");
}

