import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyTaskContract, type TaskContract, type VerificationResult } from "../src/opencode/task-contract.js";

const wrongContact = `## Contact

For any inquiries, please contact the maintainers at [maintainers@example.com](mailto:maintainers@example.com).
`;
const correctContact = `## Contact

For any inquiries, please contact the maintainers at [gareth@deckarddesigns.com](mailto:gareth@deckarddesigns.com).
`;

function contactContract(): TaskContract {
  return {
    request: "Replace maintainers@example.com with gareth@deckarddesigns.com without changing the surrounding Contact section.",
    targetFiles: ["README.md"],
    protectedLiterals: ["gareth@deckarddesigns.com"],
    expectedOutcomes: [{ kind: "fileEquals", path: "README.md", value: correctContact }],
    forbiddenOutcomes: [{ kind: "fileContains", path: "README.md", value: "maintainers@example.com" }],
    preserveUnrelatedContent: true
  };
}

async function repository(content: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "localstack-contract-"));
  await writeFile(path.join(root, "README.md"), content);
  return root;
}

test("placeholder substitution fails deterministic verification", async () => {
  const result = await verifyTaskContract(await repository(wrongContact), contactContract());
  assert.equal(result.status, "fail");
  assert.ok(result.failures.some(failure => failure.includes("gareth@deckarddesigns.com")));
  assert.ok(result.failures.some(failure => failure.includes("Forbidden outcome")));
});

test("destructive literal-only correction fails preservation outcome", async () => {
  const result = await verifyTaskContract(await repository("gareth@deckarddesigns.com"), contactContract());
  assert.equal(result.status, "fail");
  assert.ok(result.failures.some(failure => failure.includes("instead contains")));
  assert.match(result.repairInstruction!, /ORIGINAL REQUEST/);
  assert.match(result.repairInstruction!, /EXPECTED/);
  assert.match(result.repairInstruction!, /For any inquiries/);
  assert.match(result.repairInstruction!, /Preserve all unrelated and surrounding content/);
  assert.match(result.repairInstruction!, /do not rewrite its section/);
});

test("correct minimal patch passes deterministic verification", async () => {
  const result = await verifyTaskContract(await repository(correctContact), contactContract());
  assert.equal(result.status, "pass");
  assert.deepEqual(result.failures, []);
});

test("coder success claim cannot override repository evidence", async () => {
  const coderClaim = "STATUS: SUCCESS\nVERIFIED: gareth@deckarddesigns.com was added";
  const result = await verifyTaskContract(await repository(wrongContact), contactContract());
  assert.match(coderClaim, /SUCCESS/);
  assert.equal(result.status, "fail");
});

async function remediationSequence(attempts: string[]): Promise<{ results: VerificationResult[]; success: boolean }> {
  const root = await repository(attempts[0]);
  const results: VerificationResult[] = [];
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    if (attempt) await writeFile(path.join(root, "README.md"), attempts[attempt]);
    const result = await verifyTaskContract(root, contactContract());
    results.push(result);
    if (result.status === "pass") return { results, success: true };
    assert.ok(result.repairInstruction);
  }
  return { results, success: false };
}

test("failed implementation can be narrowly repaired and pass", async () => {
  const run = await remediationSequence([wrongContact, correctContact]);
  assert.deepEqual(run.results.map(result => result.status), ["fail", "pass"]);
  assert.equal(run.success, true);
  assert.match(run.results[0].repairInstruction!, /maintainers@example\.com/);
  assert.match(run.results[0].repairInstruction!, /gareth@deckarddesigns\.com/);
});

test("two failed remediation attempts terminate without success", async () => {
  const run = await remediationSequence([wrongContact, "gareth@deckarddesigns.com", wrongContact]);
  assert.deepEqual(run.results.map(result => result.status), ["fail", "fail", "fail"]);
  assert.equal(run.success, false);
  assert.ok(run.results.at(-1)!.failures.length);
});

test("configured validation commands contribute deterministic evidence", async () => {
  const contract = { ...contactContract(), validationCommands: ["npm test"] };
  const passed = await verifyTaskContract(await repository(correctContact), contract, async command => ({ ok: command === "npm test", output: "ok" }));
  assert.equal(passed.status, "pass");
  assert.ok(passed.evidence.some(item => item.includes("Validation passed: npm test")));
});
