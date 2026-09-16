import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { generateAgent, generalInstructions } from "./agents.js";
import { roles, type CapabilityTier, type Model, type Preset, type Recommendation, type Role, type SavedState } from "./types.js";
import { recordWrite } from "./ownership.js";

export interface InstallResult { configPath: string; backupPath?: string; created: string[]; recoveredInvalidConfig?: boolean }
export interface InstallOptions { recoverInvalidConfig?: boolean; backupExisting?: boolean }
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
export async function installConfiguration(destination: string, recommendation: Recommendation, options: InstallOptions = {}): Promise<InstallResult> {
  await mkdir(destination, { recursive: true });
  const jsonPath = path.join(destination, "opencode.json");
  const jsoncPath = path.join(destination, "opencode.jsonc");
  if (existsSync(jsonPath) && existsSync(jsoncPath)) throw new Error(`Both ${jsonPath} and ${jsoncPath} exist; remove the ambiguity before configuring.`);
  const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  let existing: Record<string, unknown> = {};
  let backupPath: string | undefined;
  let recoveredInvalidConfig = false;
  const backupExisting = options.backupExisting ?? false;
  const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(configPath)) {
    if (backupExisting || options.recoverInvalidConfig) {
      backupPath = `${configPath}.backup-${backupStamp}`;
      await copyFile(configPath, backupPath);
    }
    try { existing = await readExistingConfig(configPath); }
    catch (error) {
      if (!options.recoverInvalidConfig) throw error;
      recoveredInvalidConfig = true;
    }
  }
  const created: string[] = [];
  const atomicWrite = async (target: string, content: string) => {
    await mkdir(path.dirname(target), { recursive: true });
    if (backupExisting && target !== configPath && existsSync(target)) await copyFile(target, `${target}.backup-${backupStamp}`);
    await recordWrite(destination, target, content);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target); created.push(target);
  };
  await atomicWrite(configPath, `${JSON.stringify(generateConfig(existing, recommendation), null, 2)}\n`);
  for (const role of ["orchestrator", "coder", "researcher", "reviewer"] as Role[]) await atomicWrite(path.join(destination, "agents", `${role}.md`), generateAgent(role, recommendation));
  await atomicWrite(path.join(destination, "AGENTS.md"), generalInstructions);
  const state: SavedState = { version: 2, configuredAt: new Date().toISOString(), preset: recommendation.preset, tier: recommendation.tier,
    roles: Object.fromEntries(roles.map(r => [r, recommendation.assignments[r].ollamaModel])) as Record<Role, string>,
    assignments: recommendation.assignments, storageGB: recommendation.storageGB };
  await atomicWrite(path.join(destination, "local-coder-state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return { configPath, backupPath, created, recoveredInvalidConfig: recoveredInvalidConfig || undefined };
}

const presets = new Set<Preset>(["balanced", "quality", "fast", "minimal"]);
const tiers = new Set<CapabilityTier>(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);
function fallbackModel(ollamaModel: string): Model {
  return { id: `restored-${ollamaModel}`, name: ollamaModel, ollamaModel,
    roles: ["orchestrator", "coding", "research", "review"], minimumMemoryGB: 1, recommendedMemoryGB: 1,
    storageGB: 0, contextWindow: 32768, toolCalling: true, agenticCoding: true, speed: 1, quality: 1,
    notes: "Restored from saved local-coder state." };
}
function validModel(value: unknown): value is Model {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<Model>;
  const positiveNumbers = [model.minimumMemoryGB, model.recommendedMemoryGB, model.contextWindow, model.speed, model.quality];
  return typeof model.id === "string" && typeof model.name === "string" && typeof model.ollamaModel === "string" &&
    model.ollamaModel.length > 0 && Array.isArray(model.roles) && model.roles.every(role => ["orchestrator", "coding", "research", "review"].includes(role)) &&
    positiveNumbers.every(number => typeof number === "number" && Number.isFinite(number) && number > 0) &&
    typeof model.storageGB === "number" && Number.isFinite(model.storageGB) && model.storageGB >= 0 &&
    typeof model.toolCalling === "boolean" && typeof model.agenticCoding === "boolean" && typeof model.notes === "string";
}
export async function readSavedRecommendation(destination: string, catalogueModels: Model[]): Promise<Recommendation> {
  const statePath = path.join(destination, "local-coder-state.json");
  let value: unknown;
  try { value = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) {
    const reason = error instanceof Error && "code" in error && error.code === "ENOENT" ? "is missing" : "is invalid";
    throw new Error(`Saved setup state ${reason} at ${statePath}; run local-coder setup to choose a configuration.`);
  }
  if (!value || typeof value !== "object") throw new Error(`Saved setup state is invalid at ${statePath}; run local-coder setup to choose a configuration.`);
  const state = value as Partial<SavedState>;
  if ((state.version !== 1 && state.version !== 2) || !state.preset || !presets.has(state.preset) || !state.tier || !tiers.has(state.tier) ||
      !state.roles || typeof state.roles !== "object")
    throw new Error(`Saved setup state is invalid at ${statePath}; run local-coder setup to choose a configuration.`);
  const assignments = {} as Record<Role, Model>;
  for (const role of roles) {
    const tag = state.roles[role];
    if (typeof tag !== "string" || !tag) throw new Error(`Saved setup state is invalid at ${statePath}; run local-coder setup to choose a configuration.`);
    const snapshot = state.version === 2 ? state.assignments?.[role] : undefined;
    assignments[role] = validModel(snapshot) && snapshot.ollamaModel === tag
      ? snapshot
      : catalogueModels.find(model => model.ollamaModel === tag) ?? fallbackModel(tag);
  }
  const uniqueModels = [...new Map(roles.map(role => [assignments[role].ollamaModel, assignments[role]])).values()];
  const storedSize = typeof state.storageGB === "number" && Number.isFinite(state.storageGB) && state.storageGB >= 0 ? state.storageGB : undefined;
  const storageGB = storedSize ?? Math.round(uniqueModels.reduce((sum, model) => sum + model.storageGB, 0) * 10) / 10;
  return { preset: state.preset, tier: state.tier, assignments, uniqueModels, storageGB, warnings: [] };
}
