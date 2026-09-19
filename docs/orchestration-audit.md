# Orchestration audit

This audit records the implementation before task contracts were added.

## Generated flow

`src/opencode/config.ts` writes `AGENTS.md`, seven role files under `agents/`, and
an OpenCode configuration whose primary agent is the orchestrator. The generated
orchestrator classifies repository changes and delegates through the existing
hierarchy:

- trivial: coder, verifier;
- standard: explorer, coder, verifier;
- complex: explorer, planner, coder, verifier, reviewer;
- domain: explorer and researcher, planner, coder, verifier, reviewer.

Only the coder can edit. The verifier can read and run commands but cannot edit.
The orchestrator can read and search, but cannot edit or run commands. The other
specialists are read-only (with web access for the researcher).

Before this change, generated prompts already told the coder to read before
editing, invoke a real edit tool, reread modified files, inspect git status and
diff when available, and run proportionate validation. They also told the
orchestrator to treat coder success as a claim, call an independent verifier,
allow at most two repair attempts, and report unresolved verification as failure.
The README accurately described those intended behaviours.

## Enforcement boundary

Role permissions are programmatically enforced by the generated OpenCode
configuration. Setup also performs programmatic model/tool probes and checks the
temporary probe file on disk rather than trusting agent output.

Task classification, specialist call ordering, preservation of user literals,
construction of acceptance checks, verifier invocation, and remediation are
otherwise enforced by generated prompts. OpenCode owns the live conversation and
task calls; `localstack` is not in the execution path after configuration is
generated. Consequently, this package cannot programmatically reject an
orchestrator's premature final response without introducing a custom execution
harness, which is outside the project's architecture.

The failure mode was therefore not missing high-level advice. A small model could
lose an exact value while compressing the request, make a broad corrective edit,
or skip a previously stated verification step. There was no compact, repeated
contract carrying protected literals and concrete checks into every coder and
verifier call.

## Strengthening approach

The implementation keeps the existing hierarchy and adds:

- a concise task-contract protocol repeated at each implementation and
  verification boundary;
- explicit minimal-edit and no-placeholder rules;
- conservative deterministic contract checks for literal presence, literal
  absence, file existence, and exact file content;
- structured PASS/FAIL evidence and discrepancy-driven repair instructions;
- an independently inspected real-agent probe combining an unusual literal with
  a minimal correction.

The generated prompts remain the strongest possible enforcement inside the
current OpenCode architecture. Deterministic setup and unit checks validate the
protocol and observable repository state, but do not pretend to control a later
OpenCode session.
