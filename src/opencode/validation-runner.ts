import { execFile } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ValidationCommand, ValidationCommandResult, ValidationCommandRunner, ValidationCommandSpec } from "./task-contract.js";

const execFileAsync = promisify(execFile);
const defaultExecutables = new Set(["npm", "npx", "pnpm", "yarn", "bun", "node", "git", "rg", "tsc", "cargo", "go", "pytest"]);
type Execute = (command: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout?: string; stderr?: string }>;

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safeArguments(command: string, args: string[]): boolean {
  const first = args[0] || "";
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    if (first === "test") return true;
    return first === "run" && /^(test|build|lint|typecheck|check)(:|$)/.test(args[1] || "");
  }
  if (command === "npx") return ["tsc", "eslint", "vitest", "jest", "playwright"].includes(first);
  if (command === "node") return first === "--test" || first.startsWith("--test=");
  if (command === "git") return ["status", "diff", "show", "log"].includes(first);
  if (command === "cargo") return ["test", "check", "build", "clippy"].includes(first);
  if (command === "go") return first === "test";
  return true;
}

/** Runs validated argv directly, never through a shell. */
export function createSafeValidationRunner(root: string, execute: Execute = execFileAsync, allowedExecutables = defaultExecutables): ValidationCommandRunner {
  const resolvedRootPromise = realpath(path.resolve(root));
  return async (value: ValidationCommand): Promise<ValidationCommandResult> => {
    const resolvedRoot = await resolvedRootPromise;
    if (typeof value === "string") return { ok: false, output: "Legacy shell-string commands are not executed; use {command,args,cwd,timeoutMs}." };
    const command: ValidationCommandSpec = value;
    if (!allowedExecutables.has(command.command) || path.basename(command.command) !== command.command)
      return { ok: false, output: `Executable is not allowed: ${command.command}` };
    if (!safeArguments(command.command, command.args || []))
      return { ok: false, output: `Command is not a validation operation: ${[command.command, ...(command.args || [])].join(" ")}` };
    const requestedCwd = path.resolve(resolvedRoot, command.cwd || ".");
    if (!withinRoot(resolvedRoot, requestedCwd)) return { ok: false, output: `Validation cwd is outside the repository: ${command.cwd}` };
    let cwd: string;
    try { cwd = await realpath(requestedCwd); }
    catch { return { ok: false, output: `Validation cwd does not exist: ${command.cwd || "."}` }; }
    if (!withinRoot(resolvedRoot, cwd)) return { ok: false, output: `Validation cwd resolves outside the repository: ${command.cwd}` };
    const timeout = Math.min(Math.max(command.timeoutMs ?? 120_000, 1_000), 15 * 60_000);
    try {
      const result = await execute(command.command, command.args || [], { cwd, timeout, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      return { ok: false, output: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n") };
    }
  };
}
