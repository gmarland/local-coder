import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { detectHardware } from "../hardware.js";
import { compatibleModels, recommend, withCustomAssignments } from "../models/recommend.js";
import { applyInstallationPlan, configuredContext, planInstallation, readExistingConfig } from "../opencode/config.js";
import { contextModelTag, withContextModels } from "../opencode/context-models.js";
import { probeOpenCodeEditing } from "../opencode/probe.js";
import { checkOpenCodeStateAccess, repairOpenCodeStateAccess, repairOpenCodeStateCommand } from "../opencode/state.js";
import { createContextModel, deleteModel, installedModelDigests, installedModels, loadedModelContext, modelAdvertisesTools, ollamaRunning, probeDelegation, probeRepositoryEditing, probeReviewJudgement, probeToolCalling, probeVerificationJudgement, pullModel, testModel } from "../ollama.js";
import { discardModelTracking, recordPulled, recordPullIntent, setSelected } from "../persistence/registry.js";
import { roles, type Model, type Preset, type Recommendation } from "../types.js";
import { cancelled, showRecommendation, type Options } from "./common.js";

const execFileAsync = promisify(execFile);
async function agentsDiscoverable(destination: string): Promise<boolean> {
  try {
    const cwd = path.basename(destination) === ".opencode" ? path.dirname(destination) : process.cwd();
    const { stdout } = await execFileAsync("opencode", ["agent", "list"], { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENCODE_DISABLE_MODELS_FETCH: "1" } });
    return roles.every(role => new RegExp(`(^|\\n)${role} \\(`).test(stdout));
  } catch { return false; }
}
export async function launchCommand(options: Options, destination: string, cwd = process.cwd()): Promise<string> {
  if (options.project !== undefined) return `opencode ${JSON.stringify(path.dirname(destination))}`;
  let target = cwd;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    if (stdout.trim()) target = stdout.trim();
  } catch { /* A non-git project uses the current directory. */ }
  return `opencode ${JSON.stringify(target)}`;
}
function probeFailure(reason: string | undefined): string {
  if (reason === "missing-tool-call") return "did not complete the required tool actions";
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
  return { id: `manual-${tag}`, name: tag, ollamaModel: tag, roles: ["orchestrator", "exploration", "planning", "coding", "verification", "research", "review"], minimumMemoryGB: 1, recommendedMemoryGB: 1, storageGB: 0, contextWindow: 32768, toolCalling: true, agenticCoding: true, speed: 1, quality: 1, notes: "Manually selected; compatibility and storage are unknown." };
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
  const configured = withContextModels(result);
  const plan = await planInstallation(dest, configured);
  const before = h.commands.ollama && await ollamaRunning() ? new Set(await installedModels()) : new Set<string>();
  const modelsToPull = result.uniqueModels.filter(m => !before.has(m.ollamaModel));
  const downloadGB = modelsToPull.reduce((sum, model) => sum + model.storageGB, 0);
  if (result.warnings.length) p.note(result.warnings.join("\n"), "Warnings");
  if (downloadGB + 5 > h.diskAvailableGB) throw new Error(`Insufficient disk space: keep at least 5 GB free after the ${downloadGB} GB model download. Choose smaller models or free disk space.`);
  const downloadPlan = options.noPull ? "Will not download models" : modelsToPull.length ? `Will download missing models:\n${modelsToPull.map(m => `  ${m.ollamaModel}  ~${m.storageGB || "?"} GB`).join("\n")}` : "All selected models are already installed";
  p.note(`${downloadPlan}\n\nWill create local context variants (sharing the downloaded model weights):\n  ${result.uniqueModels.map(model => `${model.ollamaModel} → ${contextModelTag(model)} (${configuredContext(model)} tokens)`).join("\n  ")}\n\nWill merge and write:\n  ${plan.files.map(file => file.path).join("\n  ")}\n\nNo prompts, source, or hardware data will leave this machine.`, "Ready to configure OpenCode");
  if (options.dryRun) { p.outro("Dry run complete; no changes were made."); return; }
  const managedFiles = plan.files.map(file => file.path);
  let backupExisting = options.backup;
  if (managedFiles.some(existsSync) && !options.yes && !options.backup) {
    const backup = await p.confirm({ message: "Create timestamped backups before overwriting existing OpenCode files?", initialValue: false });
    cancelled(backup); backupExisting = backup === true;
  }
  if (!options.yes) { const proceed = await p.confirm({ message: "Proceed?", initialValue: false }); cancelled(proceed); if (!proceed) { p.cancel("No changes were made."); return; } }
  let running = await ollamaRunning();
  if (!h.commands.ollama) p.log.warn("Ollama is not installed. Install it, then rerun this command to download and validate models.");
  else if (!running) p.log.warn("Ollama is installed but not running. Start it, then run local-coder configure.");
  if (!h.commands.opencode) p.log.warn("OpenCode is not installed. Install it before attempting to launch the configured environment.");
  if (!options.skipValidation && h.commands.opencode) {
    let state = await checkOpenCodeStateAccess();
    if (!state.ok && !options.yes && process.stdin.isTTY) {
      const repair = await p.confirm({ message: "OpenCode cannot write its state directory. Repair its ownership with your administrator password?", initialValue: true });
      cancelled(repair);
      if (repair) {
        p.log.step(`Repairing OpenCode state-directory ownership: ${state.directory}`);
        state = await repairOpenCodeStateAccess();
      }
    }
    if (!state.ok) {
      p.note(state.reason!, "OpenCode cannot run");
      const command = state.directory ? repairOpenCodeStateCommand(state.directory) : undefined;
      p.outro(`No configuration changes were written. Repair the OpenCode state-directory ownership or permissions, then rerun local-coder.${command ? `\n\n  ${command}` : ""}`);
      process.exitCode = 1;
      return;
    }
  }
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
  const createdContextModels = new Map<string, string>();
  const cleanupFailedContextModels = async () => {
    for (const alias of createdContextModels.keys()) {
      try { await deleteModel(alias); p.log.info(`Removed failed setup's context variant ${alias}`); }
      catch (error) { p.log.warn(`Could not remove failed setup's context variant ${alias}: ${error instanceof Error ? error.message : error}`); }
    }
    await discardModelTracking(dest, [...createdContextModels.keys()]);
  };
  if (running) {
    const installed = new Set(await installedModels());
    for (const model of result.uniqueModels) {
      const alias = contextModelTag(model);
      if (installed.has(alias) || !installed.has(model.ollamaModel)) continue;
      p.log.step(`Creating ${alias} with ${configuredContext(model)} token context`);
      try {
        await createContextModel(model.ollamaModel, alias, configuredContext(model));
        const digest = (await installedModelDigests()).get(alias) || "";
        createdContextModels.set(alias, digest);
        installed.add(alias);
      } catch (error) {
        await cleanupFailedContextModels();
        throw error;
      }
    }
  }
  const present = new Set(await installedModels());
  const runtimeChecks: string[] = [`Ollama: ${running ? "✓" : "not running"}`];
  let runtimeValid = running;
  for (const model of configured.uniqueModels) {
    const exists = present.has(model.ollamaModel);
    runtimeChecks.push(`${model.name} installed: ${exists ? "✓" : "missing"}`);
    runtimeValid = runtimeValid && exists;
    if (!exists || options.skipValidation) continue;
    const responds = await testModel(model.ollamaModel);
    const context = responds ? await loadedModelContext(model.ollamaModel) : undefined;
    const required = configuredContext(model);
    const contextValid = context !== undefined && context >= required;
    const advertised = await modelAdvertisesTools(model.ollamaModel);
    const probe = responds && advertised && contextValid ? await probeToolCalling(model.ollamaModel) : { ok: false, reason: "request-failed" as const };
    runtimeChecks.push(`${model.name} responds: ${responds ? "✓" : "failed"}`);
    runtimeChecks.push(`${model.name} Ollama context: ${context === undefined ? "unknown" : context} tokens; OpenCode requires ${required}: ${contextValid ? "✓" : "failed"}`);
    runtimeChecks.push(`${model.name} advertises tools: ${advertised ? "✓" : "failed"}`);
    if (contextValid) runtimeChecks.push(`${model.name} structured tool call: ${probe.ok ? "✓" : `failed (${probeFailure(probe.reason)})`}`);
    runtimeValid = runtimeValid && responds && contextValid && advertised && probe.ok;
  }
  if (!options.skipValidation && present.has(configured.assignments.coder.ollamaModel) && runtimeValid) {
    const editing = await probeRepositoryEditing(configured.assignments.coder.ollamaModel);
    runtimeChecks.push(`Coder changes and re-reads a temporary file: ${editing.ok ? "✓" : `failed (${probeFailure(editing.reason)})`}`);
    runtimeValid = runtimeValid && editing.ok;
  }
  if (!options.skipValidation && present.has(configured.assignments.orchestrator.ollamaModel) && runtimeValid) {
    const delegation = await probeDelegation(configured.assignments.orchestrator.ollamaModel);
    runtimeChecks.push(`Orchestrator selects coder via task: ${delegation.ok ? "✓" : `failed (${probeFailure(delegation.reason)})`}`);
    runtimeValid = runtimeValid && delegation.ok;
  }
  if (!options.skipValidation && present.has(configured.assignments.verifier.ollamaModel) && runtimeValid) {
    const verification = await probeVerificationJudgement(configured.assignments.verifier.ollamaModel);
    runtimeChecks.push(`Verifier rejects a seeded regression: ${verification.ok ? "✓" : `failed (${probeFailure(verification.reason)})`}`);
    runtimeValid = runtimeValid && verification.ok;
  }
  if (!options.skipValidation && present.has(configured.assignments.reviewer.ollamaModel) && runtimeValid) {
    const review = await probeReviewJudgement(configured.assignments.reviewer.ollamaModel);
    runtimeChecks.push(`Reviewer identifies a seeded security defect: ${review.ok ? "✓" : `failed (${probeFailure(review.reason)})`}`);
    runtimeValid = runtimeValid && review.ok;
  }
  if (!options.skipValidation && h.commands.opencode && runtimeValid && configured.uniqueModels.every(model => present.has(model.ollamaModel))) {
    p.log.step("Testing a real OpenCode edit in a temporary project (this may take several minutes)");
    const integration = await probeOpenCodeEditing(configured);
    runtimeChecks.push(`OpenCode delegates and edits a temporary project: ${integration.ok ? "✓" : `failed (${integration.reason})`}`);
    runtimeValid = runtimeValid && integration.ok;
  }
  if (options.skipValidation) p.log.warn("Model inference and structured tool-call validation were skipped. Tool execution has not been verified.");
  if (running && configured.uniqueModels.every(model => present.has(model.ollamaModel)) && !options.skipValidation && !runtimeValid) {
    await cleanupFailedContextModels();
    p.note(runtimeChecks.join("\n"), "Validation failed");
    p.outro("No configuration changes were written. Resolve the failed validation check above, then rerun local-coder. If OpenCode timed out, free memory or choose a faster model.");
    process.exitCode = 1;
    return;
  }
  for (const [alias, digest] of createdContextModels) {
    await recordPullIntent(dest, alias);
    await recordPulled(dest, alias, digest);
  }
  await setSelected(dest, configured.uniqueModels.map(model => model.ollamaModel));
  const install = await applyInstallationPlan(plan, { backupExisting });
  if (install.backupPath) p.log.info(`Backed up existing config to ${install.backupPath}`);
  let configValid = false;
  try { await readExistingConfig(install.configPath); configValid = true; } catch { /* reported in validation */ }
  const agentFilesExist = roles.every(role => existsSync(path.join(dest, "agents", `${role}.md`)));
  const agentsValid = agentFilesExist && h.commands.opencode && await agentsDiscoverable(dest);
  const checks: string[] = [`OpenCode config parses: ${configValid ? "✓" : "failed"}`, `Agent definitions loaded by OpenCode: ${agentsValid ? "✓" : "failed"}`, ...runtimeChecks];
  const setupValid = configValid && agentsValid && runtimeValid;
  p.note(checks.join("\n"), "Validation");
  p.outro(setupValid ? `Setup complete. OpenCode edits the project directory passed here:\n\n  ${await launchCommand(options, dest)}\n\nConfig: ${install.configPath}` : `Configuration written, but runtime setup is incomplete. Resolve the warnings and rerun:\n\n  local-coder configure\n\nWhen ready, launch OpenCode with an explicit project path.\nConfig: ${install.configPath}`);
}
