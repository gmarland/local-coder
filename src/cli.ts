#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { loadCatalogue } from "./catalogue.js";
import { generateAgent, generalInstructions } from "./agents.js";
import { detectHardware } from "./hardware.js";
import { compatibleModels, recommend, withCustomAssignments } from "./recommend.js";
import { installConfiguration, readExistingConfig, readSavedRecommendation } from "./opencode.js";
import { deleteModel, installedModelDigests, installedModels, modelAdvertisesTools, ollamaRunning, probeToolCalling, pullModel, testModel } from "./ollama.js";
import { cleanupFiles, readOwnership } from "./ownership.js";
import { finishUninstall, modelsToDelete, readRegistry, recordPulled, recordPullIntent, setSelected } from "./registry.js";
import { roles, type Model, type Preset, type Recommendation, type Role, type SavedState } from "./types.js";

interface Options { command: string; project?: string; catalog?: string; dryRun: boolean; yes: boolean; backup: boolean; noPull: boolean; skipValidation: boolean; preset?: Preset }
const execFileAsync = promisify(execFile);
const usage = `Usage: local-coder [setup|configure|reinstall|uninstall|status|models] [options]

Options:
  --project [path]       Use <path>/.opencode instead of the global config
  --preset <name>        balanced, quality, fast, or minimal
  --catalog <path>       Use a compatible versioned catalogue file
  --yes                  Use defaults without interactive confirmation
  --backup               Back up existing generated files before overwriting
  --no-pull              Write configuration without downloading models
  --skip-validation      Skip model response smoke tests
  --dry-run              Preview without writing or downloading
  -h, --help             Show this help`;

function parseArgs(argv: string[]): Options {
  const out: Options = { command: "setup", dryRun: false, yes: false, backup: false, noPull: false, skipValidation: false };
  if (argv[0] && !argv[0].startsWith("-")) out.command = argv.shift()!;
  while (argv.length) {
    const arg = argv.shift()!;
    if (arg === "--project") out.project = argv[0] && !argv[0].startsWith("-") ? argv.shift() : ".";
    else if (arg.startsWith("--project=")) out.project = arg.slice(10) || ".";
    else if (arg === "--preset") { const value = argv.shift(); if (!value) throw new Error("--preset requires a value"); out.preset = value as Preset; }
    else if (arg.startsWith("--preset=")) out.preset = arg.slice(9) as Preset;
    else if (arg === "--catalog") { const value = argv.shift(); if (!value) throw new Error("--catalog requires a path"); out.catalog = value; }
    else if (arg.startsWith("--catalog=")) out.catalog = arg.slice(10);
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--backup") out.backup = true;
    else if (arg === "--no-pull") out.noPull = true;
    else if (arg === "--skip-validation") out.skipValidation = true;
    else if (arg === "-h" || arg === "--help") { console.log(usage); process.exit(0); }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["setup", "configure", "reinstall", "uninstall", "status", "models"].includes(out.command)) throw new Error(`Unknown command: ${out.command}`);
  if (out.preset && !["balanced", "quality", "fast", "minimal"].includes(out.preset)) throw new Error(`Unknown preset: ${out.preset}`);
  return out;
}

