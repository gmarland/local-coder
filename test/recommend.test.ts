import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue } from "../src/catalogue.js";
import { classifyHardware, recommend, withCustomAssignments } from "../src/recommend.js";
import type { HardwareInfo, Preset } from "../src/types.js";

const machine = (memory: number, disk = 500, gpuVramGB?: number): HardwareInfo => ({
  platform: "darwin", osName: "macOS", architecture: "arm64", cpu: "Apple", appleSilicon: "Apple M4",
  totalMemoryGB: memory, availableMemoryGB: memory * .7, diskAvailableGB: disk, gpuVramGB,
  commands: { ollama: true, opencode: true, git: true, rg: true }
});

test("classifies representative Mac memory sizes", () => {
  assert.equal(classifyHardware(machine(16)), "LOW");
  assert.equal(classifyHardware(machine(32)), "MEDIUM");
  assert.equal(classifyHardware(machine(64)), "HIGH");
  assert.equal(classifyHardware(machine(128)), "VERY_HIGH");
});

test("a 16 GB Mac defaults to Qwen 3 instead of unreliable Qwen 2.5 tool calling", async () => {
  const result = recommend((await loadCatalogue()).models, machine(16));
  assert.deepEqual(result.uniqueModels.map(model => model.ollamaModel), ["qwen3:8b"]);
});

test("classifies NVIDIA systems using VRAM as a practical constraint", () => {
  assert.equal(classifyHardware({ ...machine(128, 500, 24), platform: "linux" }), "HIGH");
  assert.equal(classifyHardware({ ...machine(128, 500, 48), platform: "linux" }), "HIGH");
});

test("all presets produce fitting, tool-capable selections", async () => {
  const { models } = await loadCatalogue();
  for (const preset of ["balanced", "quality", "fast", "minimal"] as Preset[]) {
    const result = recommend(models, machine(32), preset);
    for (const selected of Object.values(result.assignments)) {
      assert.equal(selected.toolCalling, true);
      assert.ok(selected.minimumMemoryGB <= 32);
    }
    if (preset === "minimal") assert.equal(result.uniqueModels.length, 1);
  }
});

test("very high tier may use an independent reviewer", async () => {
  const { models } = await loadCatalogue();
  const result = recommend(models, machine(128), "quality");
  assert.notEqual(result.assignments.coder.id, result.assignments.reviewer.id);
});

test("insufficient memory and disk fail clearly", async () => {
  const { models } = await loadCatalogue();
  assert.throws(() => recommend(models, machine(4)), /No catalogue model/);
  assert.throws(() => recommend(models, machine(64, 5)), /No catalogue model/);
});

test("custom role choices are deduplicated for storage", async () => {
  const { models } = await loadCatalogue();
  const base = recommend(models, machine(64));
  const small = models[0];
  const custom = withCustomAssignments(base, { orchestrator: small, coder: small, researcher: small, reviewer: small }, machine(64));
  assert.equal(custom.uniqueModels.length, 1);
  assert.equal(custom.storageGB, small.storageGB);
});

test("recommendations deduplicate by Ollama tag and refresh custom disk warnings", async () => {
  const { models } = await loadCatalogue();
  const duplicate = { ...models[0], id: "alternate-id", quality: models[0].quality + 1 };
  const base = recommend([models[0], duplicate], machine(16, 30));
  assert.equal(base.uniqueModels.length, 1);
  const larger = { ...models[0], id: "manual-large", ollamaModel: "manual:large", storageGB: 28 };
  const custom = withCustomAssignments(base, { orchestrator: larger, coder: larger, researcher: larger, reviewer: larger }, machine(16, 30));
  assert.equal(custom.uniqueModels.length, 1);
  assert.equal(custom.storageGB, 28);
  assert.match(custom.warnings.join(" "), /Models need 28 GB/);
});
