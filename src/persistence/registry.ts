import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./storage.js";

interface Scope { selected: string[]; pulled: string[]; used: string[] }
interface Registry { version: 1; scopes: Record<string, Scope>; managed: Record<string, string> }
export function registryPath(): string {
  const root = process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, ".local", "share"));
  if (!root) throw new Error("HOME or XDG_DATA_HOME is required for model ownership tracking");
  return path.join(root, "local-coder", "registry.json");
}
export async function readRegistry(file = registryPath()): Promise<Registry> {
  if (!existsSync(file)) return { version: 1, scopes: {}, managed: {} };
  const data = JSON.parse(await readFile(file, "utf8")) as Registry;
  if (data.version !== 1 || !data.scopes || !data.managed) throw new Error(`Invalid model registry at ${file}`);
  return data;
}
async function mutate(file: string, change: (registry: Registry) => void): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30000) await rm(lock, { recursive: true, force: true }); }
      catch (staleError) { if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!acquired) throw new Error(`Model registry is busy: ${file}`);
  try {
    const registry = await readRegistry(file);
    change(registry);
    if (!Object.keys(registry.scopes).length && !Object.keys(registry.managed).length) await rm(file, { force: true });
    else {
      await atomicWrite(file, `${JSON.stringify(registry, null, 2)}\n`);
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function setSelected(scope: string, selected: string[], file = registryPath()): Promise<void> {
  await mutate(file, registry => {
    const previous = registry.scopes[scope];
    registry.scopes[scope] = { selected: [...new Set(selected)], pulled: previous?.pulled || [],
      used: [...new Set([...(previous?.used || []), ...selected])] };
  });
}
export async function recordPulled(scope: string, model: string, digest: string, file = registryPath()): Promise<void> {
  await mutate(file, registry => {
    registry.scopes[scope] ??= { selected: [model], pulled: [], used: [model] };
    if (!registry.scopes[scope].pulled.includes(model)) registry.scopes[scope].pulled.push(model);
    registry.scopes[scope].used ??= [model];
    registry.managed[model] = digest;
  });
}
export async function recordPullIntent(scope: string, model: string, file = registryPath()): Promise<void> {
  await mutate(file, registry => {
    registry.scopes[scope] ??= { selected: [model], pulled: [], used: [model] };
    if (!registry.scopes[scope].pulled.includes(model)) registry.scopes[scope].pulled.push(model);
    registry.managed[model] ??= "";
  });
}
export async function discardModelTracking(scope: string, models: string[], file = registryPath()): Promise<void> {
  const discarded = new Set(models);
  await mutate(file, registry => {
    const current = registry.scopes[scope];
    if (current) {
      current.selected = current.selected.filter(model => !discarded.has(model));
      current.pulled = current.pulled.filter(model => !discarded.has(model));
      current.used = current.used.filter(model => !discarded.has(model));
      if (!current.selected.length && !current.pulled.length && !current.used.length) delete registry.scopes[scope];
    }
    for (const model of discarded) {
      const referenced = Object.values(registry.scopes).some(data =>
        [...data.selected, ...data.pulled, ...data.used].includes(model));
      if (!referenced) delete registry.managed[model];
    }
  });
}
export function modelsToDelete(registry: Registry, scope: string): { remove: string[]; shared: string[] } {
  const remove: string[] = []; const shared: string[] = [];
  for (const model of Object.keys(registry.managed)) {
    const current = registry.scopes[scope];
    if (!current || ![...current.selected, ...(current.pulled || []), ...(current.used || [])].includes(model)) continue;
    if (Object.entries(registry.scopes).some(([other, data]) => other !== scope && [...data.selected, ...(data.used || [])].includes(model))) shared.push(model);
    else remove.push(model);
  }
  return { remove, shared };
}
export async function finishUninstall(scope: string, deleted: string[], failed: string[], file = registryPath()): Promise<void> {
  await mutate(file, registry => {
    if (failed.length) registry.scopes[scope] = { selected: failed, pulled: failed, used: failed };
    else delete registry.scopes[scope];
    for (const model of deleted) delete registry.managed[model];
  });
}