async function destination(options: Options): Promise<string> {
  if (options.project !== undefined) {
    try { return path.join(await realpath(options.project), ".opencode"); }
    catch (error) {
      if (options.command === "uninstall" && (error as NodeJS.ErrnoException).code === "ENOENT")
        return path.join(path.resolve(options.project), ".opencode");
      throw error;
    }
  }
  if (!process.env.HOME) throw new Error("HOME is not set");
  return path.join(process.env.HOME, ".config", "opencode");
}
async function agentsDiscoverable(destination: string): Promise<boolean> {
  try {
    const cwd = path.basename(destination) === ".opencode" ? path.dirname(destination) : process.cwd();
    const { stdout } = await execFileAsync("opencode", ["agent", "list"], { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return roles.every(role => new RegExp(`(^|\\n)${role} \\(`).test(stdout));
  } catch { return false; }
}
function launchCommand(options: Options, destination: string): string {
  if (options.project !== undefined) return `opencode ${JSON.stringify(path.dirname(destination))}`;
  const cwd = process.cwd();
  const target = path.basename(cwd) === "bin" ? "/absolute/path/to/project" : cwd;
  return `opencode ${JSON.stringify(target)}`;
}
function probeFailure(reason: string | undefined): string {
  if (reason === "missing-tool-call") return "returned the requested call as text instead of structured tool_calls";
  if (reason === "wrong-tool") return "called an unexpected tool";
  if (reason === "wrong-arguments") return "returned malformed tool arguments";
  return "tool-call request failed";
}
function cancelled(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (p.isCancel(value)) { p.cancel("No changes were made."); process.exit(0); }
}
function showMachine(h: Awaited<ReturnType<typeof detectHardware>>, r: Recommendation) {
  p.note([h.appleSilicon || h.cpu, `${h.totalMemoryGB} GB ${h.appleSilicon ? "unified " : ""}memory (${h.availableMemoryGB ?? "?"} GB currently available)`,
    h.gpu ? `GPU: ${h.gpu}${h.gpuVramGB ? ` / ${h.gpuVramGB} GB VRAM` : ""}` : "GPU: not detected", `${h.architecture} · ${h.diskAvailableGB} GB disk free`,
    `Tools: Ollama ${h.commands.ollama ? "✓" : "missing"} · OpenCode ${h.commands.opencode ? "✓" : "missing"} · Git ${h.commands.git ? "✓" : "missing"} · ripgrep ${h.commands.rg ? "✓" : "missing"}`, `Capability: ${r.tier}`].join("\n"), "Machine detected");
}
function showRecommendation(r: Recommendation) {
  p.note(roles.map(role => `${role.padEnd(13)} ${r.assignments[role].name}\n${" ".repeat(13)} ${r.assignments[role].notes}`).join("\n\n") + `\n\nEstimated model storage: ${r.storageGB} GB`, `${r.preset.toUpperCase()} setup`);
}
function manualModel(name: string): Model {
  const tag = name.includes(":") ? name : `${name}:latest`;
  return { id: `manual-${tag}`, name: tag, ollamaModel: tag, roles: ["orchestrator", "coding", "research", "review"], minimumMemoryGB: 1, recommendedMemoryGB: 1, storageGB: 0, contextWindow: 32768, toolCalling: true, agenticCoding: true, speed: 1, quality: 1, notes: "Manually selected; compatibility and storage are unknown." };
}
async function customise(base: Recommendation, models: Model[], h: Awaited<ReturnType<typeof detectHardware>>): Promise<Recommendation> {
  const assignments = { ...base.assignments };
  for (const role of roles) {
    const compatible = compatibleModels(models, h, role);
    const selected = await p.select({ message: `Configure ${role.toUpperCase()}`, initialValue: assignments[role].id,
      options: [...compatible.map(m => ({ value: m.id, label: `${m.name} (~${m.storageGB} GB)`, hint: m.id === assignments[role].id ? "recommended" : m.notes })), { value: "__manual", label: "Enter an Ollama model manually" }] });
    cancelled(selected);
    if (selected === "__manual") {
      const tag = await p.text({ message: `Ollama model tag for ${role}`, placeholder: "model:tag", validate: v => v.trim() ? undefined : "Enter a model tag" });
      cancelled(tag); assignments[role] = manualModel((tag as string).trim());
    } else assignments[role] = compatible.find(m => m.id === selected)!;
  }
  return withCustomAssignments(base, assignments);
}

async function statusCommand(dest: string) {
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
  console.log(`Local AI setup\n\nOllama       ${running ? "running" : "not running"}\nOpenCode     ${configured ? "configured" : "missing"}\n\n${roles.map(r => `${r.padEnd(13)}${state.roles[r]}`).join("\n")}\n\nModels installed: ${installed.length}\nEstimated selection size: ${state.storageGB} GB\nConfig: ${dest}`);
}
async function modelsCommand(models: Model[], h: Awaited<ReturnType<typeof detectHardware>>) {
  const installed = new Set(await installedModels());
  let recommended = new Set<string>();
  try { recommended = new Set(recommend(models, h).uniqueModels.map(m => m.ollamaModel)); } catch { /* no compatible recommendation */ }
  console.log(`MODEL                           STORAGE  MEMORY  INSTALLED  REC  NOTES`);
  for (const m of models) console.log(`${m.ollamaModel.padEnd(31)} ${String(m.storageGB).padStart(5)} GB  ${String(m.recommendedMemoryGB).padStart(4)} GB  ${(installed.has(m.ollamaModel) ? "yes" : "no").padEnd(9)}  ${(recommended.has(m.ollamaModel) ? "yes" : "").padEnd(3)}  ${m.minimumMemoryGB <= h.totalMemoryGB ? m.notes : "Does not fit detected memory"}`);
}
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

async function uninstall(options: Options, dest: string) {
  if (options.preset || options.catalog || options.noPull || options.skipValidation || options.backup)
    throw new Error("uninstall accepts only --project, --yes, and --dry-run");
  const ownership = await readOwnership(dest);
  const registry = await readRegistry();
  const scope = registry.scopes[dest];
  const statePath = path.join(dest, "local-coder-state.json");
  if (!ownership && !scope && !existsSync(statePath)) { console.log(`Local AI setup is not configured in ${dest}`); return; }
  const files = await cleanupFiles(dest, true);
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
  const cleaned = await cleanupFiles(dest);
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

async function reinstall(options: Options, models: Model[], dest: string) {
  if (options.preset || options.noPull || options.skipValidation)
    throw new Error("reinstall restores the saved selection; only --project, --catalog, --yes, and --dry-run apply");
  const result = await readSavedRecommendation(dest, models);
  p.intro("Reinstall OpenCode Configuration");
  showRecommendation(result);
  p.note(`Will rewrite and back up existing files:\n  ${dest}/opencode.json or opencode.jsonc\n  ${path.join(dest, "agents", "{orchestrator,coder,researcher,reviewer}.md")}\n  ${path.join(dest, "AGENTS.md")}\n  ${path.join(dest, "local-coder-state.json")}\n\nInstalled Ollama models will not be downloaded, replaced, tested, or removed.`, "Ready to restore OpenCode");
  if (options.dryRun) { p.outro("Dry run complete; no changes were made."); return; }
  if (!options.yes && !process.stdin.isTTY) throw new Error("Interactive input is unavailable; rerun with --yes");
  if (!options.yes) {
    const proceed = await p.confirm({ message: "Reinstall the saved OpenCode configuration?", initialValue: false });
    cancelled(proceed);
    if (!proceed) { p.cancel("No changes were made."); return; }
  }
  const install = await installConfiguration(dest, result, { recoverInvalidConfig: true, backupExisting: true });
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

async function setup(options: Options, models: Model[], h: Awaited<ReturnType<typeof detectHardware>>, dest: string) {
  let selectedPreset: Preset = options.preset || "balanced";
  let result = recommend(models, h, selectedPreset);
  p.intro("Local AI Developer Setup"); showMachine(h, result); showRecommendation(result);
  let recommendationChanged = false;
  if (!options.yes && !process.stdin.isTTY) throw new Error("Interactive input is unavailable; rerun with --yes and optionally --preset");
  if (!options.yes && !options.preset) {
    const action = await p.select({ message: "Use this configuration?", options: [
      { value: "recommended", label: "Use recommended" }, { value: "custom", label: "Customise" },
      { value: "minimal", label: "Minimal setup", hint: "one model for every role" }, { value: "exit", label: "Exit" }] });
    cancelled(action); if (action === "exit") { p.cancel("No changes were made."); return; }
    if (action === "minimal") { selectedPreset = "minimal"; result = recommend(models, h, selectedPreset); recommendationChanged = true; }
    if (action === "custom") { result = await customise(result, models, h); recommendationChanged = true; }
  }
  if (recommendationChanged) showRecommendation(result);
  const before = h.commands.ollama && await ollamaRunning() ? new Set(await installedModels()) : new Set<string>();
  const modelsToPull = result.uniqueModels.filter(m => !before.has(m.ollamaModel));
  const downloadGB = modelsToPull.reduce((sum, model) => sum + model.storageGB, 0);
  if (result.warnings.length) p.note(result.warnings.join("\n"), "Warnings");
  if (downloadGB + 5 > h.diskAvailableGB) throw new Error(`Insufficient disk space: keep at least 5 GB free after the ${downloadGB} GB model download. Choose smaller models or free disk space.`);
  const downloadPlan = options.noPull ? "Will not download models" : modelsToPull.length ? `Will download missing models:\n${modelsToPull.map(m => `  ${m.ollamaModel}  ~${m.storageGB || "?"} GB`).join("\n")}` : "All selected models are already installed";
  p.note(`${downloadPlan}\n\nWill merge and write:\n  ${path.join(dest, "opencode.json")}\n  ${path.join(dest, "agents", "{orchestrator,coder,researcher,reviewer}.md")}\n  ${path.join(dest, "AGENTS.md")}\n\nNo prompts, source, or hardware data will leave this machine.`, "Ready to configure OpenCode");
  if (options.dryRun) { p.outro("Dry run complete; no changes were made."); return; }
  const managedFiles = [path.join(dest, "opencode.json"), path.join(dest, "opencode.jsonc"), path.join(dest, "AGENTS.md"),
    path.join(dest, "local-coder-state.json"), ...roles.map(role => path.join(dest, "agents", `${role}.md`))];
  let backupExisting = options.backup;
  if (managedFiles.some(existsSync) && !options.yes && !options.backup) {
    const backup = await p.confirm({ message: "Create timestamped backups before overwriting existing OpenCode files?", initialValue: false });
    cancelled(backup); backupExisting = backup === true;
  }
  if (!options.yes) { const proceed = await p.confirm({ message: "Proceed?", initialValue: false }); cancelled(proceed); if (!proceed) { p.cancel("No changes were made."); return; } }
  await setSelected(dest, result.uniqueModels.map(model => model.ollamaModel));
  let running = await ollamaRunning();
  if (!h.commands.ollama) p.log.warn("Ollama is not installed. Install it, then rerun this command to download and validate models.");
  else if (!running) p.log.warn("Ollama is installed but not running. Start it, then run local-coder configure.");
  if (!h.commands.opencode) p.log.warn("OpenCode is not installed. Install it before attempting to launch the configured environment.");
  if (!options.noPull && running) {
    const installed = new Set(await installedModels());
    for (const model of result.uniqueModels) if (!installed.has(model.ollamaModel)) {
      p.log.step(`Downloading ${model.name} (~${model.storageGB || "unknown"} GB)`);
      await recordPullIntent(dest, model.ollamaModel);
      await pullModel(model);
      let digest = "";
      try { digest = (await installedModelDigests()).get(model.ollamaModel) || ""; }
      catch { p.log.warn(`Could not read the digest for ${model.ollamaModel}; uninstall will keep it for manual review.`); }
      await recordPulled(dest, model.ollamaModel, digest);
    }
  }
  running = await ollamaRunning();
  const present = new Set(await installedModels());
  const runtimeChecks: string[] = [`Ollama: ${running ? "✓" : "not running"}`];
  let runtimeValid = running;
  for (const model of result.uniqueModels) {
    const exists = present.has(model.ollamaModel);
    runtimeChecks.push(`${model.name} installed: ${exists ? "✓" : "missing"}`);
    runtimeValid = runtimeValid && exists;
    if (!exists || options.skipValidation) continue;
    const responds = await testModel(model.ollamaModel);
    const advertised = await modelAdvertisesTools(model.ollamaModel);
    const probe = responds && advertised ? await probeToolCalling(model.ollamaModel) : { ok: false, reason: "request-failed" as const };
    runtimeChecks.push(`${model.name} responds: ${responds ? "✓" : "failed"}`);
    runtimeChecks.push(`${model.name} advertises tools: ${advertised ? "✓" : "failed"}`);
    runtimeChecks.push(`${model.name} structured tool call: ${probe.ok ? "✓" : `failed (${probeFailure(probe.reason)})`}`);
    runtimeValid = runtimeValid && responds && advertised && probe.ok;
  }
  if (options.skipValidation) p.log.warn("Model inference and structured tool-call validation were skipped. Tool execution has not been verified.");
  if (running && result.uniqueModels.every(model => present.has(model.ollamaModel)) && !options.skipValidation && !runtimeValid) {
    p.note(runtimeChecks.join("\n"), "Validation failed");
    p.outro("No configuration changes were written. Rerun local-coder, choose Customise, and select a model that passes structured tool-call validation.");
    process.exitCode = 1;
    return;
  }
  const install = await installConfiguration(dest, result, { backupExisting });
  if (install.backupPath) p.log.info(`Backed up existing config to ${install.backupPath}`);
  let configValid = false;
  try { await readExistingConfig(install.configPath); configValid = true; } catch { /* reported in validation */ }
  const agentFilesExist = roles.every(role => existsSync(path.join(dest, "agents", `${role}.md`)));
  const agentsValid = agentFilesExist && h.commands.opencode && await agentsDiscoverable(dest);
  const checks: string[] = [`OpenCode config parses: ${configValid ? "✓" : "failed"}`, `Agent definitions loaded by OpenCode: ${agentsValid ? "✓" : "failed"}`, ...runtimeChecks];
  const setupValid = configValid && agentsValid && runtimeValid;
  p.note(checks.join("\n"), "Validation");
  p.outro(setupValid ? `Setup complete. OpenCode edits the project directory passed here:\n\n  ${launchCommand(options, dest)}\n\nConfig: ${install.configPath}` : `Configuration written, but runtime setup is incomplete. Resolve the warnings and rerun:\n\n  local-coder configure\n\nWhen ready, launch OpenCode with an explicit project path.\nConfig: ${install.configPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dest = await destination(options);
  if (options.command === "status") return statusCommand(dest);
  if (options.command === "uninstall") return uninstall(options, dest);
  const catalogue = await loadCatalogue(options.catalog);
  if (options.command === "reinstall") return reinstall(options, catalogue.models, dest);
  const h = await detectHardware();
  if (options.command === "models") return modelsCommand(catalogue.models, h);
  return setup(options, catalogue.models, h, dest);
}
main().catch(error => { console.error(`local-coder: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
