import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalogue } from "../src/models/catalogue.js";
import { recommend } from "../src/models/recommend.js";
import { applyInstallationPlan, generateConfig, installConfiguration, planInstallation, readExistingConfig } from "../src/opencode/config.js";
import { readSavedRecommendation } from "../src/opencode/saved-state.js";
import { generateAgent } from "../src/opencode/agents.js";
import type { HardwareInfo } from "../src/types.js";

const hardware: HardwareInfo = { platform: "darwin", osName: "macOS", architecture: "arm64", cpu: "M4", totalMemoryGB: 64,
  availableMemoryGB: 48, diskAvailableGB: 500, commands: { ollama: true, opencode: true, git: true, rg: true } };

test("configuration generation preserves unrelated settings and providers", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const generated = generateConfig({ mcp: { docs: { type: "local" } }, provider: { custom: { models: {} } }, instructions: ["RULES.md"] }, setup);
  assert.deepEqual(generated.mcp, { docs: { type: "local" } });
  assert.ok((generated.provider as Record<string, unknown>).custom);
  assert.ok((generated.provider as Record<string, unknown>).ollama);
  assert.deepEqual(generated.instructions, ["RULES.md", "AGENTS.md"]);
  assert.equal(generated.default_agent, "orchestrator");
});

test("orchestrator delegates repository changes and cannot edit or run commands", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const orchestrator = generateAgent("orchestrator", setup);
  assert.match(orchestrator, /coder: allow/);
  assert.match(orchestrator, /researcher: allow/);
  assert.match(orchestrator, /reviewer: allow/);
  assert.match(orchestrator, /mode: primary/);
  assert.match(orchestrator, /edit: deny/);
  assert.match(orchestrator, /bash: deny/);
  assert.match(orchestrator, /CALL that agent with the task tool/);
  assert.match(orchestrator, /call task with subagent_type coder/);
  assert.match(orchestrator, /call task with subagent_type researcher/);
  assert.match(orchestrator, /call task with subagent_type reviewer/);
  assert.match(orchestrator, /relevant user request.*constraints.*relevant research.*expected outcome/);
  assert.match(orchestrator, /Never reply "use the coder"/);
});

test("specialists have the intended edit, shell, and web permissions", async () => {
  const setup = recommend((await loadCatalogue()).models, hardware);
  const coder = generateAgent("coder", setup);
  assert.match(coder, /mode: subagent/);
  assert.match(coder, /edit: allow/);
  assert.match(coder, /bash: allow/);
  assert.match(coder, /Implement the delegated request directly in the repository/);
  assert.match(coder, /Never return code for the user to paste/);
  for (const role of ["researcher", "reviewer"] as const) {
    const agent = generateAgent(role, setup);
    assert.match(agent, /mode: subagent/);
    assert.match(agent, /edit: deny/);
    assert.match(agent, /bash: deny/);
    assert.match(agent, /task: deny/);
  }
  assert.match(generateAgent("researcher", setup), /webfetch: allow\n  websearch: allow/);
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
  for (const role of ["orchestrator", "coder", "researcher", "reviewer"])
    assert.match(await readFile(path.join(destination, "agents", `${role}.md`), "utf8"), new RegExp(`model: ollama/`));
  assert.ok((await readdir(path.join(destination, "agents"))).some(name => name.startsWith("coder.md.backup-")));
  const state = JSON.parse(await readFile(path.join(destination, "local-coder-state.json"), "utf8"));
  assert.equal(state.version, 2);
  assert.equal(state.assignments.coder.ollamaModel, state.roles.coder);
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
