import type { Model } from "../types.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const modelRoles = new Set(["orchestrator", "exploration", "planning", "coding", "verification", "research", "review"]);
const supportStatuses = new Set(["recommended", "experimental"]);
const platforms = new Set(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]);
const reasoningFields = new Set(["reasoning", "reasoning_content", "reasoning_text"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const validOptionalString = (value: unknown, allowed: Set<string>) => value === undefined || typeof value === "string" && allowed.has(value);

export function isModel(value: unknown): value is Model {
  if (!isRecord(value)) return false;
  return nonempty(value.id) && nonempty(value.name) && nonempty(value.ollamaModel) &&
    Array.isArray(value.roles) && value.roles.length > 0 && value.roles.every(role => modelRoles.has(role)) &&
    positive(value.minimumMemoryGB) && positive(value.recommendedMemoryGB) &&
    typeof value.storageGB === "number" && Number.isFinite(value.storageGB) && value.storageGB >= 0 &&
    positive(value.contextWindow) && positive(value.speed) && positive(value.quality) &&
    typeof value.toolCalling === "boolean" && typeof value.agenticCoding === "boolean" &&
    typeof value.notes === "string" &&
    validOptionalString(value.supportStatus, supportStatuses) &&
    (value.platforms === undefined || Array.isArray(value.platforms) && value.platforms.length > 0 && value.platforms.every(platform => typeof platform === "string" && platforms.has(platform))) &&
    (value.minimumOllamaVersion === undefined || typeof value.minimumOllamaVersion === "string" && /^\d+\.\d+\.\d+$/.test(value.minimumOllamaVersion)) &&
    validOptionalString(value.reasoningField, reasoningFields);
}
