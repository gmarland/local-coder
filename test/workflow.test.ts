import test from "node:test";
import assert from "node:assert/strict";
import { analyzeOpenCodeTrace, WorkflowController } from "../src/opencode/workflow.js";

function trace(role: string, output: string, index: number): string {
  return JSON.stringify({ type: "message.part.updated", properties: { part: {
    id: `part-${index}`, callID: `call-${index}`, type: "tool", tool: "task",
    state: { status: "completed", input: { subagent_type: role }, output }
  } } });
}

test("workflow completion is gated by verification", () => {
  const flow = new WorkflowController(2, false);
  flow.startImplementation();
  flow.implementationFinished("success");
  assert.equal(flow.snapshot().state, "verifying");
  flow.verificationFinished(true);
  assert.deepEqual(flow.snapshot(), { state: "complete", repairAttempts: 0, reviewRemediations: 0, finalVerificationPassed: true });
});

test("workflow enforces repair and final-review budgets", () => {
  const flow = new WorkflowController(1, true);
  flow.startImplementation();
  flow.implementationFinished("success");
  flow.verificationFinished(false);
  assert.equal(flow.snapshot().state, "repairing");
  flow.startImplementation();
  flow.implementationFinished("success");
  flow.verificationFinished(true);
  flow.reviewFinished(true);
  flow.startImplementation();
  flow.implementationFinished("success");
  flow.verificationFinished(true);
  flow.reviewFinished(false);
  assert.equal(flow.snapshot().state, "complete");
  assert.equal(flow.snapshot().reviewRemediations, 1);
});

test("trace analysis requires coder then verifier PASS", () => {
  const passed = analyzeOpenCodeTrace([trace("coder", "STATUS: SUCCESS", 0), trace("verifier", "STATUS: PASS", 1)].join("\n"));
  assert.deepEqual(passed, { ok: true, roles: ["coder", "verifier"], verifierPassed: true });
  assert.match(analyzeOpenCodeTrace(trace("coder", "STATUS: SUCCESS", 0)).reason!, /verifier/);
  assert.match(analyzeOpenCodeTrace([trace("verifier", "STATUS: PASS", 0), trace("coder", "STATUS: SUCCESS", 1)].join("\n")).reason!, /after the coder/);
  assert.match(analyzeOpenCodeTrace([trace("coder", "STATUS: SUCCESS", 0), trace("verifier", "STATUS: FAIL", 1)].join("\n")).reason!, /did not return STATUS: PASS/);
});

test("complex traces require a reviewer after verification", () => {
  const output = [trace("coder", "STATUS: SUCCESS", 0), trace("verifier", "STATUS: PASS", 1)].join("\n");
  assert.match(analyzeOpenCodeTrace(output, true).reason!, /reviewer/);
  assert.equal(analyzeOpenCodeTrace(`${output}\n${trace("reviewer", "STATUS: CLEAR", 2)}`, true).ok, true);
});
