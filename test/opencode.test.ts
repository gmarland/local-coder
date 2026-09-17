import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { loadCatalogue } from "../src/models/catalogue.js";
import { recommend } from "../src/models/recommend.js";
import { applyInstallationPlan, generateConfig, installConfiguration, planInstallation, readExistingConfig } from "../src/opencode/config.js";
import { readSavedRecommendation } from "../src/opencode/saved-state.js";
import { generateAgent } from "../src/opencode/agents.js";
import { contextModelTag, withContextModels } from "../src/opencode/context-models.js";
import { probeOpenCodeEditing, runOpenCode } from "../src/opencode/probe.js";
import { checkOpenCodeStateAccess, repairOpenCodeStateAccess, repairOpenCodeStateCommand } from "../src/opencode/state.js";
import { launchCommand } from "../src/commands/setup.js";
import { roles, type HardwareInfo } from "../src/types.js";

const hardware: HardwareInfo = { platform: "darwin", osName: "macOS", architecture: "arm64", cpu: "M4", totalMemoryGB: 64,
  availableMemoryGB: 48, diskAvailableGB: 500, commands: { ollama: true, opencode: true, git: true, rg: true } };
const execFileAsync = promisify(execFile);

test("configuration generation preserves unrelated settings and providers", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const generated = generateConfig({ mcp: { docs: { type: "local" } }, provider: { custom: { models: {} } }, instructions: ["RULES.md"] }, setup);
  assert.deepEqual(generated.mcp, { docs: { type: "local" } });
  assert.ok((generated.provider as Record<string, unknown>).custom);
  assert.ok((generated.provider as Record<string, unknown>).ollama);
  assert.deepEqual(generated.instructions, ["RULES.md", "AGENTS.md"]);
  assert.equal(generated.default_agent, "orchestrator");
  const ollama = (generated.provider as { ollama: { models: Record<string, { limit: { context: number; output: number } }> } }).ollama;
  assert.deepEqual(ollama.models[setup.assignments.coder.ollamaModel].limit, { context: 32768, output: 8192 });
});

test("context variants keep role assignments consistent and advertise their actual target", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const configured = withContextModels(setup);
  const source = setup.assignments.coder;
  assert.equal(configured.assignments.coder.ollamaModel, contextModelTag(source));
  assert.equal(configured.assignments.coder.contextWindow, 32768);
  assert.equal(configured.uniqueModels.length, setup.uniqueModels.length);
  assert.equal(setup.assignments.coder.ollamaModel, source.ollamaModel);
  const config = generateConfig({}, configured);
  const models = (config.provider as { ollama: { models: Record<string, { limit: { context: number } }> } }).ollama.models;
  assert.equal(models[contextModelTag(source)].limit.context, 32768);
});

test("orchestrator delegates repository changes and cannot edit or run commands", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const orchestrator = generateAgent("orchestrator", setup);
  assert.match(orchestrator, /coder: allow/);
  assert.match(orchestrator, /explorer: allow/);
  assert.match(orchestrator, /planner: allow/);
  assert.match(orchestrator, /verifier: allow/);
  assert.match(orchestrator, /researcher: allow/);
  assert.match(orchestrator, /reviewer: allow/);
  assert.match(orchestrator, /mode: primary/);
  assert.match(orchestrator, /edit: deny/);
  assert.match(orchestrator, /bash: deny/);
  assert.match(orchestrator, /CALL the agent with the task tool yourself/);
  assert.match(orchestrator, /TRIVIAL:.*coder → verifier/);
  assert.match(orchestrator, /STANDARD:.*explorer → coder → verifier/);
  assert.match(orchestrator, /COMPLEX:.*explorer → planner → coder → verifier → reviewer/);
  assert.match(orchestrator, /DOMAIN:.*explorer and researcher → planner → coder → verifier → reviewer/);
  assert.match(orchestrator, /Do not invoke explorer, planner, researcher, or reviewer merely because they exist/);
  assert.match(orchestrator, /OBJECTIVE, PLAN.*RELEVANT REPOSITORY CONTEXT.*DOMAIN\/RESEARCH CONTEXT.*CONSTRAINTS, EXPECTED VALIDATION/);
  assert.match(orchestrator, /Never reply "use the coder"/);
  assert.match(orchestrator, /Independently read or search affected files/);
  assert.match(orchestrator, /at most TWO coder remediation attempts/);
  assert.match(orchestrator, /Never report success after unresolved verifier failure/);
  assert.match(orchestrator, /ONE coder review remediation pass/);
  assert.match(orchestrator, /Never report success after unresolved verifier failure or solely from coder's words/);
  assert.match(orchestrator, /Pass exactly three arguments: subagent_type, description, and prompt/);
  assert.match(orchestrator, /Never include task_id or any other argument/);
});

