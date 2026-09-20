# Repository map

This document is the contributor-oriented map of `local-coder`. Keep it focused
on stable module responsibilities and execution flows. User-facing installation
and operation instructions belong in [`README.md`](README.md); durable agent
working rules belong in [`AGENTS.md`](AGENTS.md).

## Runtime entry points

```text
bin/local-coder
  -> dist/src/cli.js
     -> src/cli.ts
        -> setup | reinstall | uninstall | status | models
        -> verify-contract
```

- `bin/local-coder` is the published shell launcher. It requires compiled output
  in `dist/` and forwards arguments to the CLI.
- `src/cli.ts` parses arguments, resolves global or project-local destinations,
  and dispatches commands.
- `package.json` exposes the launcher as both `local-coder` and `setup-ai`.

## Main workflows

### Setup and configure

```text
hardware detection + model catalogue
  -> recommendation and optional custom assignments
  -> context-specific Ollama variants
  -> OpenCode installation plan
  -> model and role probes
  -> managed configuration write and ownership records
```

The coordinating implementation is `src/commands/setup.ts`. Its main
collaborators are `src/hardware.ts`, `src/models/`, `src/ollama.ts`,
`src/opencode/`, and `src/persistence/`.

### Reinstall

`src/commands/reinstall.ts` reconstructs configuration from saved assignments.
`src/opencode/saved-state.ts` validates current state and migrates older
four-role state into the current seven-role shape. Reinstall does not pull,
replace, test, or remove Ollama models.

### Uninstall

`src/commands/uninstall.ts` combines file ownership and model ownership data to
prepare a removal plan. It restores or removes only safely attributable files,
preserves conflicts for manual review, retains shared models, and verifies model
digests before deletion.

### Contract verification

`local-coder verify-contract` enters through `src/cli.ts`, validates repository
state with `src/opencode/task-contract.ts`, and executes approved argv-based
commands through `src/opencode/validation-runner.ts`.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | CLI usage, argument parsing, scope resolution, and dispatch |
| `src/types.ts` | Shared model, role, hardware, recommendation, and saved-state types |
| `src/hardware.ts` | Platform, memory, GPU, disk, command, and installed Ollama-version detection |
| `src/ollama.ts` | Ollama API operations and model capability probes |
| `src/commands/common.ts` | Shared command options and prompt helpers |
| `src/commands/setup.ts` | Interactive and automated setup orchestration |
| `src/commands/reinstall.ts` | Regeneration from saved configuration |
| `src/commands/uninstall.ts` | Safe file restoration and owned-model removal |
| `src/commands/inspect.ts` | `status` and `models` output |
| `src/models/catalogue.ts` | Catalogue loading and top-level validation |
| `src/models/validation.ts` | Runtime validation helpers for model data |
| `src/models/recommend.ts` | Hardware tiers, platform/version/status compatibility, presets, and role assignments |
| `src/opencode/agents.ts` | Generated specialist prompts, permissions, and general guidance |
| `src/opencode/config.ts` | OpenCode config merging and planned managed writes |
| `src/opencode/context-models.ts` | Stable tags and assignments for context-sized model variants |
| `src/opencode/saved-state.ts` | Saved recommendation parsing and legacy-state migration |
| `src/opencode/state.ts` | OpenCode state-directory access checks and repair |
| `src/opencode/probe.ts` | End-to-end OpenCode editing and delegation probe |
| `src/opencode/task-contract.ts` | Contract schema, hashing, validation, and outcome verification |
| `src/opencode/validation-runner.ts` | Restricted, shell-free validation command execution |
| `src/opencode/workflow.ts` | Legal workflow transitions and OpenCode trace analysis |
| `src/persistence/storage.ts` | Atomic file writes |
| `src/persistence/ownership.ts` | Managed-file snapshots, restoration, and conflict detection |
| `src/persistence/registry.ts` | Cross-scope Ollama model ownership and sharing registry |
| `catalog/models.json` | Versioned offline model catalogue with resource and compatibility metadata |
| `docs/orchestration-audit.md` | Executable versus prompt-enforced orchestration guarantees |

## Generated and persistent state

The OpenCode destination is `~/.config/opencode` by default or
`<project>/.opencode` for project-local setup. Installation manages:

```text
opencode.json or opencode.jsonc
AGENTS.md
agents/*.md
local-coder-state.json
local-coder-ownership.json
```

The cross-scope model registry is stored under
`${XDG_DATA_HOME:-~/.local/share}/local-coder/registry.json`. OpenCode's own
state-directory checks are isolated in `src/opencode/state.ts`.

## Tests

Tests mirror behavior rather than the source directory tree exactly:

| Test | Primary coverage |
| --- | --- |
| `test/catalogue.test.ts` | Catalogue validation |
| `test/recommend.test.ts` | Hardware tiers, presets, compatibility, and deduplication |
| `test/ollama.test.ts` | Ollama calls, context variants, and role capability probes |
| `test/opencode.test.ts` | Config generation, agent prompts, installation, and live probe handling |
| `test/task-contract.test.ts` | Contract identity, scope, protected values, and deterministic outcomes |
| `test/validation-runner.test.ts` | Shell-free command restrictions and path containment |
| `test/workflow.test.ts` | Workflow transitions, verification gates, and repair budgets |
| `test/uninstall.test.ts` | Restoration, conflicts, shared models, and safe removal |
| `test/verify-command.test.ts` | End-to-end `verify-contract` CLI behavior |

## Where to make common changes

| Change | Start with | Also inspect |
| --- | --- | --- |
| Add or change a CLI option | `src/cli.ts` | Relevant command and its tests |
| Change model selection | `src/models/recommend.ts` | `catalog/models.json`, recommendation tests |
| Change catalogue schema | `src/models/catalogue.ts` and `src/models/validation.ts` | Shared types and catalogue tests |
| Change generated agents | `src/opencode/agents.ts` | Config, prompt tests, probes, README, orchestration audit |
| Change generated config or files | `src/opencode/config.ts` | Ownership, reinstall, uninstall, and OpenCode tests |
| Change workflow guarantees | `src/opencode/workflow.ts` or `src/opencode/task-contract.ts` | Probe, validation runner, audit, and behavioral tests |
| Change setup probes | `src/ollama.ts` or `src/opencode/probe.ts` | Setup command and probe tests |
| Change uninstall semantics | `src/commands/uninstall.ts` | Both persistence modules and uninstall tests |
| Add a generated managed file | `src/opencode/config.ts` | `managedPaths` in ownership, uninstall, tests, and README |
