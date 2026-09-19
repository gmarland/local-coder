import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("verify-contract CLI gates success on repository evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-coder-verify-cli-"));
  const contract = path.join(root, "contract.json");
  await writeFile(path.join(root, "result.txt"), "correct\n");
  await writeFile(contract, JSON.stringify({ version: 2, request: "Write correct", allowedPaths: ["result.txt"],
    expectedOutcomes: [{ kind: "fileEquals", path: "result.txt", value: "correct\n" }], preserveUnrelatedContent: true }));
  const cli = path.resolve("dist/src/cli.js");
  const passed = await execFileAsync(process.execPath, [cli, "verify-contract", contract, "--root", root, "--changed", "result.txt"]);
  const result = JSON.parse(passed.stdout);
  assert.equal(result.status, "pass");
  assert.match(result.contractHash, /^[a-f0-9]{64}$/);

  await writeFile(path.join(root, "result.txt"), "wrong\n");
  await assert.rejects(execFileAsync(process.execPath, [cli, "verify-contract", contract, "--root", root]), error => {
    const failure = error as Error & { stdout?: string };
    assert.equal(JSON.parse(failure.stdout || "{}").status, "fail");
    return true;
  });
});