test("specialists have the intended edit, shell, and web permissions", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const coder = generateAgent("coder", setup);
  assert.match(coder, /mode: subagent/);
  assert.match(coder, /edit: allow/);
  assert.match(coder, /bash: allow/);
  assert.match(coder, /Implement the delegated request directly in the repository/);
  assert.match(coder, /Never return code for the user to paste/);
  assert.match(coder, /edit, write, or patch tool and check that the tool succeeded/);
  assert.match(coder, /READ the changed file again/);
  assert.match(coder, /git status and git diff/);
  assert.match(coder, /NEVER claim that a file was modified unless/);
  assert.match(coder, /STATUS: SUCCESS or FAILURE/);
  assert.match(coder, /If no editing tool is available or it fails, return STATUS: FAILURE/);
  assert.match(coder, /read tool cannot write a file/);
  for (const role of ["explorer", "planner", "researcher", "reviewer"] as const) {
    const agent = generateAgent(role, setup);
    assert.match(agent, /mode: subagent/);
    assert.match(agent, /edit: deny/);
    assert.match(agent, /bash: deny/);
    assert.match(agent, /task: deny/);
  }
  const verifier = generateAgent("verifier", setup);
  assert.match(verifier, /mode: subagent/);
  assert.match(verifier, /read:\n    "\*": allow/);
  assert.match(verifier, /glob: allow\n  grep: allow\n  list: allow/);
  assert.match(verifier, /bash: allow/);
  assert.match(verifier, /edit: deny/);
  assert.match(verifier, /task: deny/);
  assert.match(verifier, /STATUS: PASS or FAIL/);
  assert.match(generateAgent("explorer", setup), /RELEVANT FILES[\s\S]*EXECUTION FLOW[\s\S]*RISKS/);
  assert.match(generateAgent("planner", setup), /PLAN[\s\S]*VALIDATION[\s\S]*ASSUMPTIONS/);
  assert.match(generateAgent("researcher", setup), /webfetch: allow\n  websearch: allow/);
});

test("headless OpenCode runner closes stdin", async () => {
  const result = await runOpenCode(process.execPath,
    ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('closed'))"],
    { timeout: 5000, maxBuffer: 1024, env: process.env });
  assert.equal(result.stdout, "closed");
});

test("real OpenCode probe requires a filesystem edit, even when the command succeeds", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const run = async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    assert.equal(command, "opencode");
    assert.ok(args.includes("--print-logs"));
    assert.ok(!args.includes("--pure"));
    assert.equal(options.env.OPENCODE_DISABLE_MODELS_FETCH, "1");
    const project = args[args.indexOf("--dir") + 1];
    assert.equal(options.env.npm_config_cache, path.join(project, ".npm-cache"));
    assert.match(await readFile(path.join(project, ".opencode", "agents", "coder.md"), "utf8"), /edit: allow/);
    assert.equal(JSON.parse(await readFile(path.join(project, ".opencode", "opencode.json"), "utf8")).default_agent, "orchestrator");
    return { stdout: '{"type":"text","part":{"text":"Done"}}\n' };
  };
  const writable = async () => ({ ok: true });
  assert.deepEqual(await probeOpenCodeEditing(setup, run, writable), { ok: false, reason: "OpenCode did not create the file" });
  const edited = await probeOpenCodeEditing(setup, async (command, args) => {
    const project = args[args.indexOf("--dir") + 1];
    await writeFile(path.join(project, "probe.txt"), "LOCAL_CODER_EDIT_OK\n");
    return { stdout: "" };
  }, writable);
  assert.deepEqual(edited, { ok: true });
});

test("real OpenCode probe reports the command status and OpenCode stderr", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const writable = async () => ({ ok: true });
  const failed = await probeOpenCodeEditing(setup, async () => {
    throw Object.assign(new Error("Command failed"), { code: 1, stderr: "provider module could not load" });
  }, writable);
  assert.deepEqual(failed, { ok: false, reason: "OpenCode exited with status 1: provider module could not load" });
});

test("OpenCode state preflight reports an unwritable state directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-state-"));
  const file = path.join(root, "not-a-directory");
  await writeFile(file, "blocked");
  const result = await checkOpenCodeStateAccess(root, file);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /OpenCode cannot write/);
});

