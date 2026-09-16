import test from "node:test";
import assert from "node:assert/strict";
import { modelAdvertisesTools, probeToolCalling } from "../src/ollama.js";

const jsonResponse = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" }
}));

test("tool probe accepts a structured call with the expected argument", async () => {
  const result = await probeToolCalling("test-model", () => jsonResponse({
    message: { tool_calls: [{ function: { name: "local_coder_probe", arguments: { token: "local-coder-probe-7f3a" } } }] }
  }));
  assert.deepEqual(result, { ok: true });
});

test("tool probe accepts OpenAI-style string arguments", async () => {
  const result = await probeToolCalling("test-model", () => jsonResponse({
    message: { tool_calls: [{ function: { name: "local_coder_probe", arguments: '{"token":"local-coder-probe-7f3a"}' } }] }
  }));
  assert.deepEqual(result, { ok: true });
});

test("tool probe rejects a JSON tool request returned as assistant text", async () => {
  const result = await probeToolCalling("test-model", () => jsonResponse({
    message: { content: '{"name":"local_coder_probe","arguments":{"token":"local-coder-probe-7f3a"}}' }
  }));
  assert.deepEqual(result, { ok: false, reason: "missing-tool-call" });
});

test("tool probe rejects the wrong tool and malformed arguments", async () => {
  const wrongTool = await probeToolCalling("test-model", () => jsonResponse({
    message: { tool_calls: [{ function: { name: "write", arguments: {} } }] }
  }));
  assert.deepEqual(wrongTool, { ok: false, reason: "wrong-tool" });

  const wrongArguments = await probeToolCalling("test-model", () => jsonResponse({
    message: { tool_calls: [{ function: { name: "local_coder_probe", arguments: { token: "wrong" } } }] }
  }));
  assert.deepEqual(wrongArguments, { ok: false, reason: "wrong-arguments" });
});

test("tool checks fail closed on HTTP and request errors", async () => {
  assert.deepEqual(await probeToolCalling("test-model", () => jsonResponse({}, 500)), { ok: false, reason: "request-failed" });
  assert.deepEqual(await probeToolCalling("test-model", async () => { throw new Error("offline"); }), { ok: false, reason: "request-failed" });
  assert.equal(await modelAdvertisesTools("test-model", () => jsonResponse({ capabilities: ["completion", "tools"] })), true);
  assert.equal(await modelAdvertisesTools("test-model", () => jsonResponse({ capabilities: ["completion"] })), false);
});
