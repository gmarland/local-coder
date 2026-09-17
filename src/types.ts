export const roles = ["orchestrator", "explorer", "planner", "coder", "verifier", "researcher", "reviewer"] as const;
export type Role = (typeof roles)[number];
export type ModelRole = "orchestrator" | "exploration" | "planning" | "coding" | "verification" | "research" | "review";
export type Preset = "balanced" | "quality" | "fast" | "minimal";
export type CapabilityTier = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export interface Model {
  id: string; name: string; ollamaModel: string; roles: ModelRole[];
  minimumMemoryGB: number; recommendedMemoryGB: number; storageGB: number;
  contextWindow: number; toolCalling: boolean; agenticCoding: boolean;
  speed: number; quality: number; notes: string;
}
export interface Catalogue { schemaVersion: number; updated: string; models: Model[] }
export interface HardwareInfo {
  platform: NodeJS.Platform; osName: string; architecture: string; cpu: string;
  appleSilicon?: string; totalMemoryGB: number; availableMemoryGB?: number;
  gpu?: string; gpuVramGB?: number; diskAvailableGB: number;
  commands: { ollama: boolean; opencode: boolean; git: boolean; rg: boolean };
}
export interface Recommendation {
  tier: CapabilityTier; preset: Preset; assignments: Record<Role, Model>;
  uniqueModels: Model[]; storageGB: number; warnings: string[];
}
interface SavedStateBase {
  configuredAt: string; preset: Preset; tier: CapabilityTier;
  roles: Record<Role, string>; storageGB: number;
}
export interface SavedStateV1 extends Omit<SavedStateBase, "roles"> {
  version: 1;
  roles: Record<"orchestrator" | "coder" | "researcher" | "reviewer", string>;
}
export interface SavedStateV2 extends SavedStateBase {
  version: 2;
  assignments: Record<Role, Model>;
}
export type SavedState = SavedStateV1 | SavedStateV2;
