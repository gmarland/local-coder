import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalogue } from "../src/models/catalogue.js";

test("bundled catalogue parses and has unique agentic models", async () => {
  const catalogue = await loadCatalogue();
  assert.equal(catalogue.schemaVersion, 2);
  assert.equal(catalogue.models.length, 27);
  assert.equal(new Set(catalogue.models.map(m => m.id)).size, catalogue.models.length);
  assert.ok(catalogue.models.every(m => m.toolCalling && m.agenticCoding));
  assert.deepEqual(catalogue.models.map(model => model.ollamaModel).sort(), [
    "devstral-2:123b", "devstral-small-2:24b", "gemma4:12b", "gemma4:26b", "gemma4:31b",
    "glm-4.7-flash:q4_K_M", "gpt-oss:120b", "gpt-oss:20b", "laguna-s-2.1:q4_K_M",
    "laguna-xs-2.1:q4_K_M", "mistral-medium-3.5:128b", "muse-glimmer:30b",
    "nemotron-3-super:120b", "north-mini-code-1.0:q4_K_M", "ornith:35b", "ornith:9b",
    "qwen3-coder-next:q4_K_M", "qwen3-coder:30b", "qwen3-coder:480b", "qwen3.5:122b",
    "qwen3.5:9b", "qwen3.6:27b-coding", "qwen3.6:35b-coding", "qwen3.8-flash-next:125b-a6b-q4_K_M",
    "qwen3.8:27b", "qwen3:8b", "rnj-1:8b"
  ].sort());
});

test("catalogue parser rejects duplicate entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-coder-catalogue-"));
  const file = path.join(dir, "bad.json");
  const valid = (await loadCatalogue()).models[0];
  await writeFile(file, JSON.stringify({ schemaVersion: 1, updated: "test", models: [valid, valid] }));
  await assert.rejects(loadCatalogue(file), /duplicate/);
});

test("catalogue rejects invalid roles and duplicate Ollama tags", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-coder-catalogue-shape-"));
  const file = path.join(dir, "bad.json");
  const valid = (await loadCatalogue()).models[0];
  await writeFile(file, JSON.stringify({ schemaVersion: 1, updated: "test", models: [{ ...valid, roles: ["unknown"] }] }));
  await assert.rejects(loadCatalogue(file), /invalid model/);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, updated: "test", models: [valid, { ...valid, id: "different-id" }] }));
  await assert.rejects(loadCatalogue(file), /duplicate Ollama model/);
});

test("catalogue validates compatibility metadata and still accepts schema version 1", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-coder-catalogue-metadata-"));
  const file = path.join(dir, "catalogue.json");
  const valid = (await loadCatalogue()).models.find(model => model.id === "qwen3-8b")!;
  await writeFile(file, JSON.stringify({ schemaVersion: 1, updated: "test", models: [valid] }));
  assert.equal((await loadCatalogue(file)).schemaVersion, 1);
  for (const model of [
    { ...valid, supportStatus: "preview" },
    { ...valid, platforms: ["not-an-os"] },
    { ...valid, minimumOllamaVersion: "0.14" },
    { ...valid, reasoningField: "thoughts" }
  ]) {
    await writeFile(file, JSON.stringify({ schemaVersion: 2, updated: "test", models: [model] }));
    await assert.rejects(loadCatalogue(file), /invalid model/);
  }
  await writeFile(file, JSON.stringify({ schemaVersion: 3, updated: "test", models: [valid] }));
  await assert.rejects(loadCatalogue(file), /unsupported/);
});
