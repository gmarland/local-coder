import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

export type TaskOutcome =
  | { kind: "fileExists"; path: string }
  | { kind: "fileMissing"; path: string }
  | { kind: "fileContains"; path: string; value: string }
  | { kind: "fileNotContains"; path: string; value: string }
  | { kind: "fileEquals"; path: string; value: string }
  | { kind: "fileHashEquals"; path: string; sha256: string }
  | { kind: "jsonPointerEquals"; path: string; pointer: string; value: unknown };

export interface ProtectedValue {
  value: string;
  rule: "present" | "unchanged";
  paths: string[];
}

export interface ValidationCommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}
export type ValidationCommand = string | ValidationCommandSpec;

export interface TaskContract {
  version?: 2;
  id?: string;
  request: string;
  targetFiles?: string[];
  allowedPaths?: string[];
  /** Legacy shorthand. Prefer protectedValues with an explicit rule and path. */
  protectedLiterals?: string[];
  protectedValues?: ProtectedValue[];
  expectedOutcomes: TaskOutcome[];
  forbiddenOutcomes?: TaskOutcome[];
  preserveUnrelatedContent: boolean;
  requiresTests?: boolean;
  noTestReason?: string;
  validationCommands?: ValidationCommand[];
  maxRepairAttempts?: number;
}

export interface VerificationContext {
  changedPaths?: string[];
  beforeContents?: Record<string, string | undefined>;
}

export interface VerificationResult {
  status: "pass" | "fail";
  evidence: string[];
  failures: string[];
  contractHash: string;
  repairInstruction?: string;
}

export interface ValidationCommandResult { ok: boolean; output?: string }
export type ValidationCommandRunner = (command: ValidationCommand) => Promise<ValidationCommandResult>;
interface EvaluatedOutcome { met: boolean; description: string; observed: string }

function normalizedContract(contract: TaskContract): TaskContract {
  return {
    ...contract,
    version: 2,
    id: contract.id || undefined,
    targetFiles: contract.targetFiles ? [...contract.targetFiles].sort() : undefined,
    allowedPaths: contract.allowedPaths ? [...contract.allowedPaths].sort() : undefined,
    protectedLiterals: contract.protectedLiterals ? [...contract.protectedLiterals].sort() : undefined,
    protectedValues: contract.protectedValues
      ? [...contract.protectedValues].map(item => ({ ...item, paths: [...item.paths].sort() }))
        .sort((a, b) => `${a.rule}:${a.value}`.localeCompare(`${b.rule}:${b.value}`))
      : undefined
  };
}

export function serializeTaskContract(contract: TaskContract): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
    return value;
  };
  return JSON.stringify(canonicalize(normalizedContract(contract)));
}

