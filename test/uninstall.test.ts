import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupFiles, recordWrite } from "../src/ownership.js";
import { finishUninstall, modelsToDelete, readRegistry, recordPulled, recordPullIntent, setSelected } from "../src/registry.js";
import { installConfiguration } from "../src/opencode.js";
import { loadCatalogue } from "../src/catalogue.js";
import { recommend } from "../src/recommend.js";
import type { HardwareInfo } from "../src/types.js";

const execFileAsync = promisify(execFile);

test("uninstall restores overwritten files and removes files it created", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "local-coder-uninstall-"));
  await mkdir(path.join(dest, "agents"));
  const original = path.join(dest, "AGENTS.md");
  const created = path.join(dest, "agents", "coder.md");
  await writeFile(original, "user rules\n");
  await recordWrite(dest, original, "generated rules\n");
  await writeFile(original, "generated rules\n");
  await recordWrite(dest, created, "generated agent\n");
  await writeFile(created, "generated agent\n");
  const preview = await cleanupFiles(dest, true);
  assert.deepEqual(preview.restored, ["AGENTS.md"]);
  assert.deepEqual(preview.removed, [path.join("agents", "coder.md")]);
  assert.equal(await readFile(original, "utf8"), "generated rules\n");
  await cleanupFiles(dest);
  assert.equal(await readFile(original, "utf8"), "user rules\n");
  await assert.rejects(readFile(created));
});

test("uninstall removes generated config values but keeps later user settings", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "local-coder-merge-"));
  const file = path.join(dest, "opencode.json");
  const before = { mcp: { docs: { type: "local" } }, instructions: ["RULES.md"] };
  const generated = { ...before, default_agent: "orchestrator", instructions: ["RULES.md", "AGENTS.md"],
    provider: { ollama: { models: { "coder:latest": { name: "Coder" } } } } };
  await writeFile(file, `${JSON.stringify(before)}\n`);
  await recordWrite(dest, file, `${JSON.stringify(generated)}\n`);
  await writeFile(file, `${JSON.stringify({ ...generated, plugin: ["user-plugin"], instructions: ["RULES.md", "AGENTS.md", "NEW.md"] })}\n`);
  const result = await cleanupFiles(dest);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ...before, instructions: ["RULES.md", "NEW.md"], plugin: ["user-plugin"] });
});

test("uninstall keeps user additions in a config that local-coder created", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "local-coder-created-config-"));
  const file = path.join(dest, "opencode.json");
  const generated = { default_agent: "orchestrator", instructions: ["AGENTS.md"], provider: { ollama: { models: { "coder:latest": {} } } } };
  await recordWrite(dest, file, `${JSON.stringify(generated)}\n`);
  await writeFile(file, `${JSON.stringify({ ...generated, instructions: ["AGENTS.md", "USER.md"], plugin: ["own"] })}\n`);
  const result = await cleanupFiles(dest);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { instructions: ["USER.md"], plugin: ["own"] });
});

test("uninstall reports changes to generated agent files", async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "local-coder-conflict-"));
  const file = path.join(dest, "AGENTS.md");
  await recordWrite(dest, file, "generated\n");
  await writeFile(file, "edited\n");
  const result = await cleanupFiles(dest);
  assert.deepEqual(result.conflicts, ["AGENTS.md"]);
  assert.equal(await readFile(file, "utf8"), "edited\n");
});

test("model registry keeps shared and preexisting models, then releases managed models", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-coder-registry-"));
  const file = path.join(dir, "registry.json");
  await setSelected("scope-a", ["owned:latest", "preexisting:latest"], file);
  await recordPulled("scope-a", "owned:latest", "digest-1", file);
  await setSelected("scope-b", ["owned:latest"], file);
  assert.deepEqual(modelsToDelete(await readRegistry(file), "scope-a"), { remove: [], shared: ["owned:latest"] });
  await finishUninstall("scope-a", [], [], file);
  await setSelected("scope-b", ["replacement:latest"], file);
  assert.deepEqual(modelsToDelete(await readRegistry(file), "scope-b"), { remove: ["owned:latest"], shared: [] });
  await finishUninstall("scope-b", ["owned:latest"], [], file);
  assert.deepEqual((await readRegistry(file)).managed, {});
  await assert.rejects(readFile(file));
});

test("registry retains previously pulled models after reconfiguration and failed deletion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-coder-history-"));
  const file = path.join(dir, "registry.json");
  await setSelected("scope", ["old:latest"], file);
  await recordPulled("scope", "old:latest", "digest-old", file);
  await setSelected("scope", ["new:latest"], file);
  await recordPulled("scope", "new:latest", "digest-new", file);
  assert.deepEqual(modelsToDelete(await readRegistry(file), "scope").remove, ["old:latest", "new:latest"]);
  await finishUninstall("scope", ["old:latest"], ["new:latest"], file);
  assert.deepEqual(modelsToDelete(await readRegistry(file), "scope").remove, ["new:latest"]);
});

test("pull intent survives interruption before a digest can be recorded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-coder-intent-"));
  const file = path.join(dir, "registry.json");
  await setSelected("scope", ["candidate:latest"], file);
  await recordPullIntent("scope", "candidate:latest", file);
  const registry = await readRegistry(file);
  assert.equal(registry.managed["candidate:latest"], "");
  assert.deepEqual(modelsToDelete(registry, "scope").remove, ["candidate:latest"]);
});

test("CLI previews and uninstalls a project-local setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-cli-uninstall-"));
  const project = path.join(root, "project");
  const dest = path.join(project, ".opencode");
  await mkdir(project);
  const hardware: HardwareInfo = { platform: "darwin", osName: "macOS", architecture: "arm64", cpu: "M4", totalMemoryGB: 64,
    availableMemoryGB: 48, diskAvailableGB: 500, commands: { ollama: true, opencode: true, git: true, rg: true } };
  await installConfiguration(dest, recommend((await loadCatalogue()).models, hardware));
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const env = { ...process.env, XDG_DATA_HOME: path.join(root, "data") };
  await execFileAsync(process.execPath, [cli, "uninstall", "--project", project, "--dry-run"], { env });
  assert.equal((await readFile(path.join(dest, "local-coder-state.json"), "utf8")).includes("configuredAt"), true);
  await execFileAsync(process.execPath, [cli, "uninstall", "--project", project, "--yes"], { env });
  await assert.rejects(readFile(path.join(dest, "local-coder-state.json")));
  await assert.rejects(readFile(path.join(dest, "AGENTS.md")));
  await assert.rejects(readFile(path.join(dest, "local-coder-ownership.json")));
});

test("CLI clears an abandoned scope after its project directory is removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-missing-project-"));
  const project = path.join(root, "project");
  const dest = path.join(project, ".opencode");
  const data = path.join(root, "data");
  await mkdir(project);
  await setSelected(dest, ["preexisting:latest"], path.join(data, "local-coder", "registry.json"));
  await rm(project, { recursive: true });
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  await execFileAsync(process.execPath, [cli, "uninstall", "--project", project, "--yes"],
    { env: { ...process.env, XDG_DATA_HOME: data } });
  assert.deepEqual((await readRegistry(path.join(data, "local-coder", "registry.json"))).scopes, {});
});
