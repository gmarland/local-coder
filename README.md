# local-coder

**Turn the models your machine can run into a private, verified team of coding agents.**

`local-coder` builds a local coding-agent environment on top of [Ollama](https://ollama.com) and [OpenCode](https://opencode.ai). It detects the machine, recommends models that fit, assigns them to seven specialist roles, generates a permission-restricted workflow, and tests whether the result can actually use tools, delegate work, edit a repository, and verify the edit.

Pointing OpenCode at an Ollama model gives you local inference. `local-coder` adds the system around that model: hardware-aware role assignment, adaptive orchestration, task contracts, capability probes, independent verification, and reversible configuration management.

> **Agent claims are not evidence. Repository state determines success.**

That principle is the project's completion rule. A model saying that it changed a file or ran a test is not enough; the generated workflow asks a separate verifier to inspect the repository and validation evidence.

## Why local-coder exists

Running a model locally is relatively easy. Building a dependable local coding-agent setup raises harder questions:

- Which models fit this machine's memory, GPU, disk, and useful context budget?
- Which model should explore, plan, implement, verify, research, or review?
- Can each selected model produce real structured tool calls, not tool-shaped text?
- Can the coding model read, edit, and reread a file correctly?
- Can an orchestrator delegate work, and can another agent catch a false success claim or a real defect?
- Can all of this be added without discarding an existing OpenCode configuration or shared models?

`local-coder` treats those as one setup problem. Smaller or faster models can handle lightweight roles while stronger models handle implementation and planning, when the hardware and catalogue support that split. A minimal setup can reuse one compatible model for every role.

## From hardware to a verified environment

```text
Detect hardware and installed tools
              ↓
Determine memory, context, and storage budgets
              ↓
Recommend models and assign them to roles
              ↓
Create local Ollama context variants
              ↓
Generate OpenCode agents, permissions, and config
              ↓
Run model and role capability probes
              ↓
Run a real OpenCode edit-and-verification probe
              ↓
Ready
```

A single model may fill several roles; downloads are deduplicated by Ollama tag and context variants share the source model's weights. Before doing anything, a dry run shows the recommendation, downloads, variants, and files without writing or downloading:

```sh
local-coder --dry-run
```

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

## The agent team

The orchestrator is OpenCode's primary, user-facing agent. The other roles are specialists it can call as the work requires:

```text
                    User
                      │
                      ▼
                Orchestrator
                      │ selects a workflow
                      ▼
          Explorer + Researcher (as needed)
                      │
                      ▼
               Planner (as needed)
                      │
                      ▼
                    Coder
                      │
                      ▼
                   Verifier
                      │
                      ▼
             Reviewer (when required)
```

- **Orchestrator:** classifies the request, selects the workflow, creates the handoffs and task contract, and owns retries and completion.
- **Explorer:** finds the relevant files, symbols, execution flow, conventions, and tests without editing.
- **Planner:** turns repository and research findings into ordered implementation and validation guidance.
- **Researcher:** uses configured web tools for current documentation or domain evidence; it is not invoked for ordinary repository work.
- **Coder:** makes the repository change, rereads it, inspects the diff, and runs proportionate validation.
- **Verifier:** independently checks repository state, contract outcomes, scope, protected values, and test evidence; it cannot edit.
- **Reviewer:** examines significant verified changes for defects, regressions, security issues, and missing tests.

### Adaptive workflows

The orchestrator is instructed to choose the least costly workflow that covers a repository change rather than invoking every role every time:

```text
Trivial:  Coder → Verifier
Standard: Explorer → Coder → Verifier
Complex:  Explorer → Planner → Coder → Verifier → Reviewer
Domain:   Explorer + Researcher → Planner → Coder → Verifier → Reviewer
```

Simple questions that do not change the repository can be answered directly. A task can move to a more involved workflow if discovery shows that it is larger than expected.

## Verification: behavior, not output

There is a material difference between **the model responded** and **the coding agent performed the requested operation**. Setup checks both model capability and observable effects:

1. **Inference:** each selected context variant returns a valid response, and Ollama reports that the required context is actually loaded.
2. **Tool use:** the model advertises tool support and emits a structured call to the requested tool with the exact argument. Returning JSON as ordinary assistant text does not pass.
3. **Role behavior:** the coder must read, modify, and reread a temporary file; the orchestrator must emit a structured delegation to the coder; the verifier must reject seeded failing evidence; and the reviewer must identify a seeded path-traversal defect.
4. **End-to-end workflow:** OpenCode is launched with the generated configuration against a temporary repository. The orchestrator must delegate a precise README edit, the file must match the expected bytes on disk, and the event trace must contain a completed coder task followed by verifier `PASS`.

The final probe does not accept a successful process exit, a correct-looking response, or even a correct file by itself. The repository result and the delegated verification trace must agree. If the selected models and OpenCode are available, any failed live probe blocks configuration from being written. If a required runtime is unavailable, setup can still write an incomplete configuration, warns that it has not been validated, and gives the command to rerun setup.

These probes establish that the selected models and generated environment can complete a controlled workflow at setup time; they do not make arbitrary future agent work infallible. OpenCode enforces the generated role permissions, while interactive task classification and semantic contract construction still depend partly on the generated agent instructions. Automation that needs a deterministic completion decision can run `local-coder verify-contract`.

## Task contracts

For each repository change, the generated orchestrator is instructed to create one versioned JSON task contract and pass it unchanged to the coder and verifier. A contract can record:

- allowed paths and target files;
- exact protected values that must remain present or unchanged;
- expected and forbidden file or JSON outcomes;
- preservation requirements and whether tests are required;
- validation commands as an executable plus argument array; and
- a maximum repair count.

This keeps exact user values and acceptance criteria attached to the work instead of relying on a chain of increasingly compressed natural-language summaries. A failed verification produces an evidence-based, narrowly scoped repair instruction. The generated instructions cap verification repairs at two and allow complex or domain workflows one review remediation before the final verification and review; the executable workflow controller applies the same limits when validating setup traces.

The contract verifier can deterministically check file existence, absence, contents, hashes, JSON pointers, changed-path scope, protected values, and validation results. Its validation runner rejects shell strings, disallowed operations, and working directories outside the repository. Semantic requirements still require independent inspection by the verifier agent.

## Privacy and permission boundaries

`local-coder` itself sends Ollama requests only to `127.0.0.1`, configures OpenCode sharing as disabled unless the existing config says otherwise, and does not upload prompts, source code, hardware details, or telemetry. Installing dependencies and downloading model weights still use the network. If the researcher uses configured web tools, its queries and fetched URLs go to that external service.

Role permissions limit the impact of a confused model:

- the orchestrator can read, search, and delegate, but cannot edit or run shell commands;
- only the coder can edit, and `git push` is denied;
- the verifier can read and run approved validation commands, but cannot edit, commit, or push;
- the explorer, planner, and researcher are read-only, while the reviewer has only read-only Git inspection commands; and
- external-directory access is denied for every role.

Repository files, comments, fixtures, and command output are treated as untrusted data rather than instructions.

## Safe, reversible installation

Before changing configuration, setup shows the models and estimated download size, local context variants, every file it plans to write, and any tool, memory-pressure, or disk warnings. The plan is built before confirmation and setup refuses to apply it if a target file changes after the preview.

### What setup writes

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

## Hardware-aware model selection

`local-coder` recommends a configuration; it does not benchmark every possible combination or claim to find an objectively best model. Its hardware checks and recommendation logic consider:

- total system memory, including unified memory on Apple silicon, with currently available memory used for pressure warnings;
- NVIDIA VRAM on Linux, combined with a limited host-memory allowance for fit calculations;
- free disk space, including a 5 GB reserve after model downloads;
- each model's supported roles, context window, tool-calling flag, and agentic-coding flag;
- operating-system restrictions, known minimum Ollama versions, and experimental support status; and
- the selected `balanced`, `quality`, `fast`, or `minimal` preference.

Lightweight exploration, verification, and research roles are scored differently from core orchestration, planning, coding, and review roles. Different roles may therefore receive different models, while `minimal` requires one model compatible with all seven roles. Context variants use 32K, 64K, or 128K tokens according to the hardware tier, capped by each model's supported limit, and share the source model's weights.

The versioned [`catalog/models.json`](catalog/models.json) records the Ollama tags and metadata used for those decisions, including storage and memory budgets, supported roles, context limits, tool support, speed and quality weights, platform restrictions, minimum Ollama versions, reasoning-field compatibility, and support status.

The bundled schema-v2 catalogue contains 27 canonical local tags, current to 20 September 2026:

- Compact: `rnj-1:8b`, `ornith:9b`, `qwen3:8b`, `qwen3.5:9b`, `gemma4:12b`.
- Workstation: `gpt-oss:20b`, `devstral-small-2:24b`, `qwen3.6:27b-coding`, `qwen3.8:27b`, `muse-glimmer:30b`, `gemma4:26b`, `north-mini-code-1.0:q4_K_M`, `gemma4:31b`, `ornith:35b`, `qwen3-coder:30b`, `qwen3.6:35b-coding`, `glm-4.7-flash:q4_K_M`.
- Large-memory: `qwen3-coder-next:q4_K_M`, `gpt-oss:120b`, `devstral-2:123b`, `mistral-medium-3.5:128b`, `qwen3.5:122b`, `nemotron-3-super:120b`, `laguna-s-2.1:q4_K_M`, `qwen3-coder:480b`.
- Conditional: `laguna-xs-2.1:q4_K_M` is offered only on Linux while its Ollama build remains unreliable on Metal; `qwen3.8-flash-next:125b-a6b-q4_K_M` is an experimental preview available only through interactive custom selection.

Automatic presets never select experimental entries. The interactive custom picker can opt into them, while platform, memory, disk, and known Ollama-version requirements remain enforced. Older schema-v1 external catalogues continue to load.

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

Generated configuration follows the current [OpenCode provider documentation](https://opencode.ai/docs/providers), [model compatibility documentation](https://opencode.ai/v2/docs/models), [agent documentation](https://opencode.ai/docs/agents), and [`default_agent` configuration](https://opencode.ai/docs/config). Catalogue choices prioritize models Ollama identifies as tool-capable and suitable for agentic work; each exact downloadable tag is recorded in the catalogue rather than inferred from a family name.

Licensed under the [MIT License](LICENSE).
