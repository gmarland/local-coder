# Orchestration audit

This audit records the current orchestration and its enforcement boundary.

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

Interactive task classification and construction of semantic acceptance criteria
are still performed by the orchestrator. OpenCode owns an ordinary live TUI
session, so prompt instructions remain part of that path. They are no longer the
only executable representation of the policy, however.

`src/opencode/task-contract.ts` defines a versioned, deterministically serialized
contract with a stable SHA-256 identity. It verifies file presence or absence,
literal presence or absence, exact contents, hashes, JSON pointers, path scope,
path-scoped protected values, and validation results. `verify-contract` exposes
that gate to automation, using an argv-only runner that rejects shell strings,
unknown executables, and working directories outside the repository.

`src/opencode/workflow.ts` owns legal transitions, verification repair counts,
one review-remediation pass, and the final verification gate. The real OpenCode
setup probe parses newline-delimited JSON tool events through this state machine.
It rejects a correct filesystem result unless a completed coder task, subsequent
verifier task, and `STATUS: PASS` are present in the trace.

The failure mode was therefore not missing high-level advice. A small model could
lose an exact value while compressing the request, make a broad corrective edit,
or skip a previously stated verification step. There was no compact, repeated
contract carrying protected literals and concrete checks into every coder and
verifier call.

## Strengthening approach

The implementation keeps the existing hierarchy and adds:

- one versioned JSON contract repeated at each implementation and verification
  boundary;
- explicit minimal-edit and no-placeholder rules;
- deterministic scope, structured-file, hash, preservation, and argv-validation
  checks;
- structured PASS/FAIL evidence and discrepancy-driven repair instructions;
- a code-owned workflow state machine and trace validator;
- role-specific probes that require the verifier to reject a seeded regression
  and the reviewer to identify a security defect;
- granular shell permissions and explicit untrusted-repository guidance.

The setup probe and `verify-contract` command are hard gates. A later interactive
OpenCode TUI session is still not wrapped by a custom process controller, so its
semantic contract construction and final response remain partly prompt-enforced.
Automation requiring a hard completion decision should run the emitted contract
through `verify-contract` rather than trusting the final agent message.
