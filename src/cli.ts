#!/usr/bin/env node
import path from "node:path";
import { realpath } from "node:fs/promises";
import { loadCatalogue } from "./models/catalogue.js";
import { detectHardware } from "./hardware.js";
import type { Preset } from "./types.js";
import type { Options } from "./commands/common.js";
import { statusCommand, modelsCommand } from "./commands/inspect.js";
import { reinstall } from "./commands/reinstall.js";
import { setup } from "./commands/setup.js";
import { uninstall } from "./commands/uninstall.js";

const usage = `Usage: local-coder [setup|configure|reinstall|uninstall|status|models] [options]

Options:
  --project [path]       Use <path>/.opencode instead of the global config
  --preset <name>        balanced, quality, fast, or minimal
  --catalog <path>       Use a compatible versioned catalogue file
  --yes                  Use defaults without interactive confirmation
  --backup               Back up existing generated files before overwriting
  --no-pull              Write configuration without downloading models
  --skip-validation      Skip model response smoke tests
  --dry-run              Preview without writing or downloading
  -h, --help             Show this help`;

function parseArgs(argv: string[]): Options {
  const out: Options = { command: "setup", dryRun: false, yes: false, backup: false, noPull: false, skipValidation: false };
  if (argv[0] && !argv[0].startsWith("-")) out.command = argv.shift()!;
  while (argv.length) {
    const arg = argv.shift()!;
    if (arg === "--project") out.project = argv[0] && !argv[0].startsWith("-") ? argv.shift() : ".";
    else if (arg.startsWith("--project=")) out.project = arg.slice(10) || ".";
    else if (arg === "--preset") { const value = argv.shift(); if (!value) throw new Error("--preset requires a value"); out.preset = value as Preset; }
    else if (arg.startsWith("--preset=")) out.preset = arg.slice(9) as Preset;
    else if (arg === "--catalog") { const value = argv.shift(); if (!value) throw new Error("--catalog requires a path"); out.catalog = value; }
    else if (arg.startsWith("--catalog=")) out.catalog = arg.slice(10);
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--backup") out.backup = true;
    else if (arg === "--no-pull") out.noPull = true;
    else if (arg === "--skip-validation") out.skipValidation = true;
    else if (arg === "-h" || arg === "--help") { console.log(usage); process.exit(0); }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["setup", "configure", "reinstall", "uninstall", "status", "models"].includes(out.command)) throw new Error(`Unknown command: ${out.command}`);
  if (out.preset && !["balanced", "quality", "fast", "minimal"].includes(out.preset)) throw new Error(`Unknown preset: ${out.preset}`);
  return out;
}

async function destination(options: Options): Promise<string> {
  if (options.project !== undefined) {
    try { return path.join(await realpath(options.project), ".opencode"); }
    catch (error) {
      if (options.command === "uninstall" && (error as NodeJS.ErrnoException).code === "ENOENT")
        return path.join(path.resolve(options.project), ".opencode");
      throw error;
    }
  }
  if (!process.env.HOME) throw new Error("HOME is not set");
  return path.join(process.env.HOME, ".config", "opencode");
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dest = await destination(options);
  if (options.command === "status") return statusCommand(dest);
  if (options.command === "uninstall") return uninstall(options, dest);
  const catalogue = await loadCatalogue(options.catalog);
  if (options.command === "reinstall") return reinstall(options, catalogue.models, dest);
  const h = await detectHardware();
  if (options.command === "models") return modelsCommand(catalogue.models, h);
  return setup(options, catalogue.models, h, dest);
}
main().catch(error => { console.error(`local-coder: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
