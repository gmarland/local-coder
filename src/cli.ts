#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { loadCatalogue } from "./catalogue.js";
import { detectHardware } from "./hardware.js";
import { compatibleModels, recommend, withCustomAssignments } from "./recommend.js";
import { installConfiguration, readExistingConfig } from "./opencode.js";
import { installedModels, modelAdvertisesTools, ollamaRunning, probeToolCalling, pullModel, testModel } from "./ollama.js";
import { roles, type Model, type Preset, type Recommendation, type Role, type SavedState } from "./types.js";

interface Options { command: string; project?: string; catalog?: string; dryRun: boolean; yes: boolean; noPull: boolean; skipValidation: boolean; preset?: Preset }
const execFileAsync = promisify(execFile);
const usage = `Usage: local-coder [setup|configure|status|models] [options]

Options:
  --project [path]       Use <path>/.opencode instead of the global config
  --preset <name>        balanced, quality, fast, or minimal
  --catalog <path>       Use a compatible versioned catalogue file
  --yes                  Accept recommendations and confirmation (for automation)
  --no-pull              Write configuration without downloading models
  --skip-validation      Skip model response smoke tests
  --dry-run              Detect and recommend without writing or downloading
  -h, --help             Show this help`;

function parseArgs(argv: string[]): Options {
  const out: Options = { command: "setup", dryRun: false, yes: false, noPull: false, skipValidation: false };
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
    else if (arg === "--no-pull") out.noPull = true;
    else if (arg === "--skip-validation") out.skipValidation = true;
    else if (arg === "-h" || arg === "--help") { console.log(usage); process.exit(0); }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["setup", "configure", "status", "models"].includes(out.command)) throw new Error(`Unknown command: ${out.command}`);
  if (out.preset && !["balanced", "quality", "fast", "minimal"].includes(out.preset)) throw new Error(`Unknown preset: ${out.preset}`);
  return out;
}

async function destination(options: Options): Promise<string> {
  if (options.project !== undefined) return path.join(await realpath(options.project), ".opencode");
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
  return { id: `manual-${name}`, name, ollamaModel: name, roles: ["orchestrator", "coding", "research", "review"], minimumMemoryGB: 1, recommendedMemoryGB: 1, storageGB: 0, contextWindow: 32768, toolCalling: true, agenticCoding: true, speed: 1, quality: 1, notes: "Manually selected; compatibility and storage are unknown." };
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
  if (!existsSync(statePath)) { console.log(`Local AI setup is not configured in ${dest}`); return; }
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
  if ((existsSync(path.join(dest, "opencode.json")) || existsSync(path.join(dest, "opencode.jsonc"))) && !options.yes) {
    const merge = await p.confirm({ message: "Existing OpenCode config found. Merge local settings and create timestamped backups?", initialValue: true });
    cancelled(merge); if (!merge) { p.cancel("Existing configuration was left unchanged."); return; }
  }
  if (!options.yes) { const proceed = await p.confirm({ message: "Proceed?", initialValue: false }); cancelled(proceed); if (!proceed) { p.cancel("No changes were made."); return; } }
  let running = await ollamaRunning();
  if (!h.commands.ollama) p.log.warn("Ollama is not installed. Install it, then rerun this command to download and validate models.");
  else if (!running) p.log.warn("Ollama is installed but not running. Start it, then run local-coder configure.");
  if (!h.commands.opencode) p.log.warn("OpenCode is not installed. Install it before attempting to launch the configured environment.");
  if (!options.noPull && running) {
    const installed = new Set(await installedModels());
    for (const model of result.uniqueModels) if (!installed.has(model.ollamaModel)) { p.log.step(`Downloading ${model.name} (~${model.storageGB || "unknown"} GB)`); await pullModel(model); }
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
  const install = await installConfiguration(dest, result);
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
  const [catalogue, h] = await Promise.all([loadCatalogue(options.catalog), detectHardware()]);
  const dest = await destination(options);
  if (options.command === "status") return statusCommand(dest);
  if (options.command === "models") return modelsCommand(catalogue.models, h);
  return setup(options, catalogue.models, h, dest);
}
main().catch(error => { console.error(`local-coder: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
