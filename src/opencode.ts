import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { generateAgent, generalInstructions } from "./agents.js";
import type { Recommendation, Role, SavedState } from "./types.js";

export interface InstallResult { configPath: string; backupPath?: string; created: string[] }
export function generateConfig(existing: Record<string, unknown>, recommendation: Recommendation): Record<string, unknown> {
  const existingProviders = typeof existing.provider === "object" && existing.provider ? existing.provider as Record<string, unknown> : {};
  const previousOllama = typeof existingProviders.ollama === "object" && existingProviders.ollama ? existingProviders.ollama as Record<string, unknown> : {};
  const previousModels = typeof previousOllama.models === "object" && previousOllama.models ? previousOllama.models as Record<string, unknown> : {};
  const models = Object.fromEntries(recommendation.uniqueModels.map(m => [m.ollamaModel, { name: `${m.name} (local)`, limit: { context: Math.min(m.contextWindow, 131072), output: 16384 } }]));
  const priorInstructions = Array.isArray(existing.instructions) ? existing.instructions.filter(v => typeof v === "string") : [];
  return { ...existing, $schema: "https://opencode.ai/config.json", share: existing.share ?? "disabled", default_agent: "orchestrator",
    instructions: [...new Set([...priorInstructions, "AGENTS.md"])],
    provider: { ...existingProviders, ollama: { ...previousOllama, npm: "@ai-sdk/openai-compatible", name: "Ollama (local)",
      options: { ...((previousOllama.options as object | undefined) || {}), baseURL: "http://127.0.0.1:11434/v1" }, models: { ...previousModels, ...models } } } };
}
export async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(configPath)) return {};
  try {
    const errors: ParseError[] = [];
    const result = parse(await readFile(configPath, "utf8"), errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
    if (errors.length) throw new Error(errors.map(e => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(", "));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("top-level value must be an object");
    return result as Record<string, unknown>;
  }
  catch (error) { throw new Error(`Cannot safely merge existing ${configPath}: ${error instanceof Error ? error.message : error}`); }
}
export async function installConfiguration(destination: string, recommendation: Recommendation): Promise<InstallResult> {
  await mkdir(destination, { recursive: true });
  const jsonPath = path.join(destination, "opencode.json");
  const jsoncPath = path.join(destination, "opencode.jsonc");
  if (existsSync(jsonPath) && existsSync(jsoncPath)) throw new Error(`Both ${jsonPath} and ${jsoncPath} exist; remove the ambiguity before configuring.`);
  const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const existing = await readExistingConfig(configPath);
  let backupPath: string | undefined;
  if (existsSync(configPath)) { backupPath = `${configPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`; await copyFile(configPath, backupPath); }
  const created: string[] = [];
  const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const atomicWrite = async (target: string, content: string) => {
    await mkdir(path.dirname(target), { recursive: true });
    if (target !== configPath && existsSync(target)) await copyFile(target, `${target}.backup-${backupStamp}`);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target); created.push(target);
  };
  await atomicWrite(configPath, `${JSON.stringify(generateConfig(existing, recommendation), null, 2)}\n`);
  for (const role of ["orchestrator", "coder", "researcher", "reviewer"] as Role[]) await atomicWrite(path.join(destination, "agents", `${role}.md`), generateAgent(role, recommendation));
  await atomicWrite(path.join(destination, "AGENTS.md"), generalInstructions);
  const state: SavedState = { version: 1, configuredAt: new Date().toISOString(), preset: recommendation.preset, tier: recommendation.tier,
    roles: Object.fromEntries((Object.keys(recommendation.assignments) as Role[]).map(r => [r, recommendation.assignments[r].ollamaModel])) as Record<Role, string>, storageGB: recommendation.storageGB };
  await atomicWrite(path.join(destination, "local-coder-state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return { configPath, backupPath, created };
}
