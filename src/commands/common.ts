import * as p from "@clack/prompts";
import { roles, type Preset, type Recommendation } from "../types.js";

export interface Options { command: string; project?: string; catalog?: string; dryRun: boolean; yes: boolean; backup: boolean; noPull: boolean; skipValidation: boolean; preset?: Preset }
export function cancelled(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (p.isCancel(value)) { p.cancel("No changes were made."); process.exit(0); }
}
export function showRecommendation(r: Recommendation) {
  p.note(roles.map(role => `${role.padEnd(13)} ${r.assignments[role].name}\n${" ".repeat(13)} ${r.assignments[role].notes}`).join("\n\n") + `\n\nEstimated model storage: ${r.storageGB} GB`, `${r.preset.toUpperCase()} setup`);
}
