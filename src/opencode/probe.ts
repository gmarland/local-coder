import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Recommendation } from "../types.js";
import { planInstallation } from "./config.js";
import { checkOpenCodeStateAccess, type StateAccess } from "./state.js";

const execFileAsync = promisify(execFile);
type RunOpenCode = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
type CheckState = () => Promise<StateAccess>;

export interface OpenCodeProbe { ok: boolean; reason?: string }

function toolError(output: string): string | undefined {
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as { part?: { type?: string; state?: { status?: string; error?: string } } };
      if (event.part?.type === "tool" && event.part.state?.status === "error")
        return event.part.state.error?.slice(0, 300) || "an OpenCode tool failed";
    } catch { /* Non-JSON output is not a tool event. */ }
  }
  return undefined;
}

// Use the generated configuration and OpenCode's real tools, including delegation.
// The temporary project is removed even when the agent fails or times out.
export async function probeOpenCodeEditing(recommendation: Recommendation, run: RunOpenCode = execFileAsync, checkState: CheckState = checkOpenCodeStateAccess): Promise<OpenCodeProbe> {
  const state = await checkState();
  if (!state.ok) return state;
  const project = await mkdtemp(path.join(os.tmpdir(), "local-coder-opencode-probe-"));
  try {
    const destination = path.join(project, ".opencode");
    const plan = await planInstallation(destination, recommendation);
    for (const file of plan.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content);
    }
    const target = path.join(project, "probe.txt");
    const prompt = "Create probe.txt in the current project with exactly LOCAL_CODER_EDIT_OK followed by a newline. Delegate the repository edit to coder, then read the file to verify it.";
    let output = "";
    let commandError: unknown;
    try {
      const result = await run("opencode", ["run", "--pure", "--dir", project, "--agent", "orchestrator", "--format", "json", prompt],
        { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
      output = result.stdout;
    } catch (error) {
      commandError = error;
      output = (error as { stdout?: string }).stdout || "";
    }
    const actual = await readFile(target, "utf8").catch(() => undefined);
    if (actual === "LOCAL_CODER_EDIT_OK\n" && !commandError) return { ok: true };
    const reason = toolError(output) || (commandError instanceof Error ? commandError.message : undefined) ||
      (actual === undefined ? "OpenCode did not create the file" : "OpenCode created the wrong file content");
    return { ok: false, reason };
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}
