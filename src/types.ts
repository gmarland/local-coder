export const roles = ["orchestrator", "coder", "researcher", "reviewer"] as const;
export type Role = (typeof roles)[number];
export type ModelRole = "orchestrator" | "coding" | "research" | "review";
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
export interface SavedState {
  version: 1; configuredAt: string; preset: Preset; tier: CapabilityTier;
  roles: Record<Role, string>; storageGB: number;
}
