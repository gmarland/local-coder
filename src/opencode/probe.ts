import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Recommendation } from "../types.js";
import { planInstallation } from "./config.js";
import { checkOpenCodeStateAccess, type StateAccess } from "./state.js";

type RunOpenCode = (command: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr?: string }>;
type CheckState = () => Promise<StateAccess>;

export const runOpenCode: RunOpenCode = (command, args, options) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
  // OpenCode waits for EOF on stdin before starting a fresh headless session.
  child.stdin?.end();
});

interface OpenCodeCommandError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stderr?: string;
  stdout?: string;
}

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

function externalDirectoryError(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = line.match(/evaluated permission=external_directory pattern=(\S+) .*action\.action=ask/);
    if (match) return `OpenCode requested access outside the temporary project: ${match[1]}`;
  }
  return undefined;
}

function recentOutput(output: string): string | undefined {
  const lines = output.trim().split("\n").filter(Boolean);
  if (!lines.length) return undefined;
  const text = lines.slice(-4).join(" ").replace(/\s+/g, " ");
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function commandFailure(error: unknown, output: string): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const command = error as OpenCodeCommandError;
  if (command.killed || command.signal === "SIGTERM") return "OpenCode timed out after 10 minutes";
  const detail = recentOutput(command.stderr || output);
  if (command.code !== undefined)
    return `OpenCode exited with status ${command.code}${detail ? `: ${detail}` : ""}`;
  return detail || error.message;
}

// Use the generated configuration and OpenCode's real tools, including delegation.
// The temporary project is removed even when the agent fails or times out.
export async function probeOpenCodeEditing(recommendation: Recommendation, run: RunOpenCode = runOpenCode, checkState: CheckState = checkOpenCodeStateAccess): Promise<OpenCodeProbe> {
  const state = await checkState();
  if (!state.ok) return state;
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-coder-opencode-probe-")));
  try {
    const destination = path.join(project, ".opencode");
    const plan = await planInstallation(destination, recommendation);
    for (const file of plan.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content);
    }
    const target = path.join(project, "probe.txt");
    await writeFile(target, "LOCAL_CODER_EDIT_PENDING\n");
    const expectedContent = "LOCAL_CODER_EDIT_OK";
    const prompt = `Change the existing file ${JSON.stringify(target)} so its complete contents are exactly ${expectedContent} with no newline or other characters. This is a repository edit: call the task tool with subagent_type coder to make the change. Tell coder to read that exact path, edit the file, and read it again. After coder returns, read the file to verify the result. Do not edit it yourself or reconstruct the temporary directory name.`;
    let output = "";
    let commandError: unknown;
    try {
      // Do not use --pure here. It disables the npm provider module required by
      // the generated Ollama configuration, while a normal OpenCode launch loads it.
      const result = await run("opencode", ["run", "--print-logs", "--dir", project, "--agent", "orchestrator", "--format", "json", prompt],
        { timeout: 600000, maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, OPENCODE_DISABLE_MODELS_FETCH: "1", npm_config_cache: path.join(project, ".npm-cache") } });
      output = `${result.stdout}\n${result.stderr || ""}`;
    } catch (error) {
      commandError = error;
      const command = error as OpenCodeCommandError;
      output = `${command.stdout || ""}\n${command.stderr || ""}`;
    }
    const actual = await readFile(target, "utf8").catch(() => undefined);
    if (actual === expectedContent && !commandError) return { ok: true };
    // The file contents alone do not prove OpenCode completed successfully.
    const failedCommand = commandFailure(commandError, output);
    const reason = (failedCommand && actual === expectedContent
      ? `${failedCommand}; probe.txt was edited, but OpenCode did not complete successfully`
      : failedCommand) || externalDirectoryError(output) || toolError(output) ||
      (actual === undefined ? "OpenCode removed the probe file" : "OpenCode did not edit the probe file correctly");
    return { ok: false, reason };
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}
