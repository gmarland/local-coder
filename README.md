# local-coder

`local-coder` configures [OpenCode](https://opencode.ai) to use local, tool-capable models through [Ollama](https://ollama.com). It detects the machine, recommends a small role-based model set, lets the developer customise it, downloads only after confirmation, and validates the result.

Setup is local-only: the CLI does not upload prompts, source code, hardware details, or telemetry. Generated OpenCode configuration is ordinary JSON and Markdown.

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
local-coder status
local-coder models
```

Useful automation and preview options:

```sh
local-coder --dry-run --yes --preset balanced
local-coder --yes --preset minimal --no-pull
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
  coder.md
  researcher.md
  reviewer.md
local-coder-state.json
```

Existing JSON/JSONC configuration is merged. Unrelated providers, MCP servers, plugins, and instructions are preserved. Files that the CLI replaces receive timestamped backups. Invalid existing configuration causes setup to stop without overwriting it.

The orchestrator is OpenCode's primary agent. It delegates all repository modifications to the coder, unfamiliar domain work to the read-only researcher, and significant independent review to the read-only reviewer. Delegation prompts must include the concrete request and relevant context. The orchestrator cannot edit files or run implementation commands itself. Agent descriptions and permissions are generated in OpenCode's documented Markdown format.

## Recommendation design

The bundled, versioned [`catalog/models.json`](catalog/models.json) keeps model metadata separate from selection logic. Entries include Ollama tags, storage and memory budgets, roles, context, tool support, speed/quality weights, and explanatory notes. The bundled catalogue works fully offline and can be updated independently in a future release.

Machine detection is isolated in [`src/hardware.ts`](src/hardware.ts). Recommendation logic in [`src/recommend.ts`](src/recommend.ts) considers unified memory or NVIDIA VRAM, free disk, role suitability, and preset intent. Recommended-memory figures include practical headroom beyond quantised model weight; minimum-memory values are used only by the explicitly quality-maximising preset.

The provider boundary is isolated in [`src/ollama.ts`](src/ollama.ts), allowing another OpenAI-compatible backend such as vLLM to be added without changing hardware or recommendation logic.

## Safety and validation

Before changing anything, setup shows the exact models, estimated download size, and files it will write. Pulls use Ollama's own resumable downloader and visible progress. Before writing configuration, setup checks that Ollama is reachable, each model responds to a tiny prompt, advertises tools, and returns a real structured `tool_calls` response to a harmless synthetic tool. JSON merely printed as assistant text is rejected because OpenCode cannot safely execute it. `--skip-validation` bypasses these inference checks with a prominent warning; `--no-pull` creates configuration only when models are unavailable.

OpenCode edits the directory it is launched against. Setup prints an explicit `opencode /path/to/project` command; do not launch it from the `local-coder/bin` directory when you intend to modify the repository above it.

## Development

```sh
make build
make test
```

Tests cover catalogue validation, capability tiers, 16/32/64/128 GB Macs, NVIDIA 24/48 GB profiles, memory and disk failures, every preset, custom deduplication, config generation, backups, safe handling of malformed existing config, and structured tool-call validation—including rejection of tool-shaped JSON returned as ordinary text.

## Current format and catalogue sources

The generated shape follows the current [OpenCode provider documentation](https://opencode.ai/docs/providers), [agent documentation](https://opencode.ai/docs/agents), and [`default_agent` configuration](https://opencode.ai/docs/config). Catalogue choices prioritise models that Ollama marks as supporting tools and that are intended for agentic work, including [Qwen 3 Coder](https://ollama.com/library/qwen3-coder), [Devstral Small 2](https://ollama.com/library/devstral-small-2), and [Qwen 3 Coder Next](https://ollama.com/library/qwen3-coder-next).