test("OpenCode state repair only changes the dedicated state directory ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-state-repair-"));
  const commands: string[][] = [];
  const result = await repairOpenCodeStateAccess(async args => { commands.push(args); }, root, undefined, "developer");
  assert.equal(result.ok, true);
  assert.deepEqual(commands, [["chown", "-R", "developer", path.join(root, ".local", "state", "opencode")]]);
  assert.equal(repairOpenCodeStateCommand(path.join(root, ".local", "state", "opencode"), "developer"),
    `sudo chown -R "developer" ${JSON.stringify(path.join(root, ".local", "state", "opencode"))}`);
});

test("launch command targets the repository root when run from bin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-root-"));
  await mkdir(path.join(root, "bin"));
  await execFileAsync("git", ["init", "-q", root]);
  const canonicalRoot = await realpath(root);
  const options = { command: "setup", dryRun: false, yes: true, backup: false, noPull: false, skipValidation: false };
  assert.equal(await launchCommand(options, path.join(root, ".opencode"), path.join(root, "bin")), `opencode ${JSON.stringify(canonicalRoot)}`);
  assert.equal(await launchCommand({ ...options, project: root }, path.join(root, ".opencode"), path.join(root, "bin")), `opencode ${JSON.stringify(root)}`);
});

test("installation backs up and merges existing configuration and agents", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-install-"));
  await mkdir(path.join(destination, "agents"));
  await writeFile(path.join(destination, "opencode.json"), '{ "plugin": ["kept"] }\n');
  await writeFile(path.join(destination, "agents", "coder.md"), "existing\n");
  const result = await installConfiguration(destination, recommend((await loadCatalogue()).models, hardware), { backupExisting: true });
  assert.ok(result.backupPath);
  const config = JSON.parse(await readFile(result.configPath, "utf8"));
  assert.deepEqual(config.plugin, ["kept"]);
  assert.equal(config.default_agent, "orchestrator");
  for (const role of roles)
    assert.match(await readFile(path.join(destination, "agents", `${role}.md`), "utf8"), new RegExp(`model: ollama/`));
  assert.equal((await readdir(path.join(destination, "agents"))).filter(name => name.endsWith(".md")).length, 7);
  assert.ok((await readdir(path.join(destination, "agents"))).some(name => name.startsWith("coder.md.backup-")));
  const state = JSON.parse(await readFile(path.join(destination, "local-coder-state.json"), "utf8"));
  assert.equal(state.version, 2);
  assert.equal(state.assignments.coder.ollamaModel, state.roles.coder);
  for (const role of roles) assert.equal(state.assignments[role].ollamaModel, state.roles[role]);
});

test("installation overwrites generated files without creating backups by default", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-overwrite-"));
  await mkdir(path.join(destination, "agents"));
  await writeFile(path.join(destination, "opencode.json"), '{ "plugin": ["kept"] }\n');
  await writeFile(path.join(destination, "agents", "coder.md"), "existing\n");
  const result = await installConfiguration(destination, recommend((await loadCatalogue()).models, hardware));
  assert.equal(result.backupPath, undefined);
  assert.deepEqual((await readExistingConfig(result.configPath)).plugin, ["kept"]);
  assert.equal((await readdir(destination)).some(name => name.startsWith("opencode.json.backup-")), false);
  assert.equal((await readdir(path.join(destination, "agents"))).some(name => name.startsWith("coder.md.backup-")), false);
});

test("invalid existing config is never overwritten", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-invalid-"));
  const file = path.join(destination, "opencode.json");
  await writeFile(file, "{ invalid");
  await assert.rejects(readExistingConfig(file), /Cannot safely merge/);
  assert.equal(await readFile(file, "utf8"), "{ invalid");
});

test("JSONC with comments and trailing commas is merged in place", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-jsonc-"));
  const file = path.join(destination, "opencode.jsonc");
  await writeFile(file, '{\n  // retain this logical setting\n  "plugin": ["kept"],\n}\n');
  const result = await installConfiguration(destination, recommend((await loadCatalogue()).models, hardware));
  assert.equal(result.configPath, file);
  assert.deepEqual((await readExistingConfig(file)).plugin, ["kept"]);
  assert.equal(result.backupPath, undefined);
});

