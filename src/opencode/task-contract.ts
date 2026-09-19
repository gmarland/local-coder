import path from "node:path";
import { readFile } from "node:fs/promises";

export type TaskOutcome =
  | { kind: "fileExists"; path: string }
  | { kind: "fileContains"; path: string; value: string }
  | { kind: "fileEquals"; path: string; value: string };

export interface TaskContract {
  request: string;
  targetFiles?: string[];
  protectedLiterals?: string[];
  expectedOutcomes: TaskOutcome[];
  forbiddenOutcomes?: TaskOutcome[];
  preserveUnrelatedContent: boolean;
  validationCommands?: string[];
}

export interface VerificationResult {
  status: "pass" | "fail";
  evidence: string[];
  failures: string[];
  repairInstruction?: string;
}

export interface ValidationCommandResult { ok: boolean; output?: string }
export type ValidationCommandRunner = (command: string) => Promise<ValidationCommandResult>;

interface EvaluatedOutcome { met: boolean; description: string; observed: string }

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
  if (outcome.kind === "fileContains") return `${outcome.path} contains ${JSON.stringify(outcome.value)}`;
  return `${outcome.path} exactly equals ${quoted(outcome.value)}`;
}

async function evaluate(root: string, outcome: TaskOutcome): Promise<EvaluatedOutcome> {
  const actual = await contents(root, outcome.path);
  const description = describe(outcome);
  if (outcome.kind === "fileExists")
    return { met: actual !== undefined, description, observed: actual === undefined ? `${outcome.path} is missing` : `${outcome.path} exists` };
  if (actual === undefined) return { met: false, description, observed: `${outcome.path} is missing` };
  if (outcome.kind === "fileContains")
    return { met: actual.includes(outcome.value), description,
      observed: actual.includes(outcome.value) ? `found ${JSON.stringify(outcome.value)} in ${outcome.path}` : `${outcome.path} does not contain ${JSON.stringify(outcome.value)}` };
  return { met: actual === outcome.value, description,
    observed: actual === outcome.value ? `${outcome.path} exactly matches` : `${outcome.path} instead contains ${quoted(actual)}` };
}

function repairText(contract: TaskContract, failures: string[]): string {
  const lines = ["VERIFICATION FAILED", "", "ORIGINAL REQUEST", contract.request, "", "EXPECTED",
    ...contract.expectedOutcomes.map(outcome => `- ${describe(outcome)}`),
    ...(contract.forbiddenOutcomes || []).map(outcome => `- NOT: ${describe(outcome)}`),
    "", "OBSERVED", ...failures.map(failure => `- ${failure}`)];
  if (contract.protectedLiterals?.length)
    lines.push("", "PROTECTED USER VALUES", ...contract.protectedLiterals.map(value => `- ${value}`));
  lines.push("", "REPAIR", "Correct only the observed discrepancies, then reread the changed content and inspect the diff.");
  if (contract.preserveUnrelatedContent)
    lines.push("Preserve all unrelated and surrounding content. Replace an incorrect literal in place; do not rewrite its section.");
  return lines.join("\n");
}

/**
 * Performs only checks that can be decided without interpreting natural language.
 * Semantic requirements remain the independent verifier agent's responsibility.
 */
export async function verifyTaskContract(
  root: string,
  contract: TaskContract,
  runValidation?: ValidationCommandRunner
): Promise<VerificationResult> {
  const evidence: string[] = [];
  const failures: string[] = [];

  for (const outcome of contract.expectedOutcomes) {
    const result = await evaluate(root, outcome);
    (result.met ? evidence : failures).push(result.met ? result.observed : `Expected ${result.description}; observed: ${result.observed}`);
  }
  for (const outcome of contract.forbiddenOutcomes || []) {
    const result = await evaluate(root, outcome);
    (result.met ? failures : evidence).push(result.met ? `Forbidden outcome is present: ${result.description}` : `Confirmed absent: ${result.description}`);
  }

  if (contract.protectedLiterals?.length && contract.targetFiles?.length) {
    const targetContents = await Promise.all(contract.targetFiles.map(target => contents(root, target)));
    for (const literal of contract.protectedLiterals) {
      const found = targetContents.some(content => content?.includes(literal));
      (found ? evidence : failures).push(found
        ? `Protected literal ${JSON.stringify(literal)} is present in a target file`
        : `Protected literal ${JSON.stringify(literal)} is absent from all target files`);
    }
  }

  for (const command of contract.validationCommands || []) {
    if (!runValidation) {
      failures.push(`Validation command was not run: ${command}`);
      continue;
    }
    const result = await runValidation(command);
    const detail = result.output?.trim() ? `: ${result.output.trim()}` : "";
    (result.ok ? evidence : failures).push(`${result.ok ? "Validation passed" : "Validation failed"}: ${command}${detail}`);
  }

  if (!failures.length) return { status: "pass", evidence, failures };
  return { status: "fail", evidence, failures, repairInstruction: repairText(contract, failures) };
}
