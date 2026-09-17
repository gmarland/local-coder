# local-coder

`local-coder` configures [OpenCode](https://opencode.ai) to use local, tool-capable models through [Ollama](https://ollama.com). It detects the machine, recommends a small role-based model set, lets the developer customise it, downloads only after confirmation, and validates the result.

Setup is local-only: the CLI does not upload prompts, source code, hardware details, or telemetry. Generated OpenCode configuration is ordinary JSON and Markdown. When OpenCode's researcher uses web tools, its search queries and fetched URLs go to the configured web service.

## Requirements

- Node.js 20 or newer
- Ollama (for downloading and running models)
- OpenCode

The wizard detects missing tools and explains what remains to install. Git and ripgrep are also reported because they materially improve a coding-agent workflow.

## Install and run

```sh
npm install
npm link
setup-ai
```

The package exposes both `setup-ai` and `local-coder`. Without a command, setup runs. Configuration is global by default (`~/.config/opencode`) or project-local with `--project`:

```sh
local-coder
local-coder --project
local-coder --project /path/to/repository
local-coder configure
local-coder reinstall
local-coder uninstall --dry-run
local-coder uninstall
local-coder uninstall --project /path/to/repository
local-coder status
local-coder models
```

`reinstall` rebuilds the OpenCode configuration and agent files from the last saved selection. It does not download, replace, test, or remove any Ollama models. Use `--project` to restore a project-local setup, and add `--dry-run` to preview the files and assignments without writing anything.

`uninstall` removes the setup in the selected scope. It restores files that existed before setup, removes files local-coder created, and deletes Ollama models that local-coder downloaded or created for that scope once no other local-coder scope uses them. It preserves models that were already installed, shared models, unrelated OpenCode settings, and user edits made after setup. Preview the removal plan with `--dry-run`; use `--yes` for automation. Ollama must be running to remove models. If it is unavailable, rerun `uninstall` when it is running.

Setup records file ownership in `local-coder-ownership.json` beside the generated config and model ownership in `${XDG_DATA_HOME:-~/.local/share}/local-coder/registry.json`. These records let uninstall identify what it may remove. Older setups without an ownership record can have exactly matching generated agent files removed, but their prior config and model ownership cannot be reconstructed reliably. Uninstall reports those items for manual review. Timestamped backups are retained because they may contain user files.

Useful automation and preview options:

```sh
local-coder --dry-run --yes --preset balanced
local-coder --yes --preset minimal --no-pull
local-coder --yes --backup
```

Presets are `balanced`, `quality`, `fast`, and `minimal`. The interactive custom flow allows a different compatible model for every role or a manually entered Ollama tag. A single model may serve several roles; downloads and storage estimates are deduplicated.

An independently distributed compatible catalogue can be selected with `--catalog /path/to/models.json`; the bundled catalogue always remains the offline fallback.

## What setup writes

The selected scope receives:

```text
opencode.json
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

Existing JSON/JSONC configuration is merged. Unrelated providers, MCP servers, plugins, and instructions are preserved. Interactive setup asks whether to create timestamped backups before replacing existing generated files and defaults to overwriting without backups. Automated `--yes` runs also overwrite without backups unless `--backup` is supplied. Invalid existing configuration causes setup to stop without overwriting it.

The orchestrator is OpenCode's primary, user-facing agent. It selects a workflow according to the request:

```text
Trivial:  Coder → Verifier
Standard: Explorer → Coder → Verifier
Complex:  Explorer → Planner → Coder → Verifier → Reviewer
Domain:   Explorer + Researcher → Planner → Coder → Verifier → Reviewer
```

The explorer summarizes relevant repository context; the planner turns that and any research into an implementation plan. The coder locates and reads files, uses an editing tool, rereads the result, checks git diff where available, and runs appropriate immediate tests. The independent verifier checks the requested outcome and runs proportionate validation. For complex and domain work, the reviewer then looks for defects beyond test results. The orchestrator may send failed verification back to the coder for at most two remediation attempts. Substantive review findings allow one review remediation pass followed by verification. Unresolved verification failures are reported as failures. The user does not need to switch agents. Specialist output is a claim until checked: **FILESYSTEM STATE > AGENT CLAIM**.

The orchestrator can read and search but cannot edit files or run shell commands. The coder can edit files and run commands. The verifier can run commands but cannot edit. Explorer, planner, researcher, and reviewer can only read and search; researcher also has web tools. Researcher web fetch is enabled; OpenCode's web search tool is available with an OpenCode or OpenCode Go provider, or when `OPENCODE_ENABLE_EXA=1` or `OPENCODE_ENABLE_PARALLEL=1` is set. Agent descriptions and permissions use OpenCode's documented Markdown format.

## Recommendation design

The bundled, versioned [`catalog/models.json`](catalog/models.json) keeps model metadata separate from selection logic. Entries include Ollama tags, storage and memory budgets, roles, context, tool support, speed/quality weights, and explanatory notes. The bundled catalogue works fully offline and can be updated independently in a future release.

Machine detection is isolated in [`src/hardware.ts`](src/hardware.ts). Recommendation logic in [`src/models/recommend.ts`](src/models/recommend.ts) considers unified memory or NVIDIA VRAM, free disk, role suitability, and preset intent. Recommended-memory figures include practical headroom beyond quantised model weight; minimum-memory values are used only by the explicitly quality-maximising preset.

Models can serve several roles. Balanced and fast setups favor smaller models for exploration, verification, and research when memory permits; the minimal preset reuses one model for all seven agents. The saved selection records each assignment, and reinstall fills new roles from related assignments in older four-agent state files.

The provider boundary is isolated in [`src/ollama.ts`](src/ollama.ts), allowing another OpenAI-compatible backend such as vLLM to be added without changing hardware or recommendation logic.

CLI workflows live in [`src/commands/`](src/commands), model selection in [`src/models/`](src/models), OpenCode configuration and saved state in [`src/opencode/`](src/opencode), and ownership records in [`src/persistence/`](src/persistence). [`src/cli.ts`](src/cli.ts) remains the command entry point.

## Safety and validation

Before changing anything, setup shows the exact models, estimated download size, local context variants, and files it will write. Pulls use Ollama's own resumable downloader and visible progress. For each selected model, setup creates a local variant with a 32K context (or the model's lower supported limit); variants share the original weights and avoid changing the original model. This is needed because Ollama's OpenAI-compatible API cannot set context size per request. Setup first checks that OpenCode can write its state directory (`${XDG_STATE_HOME:-~/.local/state}/opencode`). If its ownership is wrong, interactive setup offers to repair only that directory using the administrator password; automated setup prints the exact repair command. Setup then checks that Ollama is reachable, each variant responds to a tiny prompt, advertises tools, and returns a real structured `tool_calls` response to a harmless synthetic tool. JSON merely printed as assistant text is rejected because OpenCode cannot execute it. Setup also asks the coder model to read, modify, and reread a temporary file through a narrow tool interface, then checks the file on disk. A textual success claim fails this check. It checks Ollama's *loaded* context allocation against the context advertised to OpenCode. The orchestrator must make a valid new coder task call, and OpenCode must successfully delegate and edit a file in a temporary project using the generated configuration. A failed real edit blocks installation. `--skip-validation` bypasses these inference and runtime checks with a prominent warning; `--no-pull` skips downloads and creates variants only from models already present.

OpenCode edits the directory it is launched against. Setup prints an explicit `opencode /path/to/project` command. When setup runs inside a Git repository, that command uses the repository root, including when setup was invoked from its `bin` directory. A `--project` path is used as given. Starting a separate OpenCode session from a nested directory may choose a different active location; launch with the printed project path for repository edits.

## Development

```sh
make build
make test
```

Tests cover catalogue validation, capability tiers, 16/32/64/128 GB Macs, NVIDIA 24/48 GB profiles, memory and disk failures, every preset, custom deduplication, config generation, optional backups, safe handling of malformed existing config, and structured tool-call validation—including rejection of tool-shaped JSON returned as ordinary text.

## Current format and catalogue sources

The generated shape follows the current [OpenCode provider documentation](https://opencode.ai/docs/providers), [agent documentation](https://opencode.ai/docs/agents), and [`default_agent` configuration](https://opencode.ai/docs/config). Catalogue choices prioritise models that Ollama marks as supporting tools and that are intended for agentic work, including [Qwen 3 Coder](https://ollama.com/library/qwen3-coder), [Devstral Small 2](https://ollama.com/library/devstral-small-2), and [Qwen 3 Coder Next](https://ollama.com/library/qwen3-coder-next).
