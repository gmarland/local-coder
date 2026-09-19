import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeTaskContract, taskContractHash, validateTaskContract, verifyTaskContract, type TaskContract, type VerificationResult } from "../src/opencode/task-contract.js";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-contract-"));
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

test("versioned contracts serialize and hash deterministically", () => {
  const first = { ...contactContract(), version: 2 as const, targetFiles: ["z.md", "README.md"], allowedPaths: ["test", "src"] };
  const second = { allowedPaths: ["src", "test"], targetFiles: ["README.md", "z.md"], version: 2 as const,
    forbiddenOutcomes: first.forbiddenOutcomes, expectedOutcomes: first.expectedOutcomes, preserveUnrelatedContent: true,
    protectedLiterals: first.protectedLiterals, request: first.request };
  assert.equal(serializeTaskContract(first), serializeTaskContract(second));
  assert.equal(taskContractHash(first), taskContractHash(second));
  assert.match(taskContractHash(first), /^[a-f0-9]{64}$/);
});

test("verification rejects out-of-scope changes and altered protected values", async () => {
  const root = await repository(`${correctContact}\nRelease: 1.2.3\n`);
  const contract: TaskContract = {
    version: 2,
    request: "Keep release 1.2.3 while updating the contact.",
    targetFiles: ["README.md"],
    allowedPaths: ["README.md"],
    protectedValues: [{ value: "1.2.3", rule: "unchanged", paths: ["README.md"] }],
    expectedOutcomes: [{ kind: "fileContains", path: "README.md", value: "gareth@deckarddesigns.com" }],
    preserveUnrelatedContent: true
  };
  const result = await verifyTaskContract(root, contract, undefined, {
    changedPaths: ["README.md", "src/unrelated.ts"],
    beforeContents: { "README.md": `${wrongContact}\nRelease: 1.2.3\n` }
  });
  assert.equal(result.status, "fail");
  assert.ok(result.failures.some(item => item.includes("outside contract scope")));
  assert.ok(result.evidence.some(item => item.includes("retained 1 occurrence")));
});

test("structured outcomes verify missing files, JSON values, and argv commands", async () => {
  const root = await repository(correctContact);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const contract: TaskContract = {
    version: 2,
    request: "Verify the project metadata.",
    expectedOutcomes: [
      { kind: "fileMissing", path: "temporary.txt" },
      { kind: "fileNotContains", path: "README.md", value: "maintainers@example.com" },
      { kind: "jsonPointerEquals", path: "package.json", pointer: "/scripts/test", value: "node --test" }
    ],
    preserveUnrelatedContent: true,
    requiresTests: true,
    validationCommands: [{ command: "npm", args: ["test"], timeoutMs: 60_000 }]
  };
  const result = await verifyTaskContract(root, contract, async command => ({
    ok: typeof command !== "string" && command.command === "npm" && command.args?.[0] === "test", output: "ok"
  }));
  assert.equal(result.status, "pass");
  assert.equal(validateTaskContract(contract).length, 0);
});

test("behaviour contracts require tests or an explicit reason", () => {
  const contract: TaskContract = { request: "Change behaviour", expectedOutcomes: [{ kind: "fileExists", path: "src/index.ts" }],
    preserveUnrelatedContent: true, requiresTests: true };
  assert.deepEqual(validateTaskContract(contract), ["a test command or explicit noTestReason is required"]);
});

test("malformed runtime contract data fails closed", async () => {
  const malformed = { request: "broken", expectedOutcomes: "not-an-array", preserveUnrelatedContent: true } as unknown as TaskContract;
  const result = await verifyTaskContract(await repository(correctContact), malformed);
  assert.equal(result.status, "fail");
  assert.ok(result.failures.some(item => item.includes("at least one expected outcome")));
});
