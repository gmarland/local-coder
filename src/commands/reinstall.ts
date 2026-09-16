import path from "node:path";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { applyInstallationPlan, planInstallation, readExistingConfig } from "../opencode/config.js";
import { readSavedRecommendation } from "../opencode/saved-state.js";
import { roles, type Model } from "../types.js";
import { cancelled, showRecommendation, type Options } from "./common.js";

export async function reinstall(options: Options, models: Model[], dest: string) {
  if (options.preset || options.noPull || options.skipValidation)
    throw new Error("reinstall restores the saved selection; only --project, --catalog, --yes, and --dry-run apply");
  const result = await readSavedRecommendation(dest, models);
  const plan = await planInstallation(dest, result, { recoverInvalidConfig: true, backupExisting: true });
  p.intro("Reinstall OpenCode Configuration");
  showRecommendation(result);
  p.note(`Will rewrite and back up existing files:\n  ${plan.files.map(file => file.path).join("\n  ")}\n\nInstalled Ollama models will not be downloaded, replaced, tested, or removed.`, "Ready to restore OpenCode");
  if (options.dryRun) { p.outro("Dry run complete; no changes were made."); return; }
  if (!options.yes && !process.stdin.isTTY) throw new Error("Interactive input is unavailable; rerun with --yes");
  if (!options.yes) {
    const proceed = await p.confirm({ message: "Reinstall the saved OpenCode configuration?", initialValue: false });
    cancelled(proceed);
    if (!proceed) { p.cancel("No changes were made."); return; }
  }
  const install = await applyInstallationPlan(plan, { recoverInvalidConfig: true, backupExisting: true });
  if (install.backupPath) p.log.info(`Backed up existing config to ${install.backupPath}`);
  if (install.recoveredInvalidConfig) p.log.warn("The existing OpenCode config was invalid, so it was backed up and rebuilt from saved state.");
  const configValid = await readExistingConfig(install.configPath).then(() => true, () => false);
  const agentFilesExist = roles.every(role => existsSync(path.join(dest, "agents", `${role}.md`)));
  p.note([`OpenCode config parses: ${configValid ? "✓" : "failed"}`, `Agent definitions restored: ${agentFilesExist ? "✓" : "failed"}`].join("\n"), "Validation");
  if (!configValid || !agentFilesExist) {
    process.exitCode = 1;
    p.outro("Reinstall finished, but the generated OpenCode configuration did not validate.");
    return;
  }
  p.outro(`OpenCode configuration reinstalled. Ollama models were left unchanged.\nConfig: ${install.configPath}`);
}