export function taskContractHash(contract: TaskContract): string {
  return createHash("sha256").update(serializeTaskContract(contract)).digest("hex");
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function validateTaskContract(contract: TaskContract): string[] {
  const failures: string[] = [];
  if (!nonempty(contract.request)) failures.push("request must be non-empty");
  const expected = Array.isArray(contract.expectedOutcomes) ? contract.expectedOutcomes : [];
  if (!expected.length)
    failures.push("at least one expected outcome is required");
  const knownOutcomes = new Set(["fileExists", "fileMissing", "fileContains", "fileNotContains", "fileEquals", "fileHashEquals", "jsonPointerEquals"]);
  for (const outcome of [...expected, ...(Array.isArray(contract.forbiddenOutcomes) ? contract.forbiddenOutcomes : [])]) {
    if (!outcome || typeof outcome !== "object" || !knownOutcomes.has(outcome.kind) || !nonempty(outcome.path))
      failures.push("outcomes require a known kind and repository-relative path");
    else if (["fileContains", "fileNotContains", "fileEquals"].includes(outcome.kind) && !nonempty((outcome as { value?: unknown }).value))
      failures.push(`${outcome.kind} requires a non-empty string value`);
    else if (outcome.kind === "fileHashEquals" && !/^[a-f0-9]{64}$/.test((outcome as { sha256?: string }).sha256 || ""))
      failures.push("fileHashEquals requires a lowercase SHA-256 value");
    else if (outcome.kind === "jsonPointerEquals" && typeof (outcome as { pointer?: unknown }).pointer !== "string")
      failures.push("jsonPointerEquals requires a JSON pointer string");
  }
  for (const field of [contract.targetFiles, contract.allowedPaths, contract.protectedLiterals])
    if (field !== undefined && (!Array.isArray(field) || field.some(value => !nonempty(value))))
      failures.push("path and literal lists must contain non-empty strings");
  if (contract.maxRepairAttempts !== undefined && (!Number.isInteger(contract.maxRepairAttempts) || contract.maxRepairAttempts < 0 || contract.maxRepairAttempts > 5))
    failures.push("maxRepairAttempts must be an integer from 0 to 5");
  if (contract.requiresTests && !contract.validationCommands?.length && !nonempty(contract.noTestReason))
    failures.push("a test command or explicit noTestReason is required");
  if (contract.protectedValues !== undefined && !Array.isArray(contract.protectedValues))
    failures.push("protectedValues must be an array");
  for (const item of Array.isArray(contract.protectedValues) ? contract.protectedValues : []) {
    if (!nonempty(item.value) || !["present", "unchanged"].includes(item.rule) || !Array.isArray(item.paths) || !item.paths.length || item.paths.some(target => !nonempty(target)))
      failures.push("protected values require a value, rule, and at least one path");
  }
  if (contract.validationCommands !== undefined && !Array.isArray(contract.validationCommands))
    failures.push("validationCommands must be an array");
  for (const command of Array.isArray(contract.validationCommands) ? contract.validationCommands : []) {
    if (typeof command !== "string" && (!command || typeof command !== "object" || !nonempty(command.command) ||
        (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string")))))
      failures.push("validation commands require an executable and string argv values");
  }
  return failures;
}

function resolvedTarget(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error(`Task contract path is outside the repository: ${target}`);
  return resolved;
}

async function contents(root: string, target: string): Promise<string | undefined> {
  try { return await readFile(resolvedTarget(root, target), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function quoted(value: string): string {
  const shortened = value.length > 400 ? `${value.slice(0, 397)}...` : value;
  return JSON.stringify(shortened);
}

function describe(outcome: TaskOutcome): string {
  if (outcome.kind === "fileExists") return `${outcome.path} exists`;
  if (outcome.kind === "fileMissing") return `${outcome.path} is absent`;
  if (outcome.kind === "fileContains") return `${outcome.path} contains ${JSON.stringify(outcome.value)}`;
  if (outcome.kind === "fileNotContains") return `${outcome.path} does not contain ${JSON.stringify(outcome.value)}`;
  if (outcome.kind === "fileEquals") return `${outcome.path} exactly equals ${quoted(outcome.value)}`;
  if (outcome.kind === "fileHashEquals") return `${outcome.path} has SHA-256 ${outcome.sha256}`;
  return `${outcome.path} JSON pointer ${outcome.pointer} equals ${JSON.stringify(outcome.value)}`;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split("/").reduce<unknown>((current, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

async function evaluate(root: string, outcome: TaskOutcome): Promise<EvaluatedOutcome> {
  const actual = await contents(root, outcome.path);
  const description = describe(outcome);
  if (outcome.kind === "fileExists")
    return { met: actual !== undefined, description, observed: actual === undefined ? `${outcome.path} is missing` : `${outcome.path} exists` };
  if (outcome.kind === "fileMissing")
    return { met: actual === undefined, description, observed: actual === undefined ? `${outcome.path} is absent` : `${outcome.path} exists` };
  if (actual === undefined) return { met: false, description, observed: `${outcome.path} is missing` };
  if (outcome.kind === "fileContains" || outcome.kind === "fileNotContains") {
    const contains = actual.includes(outcome.value);
    const met = outcome.kind === "fileContains" ? contains : !contains;
    return { met, description, observed: `${outcome.path} ${contains ? "contains" : "does not contain"} ${JSON.stringify(outcome.value)}` };
  }
  if (outcome.kind === "fileHashEquals") {
    const actualHash = createHash("sha256").update(actual).digest("hex");
    return { met: actualHash === outcome.sha256, description, observed: `${outcome.path} has SHA-256 ${actualHash}` };
  }
  if (outcome.kind === "jsonPointerEquals") {
    try {
      const selected = jsonPointer(JSON.parse(actual), outcome.pointer);
      return { met: JSON.stringify(selected) === JSON.stringify(outcome.value), description,
        observed: `${outcome.path} JSON pointer ${outcome.pointer} is ${JSON.stringify(selected)}` };
    } catch (error) {
      return { met: false, description, observed: `${outcome.path} is not valid JSON: ${error instanceof Error ? error.message : error}` };
    }
  }
  return { met: actual === outcome.value, description,
    observed: actual === outcome.value ? `${outcome.path} exactly matches` : `${outcome.path} instead contains ${quoted(actual)}` };
}

function matchesAllowedPath(changed: string, allowed: string): boolean {
  const normalizedChanged = changed.replaceAll("\\", "/");
  const normalizedAllowed = allowed.replaceAll("\\", "/").replace(/\/$/, "");
  return normalizedChanged === normalizedAllowed || normalizedChanged.startsWith(`${normalizedAllowed}/`);
}

function commandText(command: ValidationCommand): string {
  if (typeof command === "string") return command;
  return [command.command, ...(command.args || [])].map(value => JSON.stringify(value)).join(" ");
}

function repairText(contract: TaskContract, failures: string[]): string {
  const lines = ["VERIFICATION FAILED", `CONTRACT_SHA256 ${taskContractHash(contract)}`, "", "ORIGINAL REQUEST", contract.request, "", "EXPECTED",
    ...contract.expectedOutcomes.map(outcome => `- ${describe(outcome)}`),
    ...(contract.forbiddenOutcomes || []).map(outcome => `- NOT: ${describe(outcome)}`),
    "", "OBSERVED", ...failures.map(failure => `- ${failure}`)];
  const protectedValues = [...(contract.protectedLiterals || []), ...(contract.protectedValues || []).map(item => item.value)];
  if (protectedValues.length)
    lines.push("", "PROTECTED USER VALUES", ...protectedValues.map(value => `- ${value}`));
  lines.push("", "REPAIR", "Correct only the observed discrepancies, then reread the changed content and inspect the diff.");
  if (contract.preserveUnrelatedContent)
    lines.push("Preserve all unrelated and surrounding content. Replace an incorrect literal in place; do not rewrite its section.");
  return lines.join("\n");
}

/** Performs deterministic checks. Semantic requirements remain the verifier agent's responsibility. */
export async function verifyTaskContract(
  root: string,
  contract: TaskContract,
  runValidation?: ValidationCommandRunner,
  context: VerificationContext = {}
): Promise<VerificationResult> {
  const evidence: string[] = [];
  const invalid = validateTaskContract(contract).map(failure => `Invalid task contract: ${failure}`);
  if (invalid.length) {
    const contractHash = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
    return { status: "fail", evidence, failures: invalid, contractHash };
  }
  const failures: string[] = [];

  for (const outcome of contract.expectedOutcomes) {
    const result = await evaluate(root, outcome);
    (result.met ? evidence : failures).push(result.met ? result.observed : `Expected ${result.description}; observed: ${result.observed}`);
  }
  for (const outcome of contract.forbiddenOutcomes || []) {
    const result = await evaluate(root, outcome);
    (result.met ? failures : evidence).push(result.met ? `Forbidden outcome is present: ${result.description}` : `Confirmed absent: ${result.description}`);
  }

  if (contract.allowedPaths && context.changedPaths) {
    for (const changed of context.changedPaths) {
      const allowed = contract.allowedPaths.some(candidate => matchesAllowedPath(changed, candidate));
      (allowed ? evidence : failures).push(allowed
        ? `Changed path is in contract scope: ${changed}`
        : `Changed path is outside contract scope: ${changed}`);
    }
  }

  const legacyValues: ProtectedValue[] = (contract.protectedLiterals || []).map(value => ({
    value, rule: "present", paths: contract.targetFiles || []
  }));
  for (const item of [...legacyValues, ...(contract.protectedValues || [])]) {
    const current = await Promise.all(item.paths.map(target => contents(root, target)));
    if (item.rule === "present") {
      const found = current.some(content => content?.includes(item.value));
      (found ? evidence : failures).push(found
        ? `Protected value ${JSON.stringify(item.value)} is present in its required paths`
        : `Protected value ${JSON.stringify(item.value)} is absent from its required paths`);
    } else {
      const before = item.paths.map(target => context.beforeContents?.[target]);
      if (!context.beforeContents) failures.push(`Cannot verify unchanged protected value ${JSON.stringify(item.value)} without baseline contents`);
      else {
        const beforeCount = before.reduce((sum, content) => sum + (content?.split(item.value).length ?? 1) - 1, 0);
        const afterCount = current.reduce((sum, content) => sum + (content?.split(item.value).length ?? 1) - 1, 0);
        (beforeCount === afterCount ? evidence : failures).push(beforeCount === afterCount
          ? `Protected value ${JSON.stringify(item.value)} retained ${afterCount} occurrence(s)`
          : `Protected value ${JSON.stringify(item.value)} changed from ${beforeCount} to ${afterCount} occurrence(s)`);
      }
    }
  }

  for (const command of contract.validationCommands || []) {
    if (!runValidation) {
      failures.push(`Validation command was not run: ${commandText(command)}`);
      continue;
    }
    const result = await runValidation(command);
    const detail = result.output?.trim() ? `: ${result.output.trim()}` : "";
    (result.ok ? evidence : failures).push(`${result.ok ? "Validation passed" : "Validation failed"}: ${commandText(command)}${detail}`);
  }

  const contractHash = taskContractHash(contract);
  if (!failures.length) return { status: "pass", evidence, failures, contractHash };
  return { status: "fail", evidence, failures, contractHash, repairInstruction: repairText(contract, failures) };
}
