import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { generateAgent, generalInstructions } from "./agents.js";
import { roles, type Recommendation, type Role, type SavedState } from "../types.js";
import { writeManagedFile } from "../persistence/ownership.js";

export interface InstallResult { configPath: string; backupPath?: string; created: string[]; recoveredInvalidConfig?: boolean }
export interface InstallOptions { recoverInvalidConfig?: boolean; backupExisting?: boolean }
export interface InstallationPlan {
  destination: string;
  configPath: string;
  files: { path: string; content: string; original: string | null }[];
  originalConfig: string | null;
  recoveredInvalidConfig: boolean;
}
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
function parseExistingConfig(content: string, configPath: string): Record<string, unknown> {
  try {
    const errors: ParseError[] = [];
    const result = parse(content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
    if (errors.length) throw new Error(errors.map(e => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(", "));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("top-level value must be an object");
    return result as Record<string, unknown>;
  }
  catch (error) { throw new Error(`Cannot safely merge existing ${configPath}: ${error instanceof Error ? error.message : error}`); }
}
export async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  return existsSync(configPath) ? parseExistingConfig(await readFile(configPath, "utf8"), configPath) : {};
}
function configPathFor(destination: string): string {
  const jsonPath = path.join(destination, "opencode.json");
  const jsoncPath = path.join(destination, "opencode.jsonc");
  if (existsSync(jsonPath) && existsSync(jsoncPath)) throw new Error(`Both ${jsonPath} and ${jsoncPath} exist; remove the ambiguity before configuring.`);
  return existsSync(jsoncPath) ? jsoncPath : jsonPath;
}
export async function planInstallation(destination: string, recommendation: Recommendation, options: InstallOptions = {}): Promise<InstallationPlan> {
  const configPath = configPathFor(destination);
  const originalConfig = existsSync(configPath) ? await readFile(configPath, "utf8") : null;
  let existing: Record<string, unknown> = {};
  let recoveredInvalidConfig = false;
  if (originalConfig !== null) {
    try { existing = parseExistingConfig(originalConfig, configPath); }
    catch (error) {
      if (!options.recoverInvalidConfig) throw error;
      recoveredInvalidConfig = true;
    }
  }
  const state: SavedState = { version: 2, configuredAt: new Date().toISOString(), preset: recommendation.preset, tier: recommendation.tier,
    roles: Object.fromEntries(roles.map(r => [r, recommendation.assignments[r].ollamaModel])) as Record<Role, string>,
    assignments: recommendation.assignments, storageGB: recommendation.storageGB };
  const contents = [
    { path: configPath, content: `${JSON.stringify(generateConfig(existing, recommendation), null, 2)}\n` },
    ...roles.map(role => ({ path: path.join(destination, "agents", `${role}.md`), content: generateAgent(role, recommendation) })),
    { path: path.join(destination, "AGENTS.md"), content: generalInstructions },
    { path: path.join(destination, "local-coder-state.json"), content: `${JSON.stringify(state, null, 2)}\n` }
  ];
  const files = await Promise.all(contents.map(async file => ({ ...file,
    original: file.path === configPath ? originalConfig : existsSync(file.path) ? await readFile(file.path, "utf8") : null })));
  return { destination, configPath, files, originalConfig, recoveredInvalidConfig };
}
export async function applyInstallationPlan(plan: InstallationPlan, options: InstallOptions = {}): Promise<InstallResult> {
  if (configPathFor(plan.destination) !== plan.configPath)
    throw new Error("OpenCode configuration changed since the setup preview; rerun the command to review it.");
  for (const file of plan.files)
    if ((existsSync(file.path) ? await readFile(file.path, "utf8") : null) !== file.original)
      throw new Error(`${file.path} changed since the setup preview; rerun the command to review it.`);
  await mkdir(plan.destination, { recursive: true });
  const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backupPath: string | undefined;
  if (plan.originalConfig !== null && (options.backupExisting || plan.recoveredInvalidConfig)) {
    backupPath = `${plan.configPath}.backup-${backupStamp}`;
    await copyFile(plan.configPath, backupPath);
  }
  const created: string[] = [];
  for (const file of plan.files) {
    if (options.backupExisting && file.path !== plan.configPath && existsSync(file.path))
      await copyFile(file.path, `${file.path}.backup-${backupStamp}`);
    await writeManagedFile(plan.destination, file.path, file.content);
    created.push(file.path);
  }
  return { configPath: plan.configPath, backupPath, created, recoveredInvalidConfig: plan.recoveredInvalidConfig || undefined };
}
export async function installConfiguration(destination: string, recommendation: Recommendation, options: InstallOptions = {}): Promise<InstallResult> {
  return applyInstallationPlan(await planInstallation(destination, recommendation, options), options);
}