test("installation plan uses the existing JSONC path and rejects changes after preview", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-plan-"));
  const configPath = path.join(destination, "opencode.jsonc");
  await writeFile(configPath, '{ "plugin": ["original"] }\n');
  const plan = await planInstallation(destination, recommend((await loadCatalogue()).models, hardware));
  assert.equal(plan.configPath, configPath);
  assert.ok(plan.files.some(file => file.path === configPath));
  await writeFile(configPath, '{ "plugin": ["new"] }\n');
  await assert.rejects(applyInstallationPlan(plan), /changed since the setup preview/);
  assert.deepEqual((await readExistingConfig(configPath)).plugin, ["new"]);
});

test("saved version 2 state restores the exact model assignments", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-restore-v2-"));
  const catalogue = await loadCatalogue();
  const original = recommend(catalogue.models, hardware);
  await installConfiguration(destination, original);
  const restored = await readSavedRecommendation(destination, catalogue.models);
  assert.deepEqual(restored.assignments, original.assignments);
  assert.deepEqual(restored.uniqueModels.map(model => model.ollamaModel), original.uniqueModels.map(model => model.ollamaModel));
});

test("legacy state restores catalogue and manual Ollama models", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-restore-v1-"));
  const catalogue = await loadCatalogue();
  const known = catalogue.models[0].ollamaModel;
  await writeFile(path.join(destination, "local-coder-state.json"), JSON.stringify({
    version: 1, configuredAt: new Date().toISOString(), preset: "balanced", tier: "HIGH", storageGB: 1,
    roles: { orchestrator: known, coder: "private-code-model:latest", researcher: known, reviewer: known }
  }));
  const restored = await readSavedRecommendation(destination, catalogue.models);
  assert.equal(restored.assignments.orchestrator.ollamaModel, known);
  assert.equal(restored.assignments.coder.ollamaModel, "private-code-model:latest");
  assert.equal(restored.assignments.coder.contextWindow, 32768);
  assert.equal(restored.assignments.explorer.ollamaModel, known);
  assert.equal(restored.assignments.planner.ollamaModel, known);
  assert.equal(restored.assignments.verifier.ollamaModel, known);
});

test("legacy version 2 snapshots supply models for newly added roles", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-restore-old-v2-"));
  const catalogue = await loadCatalogue();
  const general = catalogue.models[0];
  const coding = catalogue.models[1];
  const legacyRoles = { orchestrator: general.ollamaModel, coder: coding.ollamaModel,
    researcher: general.ollamaModel, reviewer: coding.ollamaModel };
  const assignments = { orchestrator: general, coder: coding, researcher: general, reviewer: coding };
  await writeFile(path.join(destination, "local-coder-state.json"), JSON.stringify({
    version: 2, configuredAt: new Date().toISOString(), preset: "balanced", tier: "HIGH",
    roles: legacyRoles, assignments, storageGB: general.storageGB + coding.storageGB
  }));
  const restored = await readSavedRecommendation(destination, catalogue.models);
  assert.deepEqual(restored.assignments.explorer, general);
  assert.deepEqual(restored.assignments.planner, general);
  assert.deepEqual(restored.assignments.verifier, general);
  const plan = await planInstallation(destination, restored);
  for (const role of roles) assert.ok(plan.files.some(file => file.path.endsWith(`agents/${role}.md`)));
});

test("reinstall mode backs up and replaces an invalid OpenCode config", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-repair-"));
  const file = path.join(destination, "opencode.json");
  await writeFile(file, "{ damaged");
  const result = await installConfiguration(destination, recommend((await loadCatalogue()).models, hardware), { recoverInvalidConfig: true });
  assert.equal(result.recoveredInvalidConfig, true);
  assert.ok(result.backupPath);
  assert.equal(await readFile(result.backupPath!, "utf8"), "{ damaged");
  assert.equal((await readExistingConfig(file)).default_agent, "orchestrator");
});

test("missing or malformed saved state fails with setup guidance", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-missing-state-"));
  await assert.rejects(readSavedRecommendation(destination, []), /run local-coder setup/);
  await writeFile(path.join(destination, "local-coder-state.json"), "not json");
  await assert.rejects(readSavedRecommendation(destination, []), /run local-coder setup/);
  await writeFile(path.join(destination, "local-coder-state.json"), JSON.stringify({
    version: 2, configuredAt: "today", preset: "balanced", tier: "HIGH",
    roles: { orchestrator: "valid:tag", coder: 3, researcher: "valid:tag", reviewer: "valid:tag" }
  }));
  await assert.rejects(readSavedRecommendation(destination, []), /run local-coder setup/);
});
