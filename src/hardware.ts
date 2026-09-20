import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HardwareInfo } from "./types.js";

const exec = promisify(execFile);
const gb = (bytes: number) => Math.round(bytes / 1024 ** 3 * 10) / 10;
async function output(command: string, args: string[]): Promise<string | undefined> {
  try { return (await exec(command, args, { timeout: 2500 })).stdout.trim(); } catch { return undefined; }
}
async function exists(command: string): Promise<boolean> { return Boolean(await output("sh", ["-c", `command -v ${command}`])); }

export async function detectHardware(cwd = process.cwd()): Promise<HardwareInfo> {
  const platform = process.platform;
  const totalMemoryGB = gb(os.totalmem());
  let cpu = os.cpus()[0]?.model.trim() || "Unknown CPU";
  let appleSilicon: string | undefined;
  let gpu: string | undefined;
  let gpuVramGB: number | undefined;
  let availableMemoryGB = gb(os.freemem());
  if (platform === "darwin") {
    cpu = await output("sysctl", ["-n", "machdep.cpu.brand_string"]) || cpu;
    const chip = await output("system_profiler", ["SPHardwareDataType", "-detailLevel", "mini"]);
    appleSilicon = chip?.match(/Chip:\s*(.+)/)?.[1];
    gpu = appleSilicon;
    const vm = await output("vm_stat", []);
    const page = Number(vm?.match(/page size of (\d+) bytes/)?.[1] || 4096);
    const freePages = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"]
      .reduce((sum, label) => sum + Number(vm?.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || 0), 0);
    if (vm) availableMemoryGB = gb(freePages * page);
  } else if (platform === "linux") {
    const nvidia = await output("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    if (nvidia) {
      const first = nvidia.split("\n")[0];
      const match = first.match(/^(.*),\s*(\d+(?:\.\d+)?)$/);
      gpu = match?.[1].trim() || first;
      gpuVramGB = match ? Math.round(Number(match[2]) / 1024) : undefined;
    }
  }
  let diskAvailableGB = 0;
  const disk = await output("df", ["-Pk", cwd]);
  const fields = disk?.split("\n").at(-1)?.trim().split(/\s+/);
  if (fields && fields.length >= 4) diskAvailableGB = Math.round(Number(fields[3]) / 1024 / 1024 * 10) / 10;
  const [ollama, opencode, git, rg] = await Promise.all([exists("ollama"), exists("opencode"), exists("git"), exists("rg")]);
  const ollamaOutput = ollama ? await output("ollama", ["--version"]) : undefined;
  const ollamaVersion = ollamaOutput?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  return { platform, osName: `${os.type()} ${os.release()}`, architecture: os.arch(), cpu, appleSilicon,
    totalMemoryGB, availableMemoryGB, gpu, gpuVramGB, diskAvailableGB, ollamaVersion, commands: { ollama, opencode, git, rg } };
}
