import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue } from "../src/models/catalogue.js";
import { classifyHardware, recommend, withCustomAssignments } from "../src/models/recommend.js";
import { roles, type HardwareInfo, type Preset } from "../src/types.js";

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
    assert.deepEqual(Object.keys(result.assignments), [...roles]);
  }
});

test("lightweight roles favor a smaller model while core roles use stronger models", async () => {
  const { models } = await loadCatalogue();
  const result = recommend(models, machine(64), "balanced");
  assert.ok(result.assignments.explorer.recommendedMemoryGB <= result.assignments.coder.recommendedMemoryGB);
  assert.ok(result.assignments.verifier.recommendedMemoryGB <= result.assignments.planner.recommendedMemoryGB);
  assert.equal(new Set(result.uniqueModels.map(model => model.ollamaModel)).size, result.uniqueModels.length);
});

test("older catalogues still support the added roles through related capabilities", async () => {
  const { models } = await loadCatalogue();
  const old = models.map(model => ({ ...model, roles: model.roles.filter(role => !["exploration", "planning", "verification"].includes(role)) }));
  const result = recommend(old, machine(32));
  assert.ok(result.assignments.explorer.roles.includes("research"));
  assert.ok(result.assignments.planner.roles.includes("orchestrator"));
  assert.ok(result.assignments.verifier.roles.includes("research"));
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
  const custom = withCustomAssignments(base, Object.fromEntries(roles.map(role => [role, small])) as typeof base.assignments, machine(64));
  assert.equal(custom.uniqueModels.length, 1);
  assert.equal(custom.storageGB, small.storageGB);
});

test("recommendations deduplicate by Ollama tag and refresh custom disk warnings", async () => {
  const { models } = await loadCatalogue();
  const duplicate = { ...models[0], id: "alternate-id", quality: models[0].quality + 1 };
  const base = recommend([models[0], duplicate], machine(16, 30));
  assert.equal(base.uniqueModels.length, 1);
  const larger = { ...models[0], id: "manual-large", ollamaModel: "manual:large", storageGB: 28 };
  const custom = withCustomAssignments(base, Object.fromEntries(roles.map(role => [role, larger])) as typeof base.assignments, machine(16, 30));
  assert.equal(custom.uniqueModels.length, 1);
  assert.equal(custom.storageGB, 28);
  assert.match(custom.warnings.join(" "), /Models need 28 GB/);
});

test("recommendation rejects non-agentic and unavailable role fallbacks", async () => {
  const { models } = await loadCatalogue();
  const unsafe = { ...models[0], id: "unsafe", ollamaModel: "unsafe:latest", quality: 100, toolCalling: false };
  const selected = recommend([unsafe, models[0]], machine(16));
  assert.ok(Object.values(selected.assignments).every(model => model.id !== "unsafe"));

  const withoutPlanning = { ...models[0], roles: models[0].roles.filter(role => role !== "planning") };
  const tooLargePlanner = { ...models[1], id: "planner-too-large", ollamaModel: "planner:large", roles: ["planning" as const],
    minimumMemoryGB: 128, recommendedMemoryGB: 128 };
  await assert.doesNotReject(async () => recommend([withoutPlanning], machine(16)));
  assert.throws(() => recommend([withoutPlanning, tooLargePlanner], machine(16)), /No compatible planner model/);
});
