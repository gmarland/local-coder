import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { detectHardware } from "../hardware.js";
import { compatibleModels, recommend, withCustomAssignments } from "../models/recommend.js";
import { applyInstallationPlan, planInstallation, readExistingConfig } from "../opencode/config.js";
import { installedModelDigests, installedModels, modelAdvertisesTools, ollamaRunning, probeDelegation, probeToolCalling, pullModel, testModel } from "../ollama.js";
import { recordPulled, recordPullIntent, setSelected } from "../persistence/registry.js";
import { roles, type Model, type Preset, type Recommendation } from "../types.js";
import { cancelled, showRecommendation, type Options } from "./common.js";

const execFileAsync = promisify(execFile);
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
function showMachine(h: Awaited<ReturnType<typeof detectHardware>>, r: Recommendation) {
  p.note([h.appleSilicon || h.cpu, `${h.totalMemoryGB} GB ${h.appleSilicon ? "unified " : ""}memory (${h.availableMemoryGB ?? "?"} GB currently available)`,
    h.gpu ? `GPU: ${h.gpu}${h.gpuVramGB ? ` / ${h.gpuVramGB} GB VRAM` : ""}` : "GPU: not detected", `${h.architecture} · ${h.diskAvailableGB} GB disk free`,
    `Tools: Ollama ${h.commands.ollama ? "✓" : "missing"} · OpenCode ${h.commands.opencode ? "✓" : "missing"} · Git ${h.commands.git ? "✓" : "missing"} · ripgrep ${h.commands.rg ? "✓" : "missing"}`, `Capability: ${r.tier}`].join("\n"), "Machine detected");
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
  return withCustomAssignments(base, assignments, h);
}

export async function setup(options: Options, models: Model[], h: Awaited<ReturnType<typeof detectHardware>>, dest: string) {
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
  const plan = await planInstallation(dest, result);
  const before = h.commands.ollama && await ollamaRunning() ? new Set(await installedModels()) : new Set<string>();
  const modelsToPull = result.uniqueModels.filter(m => !before.has(m.ollamaModel));
  const downloadGB = modelsToPull.reduce((sum, model) => sum + model.storageGB, 0);
  if (result.warnings.length) p.note(result.warnings.join("\n"), "Warnings");
  if (downloadGB + 5 > h.diskAvailableGB) throw new Error(`Insufficient disk space: keep at least 5 GB free after the ${downloadGB} GB model download. Choose smaller models or free disk space.`);
  const downloadPlan = options.noPull ? "Will not download models" : modelsToPull.length ? `Will download missing models:\n${modelsToPull.map(m => `  ${m.ollamaModel}  ~${m.storageGB || "?"} GB`).join("\n")}` : "All selected models are already installed";
  p.note(`${downloadPlan}\n\nWill merge and write:\n  ${plan.files.map(file => file.path).join("\n  ")}\n\nNo prompts, source, or hardware data will leave this machine.`, "Ready to configure OpenCode");
  if (options.dryRun) { p.outro("Dry run complete; no changes were made."); return; }
  const managedFiles = plan.files.map(file => file.path);
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
  if (!options.skipValidation && present.has(result.assignments.orchestrator.ollamaModel) && runtimeValid) {
    const delegation = await probeDelegation(result.assignments.orchestrator.ollamaModel);
    runtimeChecks.push(`Orchestrator selects coder via task: ${delegation.ok ? "✓" : `warning (${probeFailure(delegation.reason)})`}`);
    if (!delegation.ok) p.log.warn("The orchestrator model passed structured tool calling but did not delegate a sample file edit to coder. Automatic delegation may be unreliable; consider another orchestrator model.");
  }
  if (options.skipValidation) p.log.warn("Model inference and structured tool-call validation were skipped. Tool execution has not been verified.");
  if (running && result.uniqueModels.every(model => present.has(model.ollamaModel)) && !options.skipValidation && !runtimeValid) {
    p.note(runtimeChecks.join("\n"), "Validation failed");
    p.outro("No configuration changes were written. Rerun local-coder, choose Customise, and select a model that passes structured tool-call validation.");
    process.exitCode = 1;
    return;
  }
  const install = await applyInstallationPlan(plan, { backupExisting });
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
