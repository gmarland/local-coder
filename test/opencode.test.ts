import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalogue } from "../src/catalogue.js";
import { recommend } from "../src/recommend.js";
import { generateConfig, installConfiguration, readExistingConfig } from "../src/opencode.js";
import { generateAgent } from "../src/agents.js";
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
  assert.match(orchestrator, /edit: deny/);
  assert.match(orchestrator, /bash: deny/);
  assert.match(orchestrator, /Every delegation prompt must be self-contained/);
  assert.match(orchestrator, /Delegate every repository modification.*@coder/);
});

test("installation backs up and merges existing configuration and agents", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "local-coder-install-"));
  await mkdir(path.join(destination, "agents"));
  await writeFile(path.join(destination, "opencode.json"), '{ "plugin": ["kept"] }\n');
  await writeFile(path.join(destination, "agents", "coder.md"), "existing\n");
  const result = await installConfiguration(destination, recommend((await loadCatalogue()).models, hardware));
  assert.ok(result.backupPath);
  const config = JSON.parse(await readFile(result.configPath, "utf8"));
  assert.deepEqual(config.plugin, ["kept"]);
  assert.equal(config.default_agent, "orchestrator");
  for (const role of ["orchestrator", "coder", "researcher", "reviewer"])
    assert.match(await readFile(path.join(destination, "agents", `${role}.md`), "utf8"), new RegExp(`model: ollama/`));
  assert.ok((await readdir(path.join(destination, "agents"))).some(name => name.startsWith("coder.md.backup-")));
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
  assert.ok(result.backupPath);
});
