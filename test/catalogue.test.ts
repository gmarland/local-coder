import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalogue } from "../src/catalogue.js";

test("bundled catalogue parses and has unique agentic models", async () => {
  const catalogue = await loadCatalogue();
  assert.equal(catalogue.schemaVersion, 1);
  assert.ok(catalogue.models.length >= 6);
  assert.equal(new Set(catalogue.models.map(m => m.id)).size, catalogue.models.length);
  assert.ok(catalogue.models.every(m => m.toolCalling && m.agenticCoding));
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
