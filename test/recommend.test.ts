import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue } from "../src/models/catalogue.js";
import { classifyHardware, compatibleModels, recommend, withCustomAssignments } from "../src/models/recommend.js";
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

test("a 16 GB Mac uses compact current models instead of unreliable Qwen 2.5 tool calling", async () => {
  const result = recommend((await loadCatalogue()).models, machine(16));
  assert.deepEqual(result.uniqueModels.map(model => model.ollamaModel), ["ornith:9b", "qwen3:8b"]);
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
    if (preset === "minimal") {
      assert.equal(result.uniqueModels.length, 1);
      const selected = result.uniqueModels[0];
      assert.ok(roles.every(role => result.assignments[role].id === selected.id));
      assert.deepEqual(selected.roles, ["orchestrator", "exploration", "planning", "coding", "verification", "research", "review"]);
    }
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
  const small = models.find(model => model.id === "qwen3-8b")!;
  const duplicate = { ...small, id: "alternate-id", quality: small.quality + 1 };
  const base = recommend([small, duplicate], machine(16, 30));
  assert.equal(base.uniqueModels.length, 1);
  const larger = { ...small, id: "manual-large", ollamaModel: "manual:large", storageGB: 28 };
  const custom = withCustomAssignments(base, Object.fromEntries(roles.map(role => [role, larger])) as typeof base.assignments, machine(16, 30));
  assert.equal(custom.uniqueModels.length, 1);
  assert.equal(custom.storageGB, 28);
  assert.match(custom.warnings.join(" "), /Models need 28 GB/);
});

test("recommendation rejects non-agentic and unavailable role fallbacks", async () => {
  const { models } = await loadCatalogue();
  const small = models.find(model => model.id === "qwen3-8b")!;
  const unsafe = { ...small, id: "unsafe", ollamaModel: "unsafe:latest", quality: 100, toolCalling: false };
  const selected = recommend([unsafe, small], machine(16));
  assert.ok(Object.values(selected.assignments).every(model => model.id !== "unsafe"));

  const withoutPlanning = { ...small, roles: small.roles.filter(role => role !== "planning") };
  const tooLargePlanner = { ...models[1], id: "planner-too-large", ollamaModel: "planner:large", roles: ["planning" as const],
    minimumMemoryGB: 128, recommendedMemoryGB: 128 };
  await assert.doesNotReject(async () => recommend([withoutPlanning], machine(16)));
  assert.throws(() => recommend([withoutPlanning, tooLargePlanner], machine(16)), /No compatible planner model/);
});

test("compatibility honors platform, Ollama version, and experimental opt-in", async () => {
  const { models } = await loadCatalogue();
  const laguna = models.find(model => model.id === "laguna-xs-2.1")!;
  const glm = models.find(model => model.id === "glm-4.7-flash")!;
  const experimental = models.find(model => model.supportStatus === "experimental")!;
  assert.deepEqual(compatibleModels([laguna], machine(64), "coder"), []);
  assert.deepEqual(compatibleModels([laguna], { ...machine(64), platform: "linux" }, "coder"), [laguna]);
  assert.deepEqual(compatibleModels([glm], { ...machine(64), ollamaVersion: "0.14.2" }, "coder"), []);
  assert.deepEqual(compatibleModels([glm], { ...machine(64), ollamaVersion: "0.14.3" }, "coder"), [glm]);
  assert.deepEqual(compatibleModels([experimental], machine(256), "coder"), []);
  assert.deepEqual(compatibleModels([experimental], machine(256), "coder", { includeExperimental: true }), [experimental]);
});
