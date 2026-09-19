import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSafeValidationRunner } from "../src/opencode/validation-runner.js";

test("safe validation runner uses argv without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-safe-runner-"));
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  const calls: unknown[][] = [];
  const runner = createSafeValidationRunner(root, async (command, args, options) => {
    calls.push([command, args, options]);
    return { stdout: "passed" };
  });
  const result = await runner({ command: "npm", args: ["test", "--", "literal;not-shell"], cwd: "packages/app", timeoutMs: 5_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["npm", ["test", "--", "literal;not-shell"], { cwd: path.join(await realpath(root), "packages", "app"), timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }]]);
});

test("safe validation runner rejects shell strings, unknown executables, and external cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-safe-reject-"));
  const runner = createSafeValidationRunner(root, async () => { throw new Error("must not execute"); });
  assert.equal((await runner("npm test")).ok, false);
  assert.match((await runner({ command: "sh", args: ["-c", "rm -rf ."] })).output!, /not allowed/);
  assert.match((await runner({ command: "git", args: ["push"] })).output!, /not a validation operation/);
  assert.match((await runner({ command: "npm", args: ["publish"] })).output!, /not a validation operation/);
  assert.match((await runner({ command: "npm", args: ["test"], cwd: "../outside" })).output!, /outside the repository/);
});
