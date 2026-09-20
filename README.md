# local-coder

Run [OpenCode](https://opencode.ai) with a hardware-matched team of local coding agents.

`local-coder` detects your available memory, GPU, and disk space; recommends suitable [Ollama](https://ollama.com) models for seven specialist roles; installs a guarded OpenCode workflow; and verifies that the models can actually use tools, edit files, and check their work before declaring setup complete.

It is for developers who want agentic coding without sending their repository or prompts to a hosted model provider.

- **Fits the machine.** Recommendations account for RAM or VRAM, free disk, model context, role suitability, and a chosen speed/quality preset.
- **Proves the setup works.** Live probes exercise structured tool calls, repository editing, delegation, verification, and review—not just model availability.
- **Protects existing configuration.** Setup merges JSON or JSONC, preserves unrelated settings, previews every write, and refuses unsafe or ambiguous changes.
- **Stays reversible.** Ownership records let uninstall restore previous files and remove only models attributable to that setup and unused elsewhere.

## What to expect

Setup takes the machine from hardware detection to a tested OpenCode configuration:

```text
Detect hardware and installed tools
  → recommend models for seven agent roles
  → preview downloads, context variants, and file changes
  → confirm and download missing models
  → run model and end-to-end OpenCode probes
  → write configuration and print the exact launch command
```

A dry run shows the recommendation and complete installation plan without downloading models or writing files:

```sh
local-coder --dry-run
```

The resulting OpenCode environment uses an orchestrator, explorer, planner, coder, verifier, researcher, and reviewer. A single model may serve several roles, so storage is deduplicated.

## Requirements

- macOS or Linux
- [Node.js](https://nodejs.org) 20 or newer
- [Ollama](https://ollama.com/download), running when models need to be downloaded or tested
- [OpenCode](https://opencode.ai/docs) for the generated coding environment
- At least about 9 GB of usable model memory and 11 GB of free disk for the smallest bundled option; more capable presets need more

Git and [ripgrep](https://github.com/BurntSushi/ripgrep) are recommended because they materially improve coding-agent workflows. The wizard detects missing tools and explains what remains to install.

## Quick start

Install from this repository:

```sh
git clone https://github.com/gmarland/local-coder.git
cd local-coder
npm install
npm link
local-coder --dry-run
local-coder
```

Review the dry-run output before starting setup. The interactive wizard shows the exact model downloads and file changes, then asks for confirmation. When setup finishes, run the `opencode /path/to/project` command it prints.

The package also exposes `setup-ai` as an alias. Running either command without a subcommand starts setup.

## Scope and presets

Configuration is global by default in `~/.config/opencode`. Use `--project` to write `<project>/.opencode` instead:

```sh
local-coder                         # configure the global OpenCode environment
local-coder --project               # configure the current project
local-coder --project /path/to/repo # configure a specific project
```

The available presets are `balanced`, `quality`, `fast`, and `minimal`. The interactive custom flow can assign a different compatible model to every role or accept a manually entered Ollama tag. The `minimal` preset reuses one model for all seven roles.

Useful non-interactive and preview combinations include:

```sh
local-coder --dry-run --yes --preset balanced
local-coder --yes --preset minimal --no-pull
local-coder --yes --backup
```

`--no-pull` skips downloads and creates context variants only from models already present. `--skip-validation` bypasses inference and runtime probes with a prominent warning; it should be reserved for cases where those checks cannot run.

## How the agents work

The orchestrator is OpenCode's primary, user-facing agent. It chooses the smallest workflow appropriate to the request:

```text
Trivial:  Coder → Verifier
Standard: Explorer → Coder → Verifier
Complex:  Explorer → Planner → Coder → Verifier → Reviewer
Domain:   Explorer + Researcher → Planner → Coder → Verifier → Reviewer
```

The explorer locates relevant repository context, and the planner converts that context and any external research into an implementation plan. The coder makes the smallest necessary change and runs focused then broader validation. The verifier independently inspects repository state and test evidence instead of trusting the coder's success claim. Complex and domain work also receives a final review of the actual diff and verifier evidence.

Every repository change gets a versioned JSON task contract containing the original request, allowed paths, protected values, expected and forbidden outcomes, preservation requirements, test obligations, argv-based validation commands, and a repair budget. The same contract is supplied to the coder and verifier. A change is complete only after verifier `PASS`; otherwise the orchestrator issues a narrow repair request and reports any discrepancy that remains after the repair budget is exhausted.

**Agent claims are not evidence. Repository state determines success.**

## Privacy and safety

Model inference, prompts, source code, hardware details, and telemetry stay on the machine by default. `local-coder` talks to Ollama through its local API and does not upload that data. Network access is still used when installing dependencies or asking Ollama to download model weights. If the optional researcher uses configured web tools, its search queries and fetched URLs go to that web service.

Before changing configuration, setup shows:

- the exact models and estimated download size;
- the local context variants it will create;
- every file it plans to write; and
- warnings about missing tools, memory pressure, or insufficient disk.

Setup then checks model responses, loaded context, advertised tool support, and real structured tool calls. It requires the coder to modify and reread a temporary file, the verifier to reject a seeded regression, the reviewer to identify a seeded path-traversal defect, and the orchestrator to delegate a real temporary README correction through a legal workflow trace. When the required models and OpenCode runtime are available, a failed live probe blocks configuration from being written; an unavailable dependency instead produces an incomplete-setup warning and a command to rerun configuration.

Role permissions provide another boundary: the orchestrator can search but cannot edit or run commands; only the coder can edit; the verifier can validate but cannot edit or commit; and the remaining specialists are read-only. Pushes and external-directory access are denied. Repository files, comments, fixtures, and command output are treated as untrusted data rather than instructions.

## What setup writes

The selected global or project-local scope receives:

```text
opencode.json (or an existing opencode.jsonc)
AGENTS.md
agents/
  orchestrator.md
  explorer.md
  planner.md
  coder.md
  verifier.md
  researcher.md
  reviewer.md
local-coder-state.json
local-coder-ownership.json
```

Existing JSON or JSONC configuration is merged. Unrelated providers, MCP servers, plugins, and instructions are preserved. Invalid existing configuration causes setup to stop without overwriting it. Interactive setup offers timestamped backups before replacing generated files; automated `--yes` runs create backups only when `--backup` is supplied.

OpenCode edits the directory it is launched against. Setup prints an explicit `opencode /path/to/project` command, using the Git repository root when appropriate. Launch with that printed path; a separate OpenCode session started from a nested directory may choose a different active location.

## Reinstall, inspect, and uninstall

```sh
local-coder status
local-coder models
local-coder reinstall --dry-run
local-coder reinstall
local-coder uninstall --dry-run
local-coder uninstall
local-coder uninstall --project /path/to/repository
```

`reinstall` reconstructs configuration and agent files from the last saved selection. It does not download, replace, test, or remove Ollama models.

`uninstall` restores files that existed before setup, removes files created by `local-coder`, and deletes models downloaded or created for that scope only when no other `local-coder` scope uses them. It preserves pre-existing and shared models, unrelated OpenCode settings, and user edits made after setup. Preview the plan with `--dry-run`; use `--yes` for automation. Ollama must be running to remove models.

File ownership is recorded in `local-coder-ownership.json` beside the generated configuration. Cross-scope model ownership is stored in `${XDG_DATA_HOME:-~/.local/share}/local-coder/registry.json`. Older installations without ownership records are handled conservatively and may leave files or models for manual review. Timestamped backups are always retained because they may contain user data.

## Model selection and advanced use

The versioned [`catalog/models.json`](catalog/models.json) records Ollama tags, storage and memory budgets, supported roles, context limits, tool support, speed and quality weights, and explanatory notes. Recommendation logic in [`src/models/recommend.ts`](src/models/recommend.ts) considers unified memory or NVIDIA VRAM, free disk, role suitability, and preset intent. Context variants use 16K, 24K, or 32K tokens according to the detected hardware tier, capped by each model's supported limit, and share the original model weights.

An independently distributed compatible catalogue can be selected with `--catalog /path/to/models.json`; the bundled catalogue remains the offline fallback. The provider boundary is isolated in [`src/ollama.ts`](src/ollama.ts), making another OpenAI-compatible local backend possible in the future without changing recommendation logic.

Automation can invoke the deterministic completion gate directly:

```sh
local-coder verify-contract contract.json --root /path/to/repository --changed src/file.ts
```

It exits unsuccessfully on any discrepancy. Validation commands are executable-plus-argv objects and run without a shell. Optional `--baseline baseline.json` supplies pre-edit contents for values whose rule is `unchanged`.

## Development

See [`REPO_MAP.md`](REPO_MAP.md) for module responsibilities, execution flows, and the tests associated with each subsystem. [`docs/orchestration-audit.md`](docs/orchestration-audit.md) records which orchestration guarantees are executable and which remain prompt-enforced.

```sh
make build
make test
```

The test suite covers catalogue validation, hardware tiers, model-role compatibility, configuration merging, structured tool calls, safe uninstall, task-contract verification, shell-free validation, legal workflow transitions, repair budgets, and end-to-end OpenCode probe interpretation.

Generated configuration follows the current [OpenCode provider documentation](https://opencode.ai/docs/providers), [agent documentation](https://opencode.ai/docs/agents), and [`default_agent` configuration](https://opencode.ai/docs/config). Catalogue choices prioritize models Ollama identifies as tool-capable and suitable for agentic work, including [Qwen 3 Coder](https://ollama.com/library/qwen3-coder), [Devstral Small 2](https://ollama.com/library/devstral-small-2), and [Qwen 3 Coder Next](https://ollama.com/library/qwen3-coder-next).

Licensed under the [MIT License](LICENSE).
