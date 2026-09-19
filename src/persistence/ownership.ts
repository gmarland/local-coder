import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { atomicWrite } from "./storage.js";

interface ManagedFile { original: string | null; generated: string; generatedHash: string }
interface Ownership { version: 1; files: Record<string, ManagedFile> }
export interface CleanupResult { restored: string[]; removed: string[]; conflicts: string[] }
interface CleanupAction {
  relative: string;
  entry: ManagedFile;
  current: string | null;
  replacement?: string | null;
}
export interface CleanupPlan { destination: string; actions: CleanupAction[]; preview: CleanupResult }
const ownershipName = "localstack-ownership.json";
const managedPaths = new Set(["opencode.json", "opencode.jsonc", "AGENTS.md", "localstack-state.json", "agents/orchestrator.md", "agents/explorer.md", "agents/planner.md", "agents/coder.md", "agents/verifier.md", "agents/researcher.md", "agents/reviewer.md"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ownPath = (destination: string) => path.join(destination, ownershipName);
async function isSymlink(file: string): Promise<boolean> {
  try { return (await lstat(file)).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function save(destination: string, ownership: Ownership): Promise<void> {
  const target = ownPath(destination);
  await mkdir(destination, { recursive: true });
  await atomicWrite(target, `${JSON.stringify(ownership, null, 2)}\n`);
}
export async function readOwnership(destination: string): Promise<Ownership | undefined> {
  if (!existsSync(ownPath(destination))) return undefined;
  const value = JSON.parse(await readFile(ownPath(destination), "utf8")) as Ownership;
  if (value.version !== 1 || !value.files || typeof value.files !== "object") throw new Error(`Invalid ownership record at ${ownPath(destination)}`);
  for (const [relative, entry] of Object.entries(value.files)) {
    if (!managedPaths.has(relative) || typeof entry.generated !== "string" || typeof entry.generatedHash !== "string" || hash(entry.generated) !== entry.generatedHash ||
        (entry.original !== null && typeof entry.original !== "string")) throw new Error(`Invalid ownership record at ${ownPath(destination)}`);
  }
  return value;
}
export async function recordWrite(destination: string, target: string, content: string): Promise<void> {
  const relative = path.relative(destination, target).split(path.sep).join("/");
  if (!managedPaths.has(relative)) throw new Error(`File is outside the managed set: ${target}`);
  if (await isSymlink(target) || (relative.startsWith("agents/") && await isSymlink(path.join(destination, "agents"))))
    throw new Error(`Cannot manage a symbolic link: ${target}`);
  const ownership = await readOwnership(destination) ?? { version: 1 as const, files: {} };
  const original = relative === "localstack-state.json" ? null :
    relative in ownership.files ? ownership.files[relative].original : existsSync(target) ? await readFile(target, "utf8") : null;
  ownership.files[relative] = { original, generated: content, generatedHash: hash(content) };
  await save(destination, ownership);
}
export async function writeManagedFile(destination: string, target: string, content: string): Promise<void> {
  await recordWrite(destination, target, content);
  await atomicWrite(target, content);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, Json> => !!value && typeof value === "object" && !Array.isArray(value);
const absent = Symbol("absent");
type Value = Json | typeof absent;
function revert(before: Value, generated: Value, current: Value, location: string, conflicts: string[]): Value {
  if (same(before, generated)) return current;
  if (same(current, generated)) return before;
  if (current === absent) return absent;
  if (object(generated) && object(current)) {
    const result: Record<string, Json> = { ...current };
    const old = object(before) ? before : {};
    for (const key of Object.keys(generated)) {
      const next = revert(key in old ? old[key] : absent, generated[key], key in current ? current[key] : absent,
        `${location}.${key}`, conflicts);
      if (next === absent) delete result[key]; else result[key] = next;
    }
    return Object.keys(result).length || before !== absent ? result : absent;
  }
  if (location.endsWith(".instructions") && Array.isArray(current) && Array.isArray(generated) && (Array.isArray(before) || before === absent)) {
    const old = Array.isArray(before) ? before : [];
    const added = generated.filter(value => !old.some(item => same(item, value)));
    return current.filter(value => !added.some(item => same(item, value)));
  }
  conflicts.push(location);
  return current;
}
function parseConfig(content: string): Json {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false }) as Json;
  if (errors.length || !object(value)) throw new Error("Invalid OpenCode config");
  return value;
}

export async function planCleanupFiles(destination: string): Promise<CleanupPlan> {
  const ownership = await readOwnership(destination);
  const preview: CleanupResult = { restored: [], removed: [], conflicts: [] };
  const actions: CleanupAction[] = [];
  if (!ownership) return { destination, actions, preview };
  for (const [relative, entry] of Object.entries(ownership.files)) {
    const target = path.join(destination, relative);
    if (await isSymlink(target) || (relative.startsWith("agents/") && await isSymlink(path.join(destination, "agents")))) {
      preview.conflicts.push(relative); continue;
    }
    if (!existsSync(target) && entry.original === null) {
      actions.push({ relative, entry, current: null });
      continue;
    }
    const current = existsSync(target) ? await readFile(target, "utf8") : null;
    if (current === entry.original) {
      actions.push({ relative, entry, current });
      continue;
    }
    let replacement: string | null;
    if (current === null || hash(current) === entry.generatedHash) replacement = entry.original;
    else if (relative === "opencode.json" || relative === "opencode.jsonc") {
      if (relative === "opencode.jsonc") { preview.conflicts.push(relative); continue; }
      try {
        const conflicts: string[] = [];
        const before = entry.original === null ? absent : parseConfig(entry.original);
        const merged = revert(before, parseConfig(entry.generated), parseConfig(current), relative, conflicts);
        if (conflicts.length) { preview.conflicts.push(...conflicts); continue; }
        replacement = merged === absent ? null : `${JSON.stringify(merged, null, 2)}\n`;
      } catch { preview.conflicts.push(relative); continue; }
    } else { preview.conflicts.push(relative); continue; }
    if (replacement === null) preview.removed.push(relative); else preview.restored.push(relative);
    actions.push({ relative, entry, current, replacement });
  }
  return { destination, actions, preview };
}
export async function applyCleanupPlan(plan: CleanupPlan): Promise<CleanupResult> {
  const { destination } = plan;
  const ownership = await readOwnership(destination);
  const result: CleanupResult = { restored: [], removed: [], conflicts: [...plan.preview.conflicts] };
  if (!ownership) {
    result.conflicts.push(...plan.actions.map(action => action.relative));
    return result;
  }
  for (const action of plan.actions) {
    const { relative, entry, current, replacement } = action;
    const target = path.join(destination, relative);
    if (!same(ownership.files[relative], entry) ||
        await isSymlink(target) || (relative.startsWith("agents/") && await isSymlink(path.join(destination, "agents"))) ||
        (existsSync(target) ? await readFile(target, "utf8") : null) !== current) {
      result.conflicts.push(relative);
      continue;
    }
    if (replacement !== undefined) {
      if (replacement === null) { await rm(target); result.removed.push(relative); }
      else { await atomicWrite(target, replacement); result.restored.push(relative); }
    }
    delete ownership.files[relative];
    await save(destination, ownership);
  }
  if (!Object.keys(ownership.files).length) {
    await rm(ownPath(destination));
    const agents = path.join(destination, "agents");
    if (existsSync(agents) && !(await readdir(agents)).length) await rmdir(agents);
    if (!(await readdir(destination)).length) await rmdir(destination);
  }
  return result;
}
export async function cleanupFiles(destination: string, dryRun = false): Promise<CleanupResult> {
  const plan = await planCleanupFiles(destination);
  return dryRun ? plan.preview : applyCleanupPlan(plan);
}
