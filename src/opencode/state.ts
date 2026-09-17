import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface StateAccess { ok: boolean; directory?: string; reason?: string }
type RunSudo = (args: string[]) => Promise<void>;

export function openCodeStateDirectory(home = process.env.HOME, stateHome = process.env.XDG_STATE_HOME): string | undefined {
  if (!home && !stateHome) return undefined;
  return path.join(stateHome || path.join(home!, ".local", "state"), "opencode");
}

export async function checkOpenCodeStateAccess(home = process.env.HOME, stateHome = process.env.XDG_STATE_HOME): Promise<StateAccess> {
  const directory = openCodeStateDirectory(home, stateHome);
  if (!directory) return { ok: false, reason: "HOME or XDG_STATE_HOME is not set" };
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK | constants.X_OK);
    return { ok: true, directory };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, directory, reason: `OpenCode cannot write ${directory}: ${message}` };
  }
}

function runSudo(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`sudo exited with ${code ?? "an unknown status"}`)));
  });
}

export async function repairOpenCodeStateAccess(run: RunSudo = runSudo, home = process.env.HOME, stateHome = process.env.XDG_STATE_HOME, user = os.userInfo().username): Promise<StateAccess> {
  const directory = openCodeStateDirectory(home, stateHome);
  if (!directory) return { ok: false, reason: "HOME or XDG_STATE_HOME is not set" };
  try {
    await run(["chown", "-R", user, directory]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, directory, reason: `Could not repair ${directory}: ${message}` };
  }
  return checkOpenCodeStateAccess(home, stateHome);
}

export function repairOpenCodeStateCommand(directory: string, user = os.userInfo().username): string {
  return `sudo chown -R ${JSON.stringify(user)} ${JSON.stringify(directory)}`;
}
