import test from "node:test";
import assert from "node:assert/strict";
import { createContextModel, deleteModel, installedModelDigests, loadedModelContext, modelAdvertisesTools, probeDelegation, probeRepositoryEditing, probeToolCalling, testModel } from "../src/ollama.js";

const jsonResponse = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" }
}));

test("tool probe accepts a structured call with the expected argument", async () => {
  const result = await probeToolCalling("test-model", (input, init) => {
    assert.match(String(input), /\/v1\/chat\/completions$/);
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 512);
    return jsonResponse({
      choices: [{ message: { tool_calls: [{ function: { name: "localstack_probe", arguments: { token: "localstack-probe-7f3a" } } }] } }]
    });
  });
  assert.deepEqual(result, { ok: true });
});

test("tool probe accepts OpenAI-style string arguments", async () => {
  const result = await probeToolCalling("test-model", () => jsonResponse({
    choices: [{ message: { tool_calls: [{ function: { name: "localstack_probe", arguments: '{"token":"localstack-probe-7f3a"}' } }] } }]
  }));
  assert.deepEqual(result, { ok: true });
});

test("tool probe rejects a JSON tool request returned as assistant text", async () => {
  const result = await probeToolCalling("test-model", () => jsonResponse({
    choices: [{ message: { content: '{"name":"localstack_probe","arguments":{"token":"localstack-probe-7f3a"}}' } }]
  }));
  assert.deepEqual(result, { ok: false, reason: "missing-tool-call" });
});

test("tool probe rejects the wrong tool and malformed arguments", async () => {
  const wrongTool = await probeToolCalling("test-model", () => jsonResponse({
    choices: [{ message: { tool_calls: [{ function: { name: "write", arguments: {} } }] } }]
  }));
  assert.deepEqual(wrongTool, { ok: false, reason: "wrong-tool" });

  const wrongArguments = await probeToolCalling("test-model", () => jsonResponse({
    choices: [{ message: { tool_calls: [{ function: { name: "localstack_probe", arguments: { token: "wrong" } } }] } }]
  }));
  assert.deepEqual(wrongArguments, { ok: false, reason: "wrong-arguments" });
});

test("delegation probe requires a structured task call selecting coder", async () => {
  const result = await probeDelegation("test-model", (input, init) => {
    assert.match(String(input), /\/v1\/chat\/completions$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].function.name, "task");
    assert.ok(body.tools[0].function.parameters.properties.task_id);
    assert.match(body.messages[1].content, /Update the README/);
    return jsonResponse({ choices: [{ message: { tool_calls: [{ function: {
      name: "task", arguments: JSON.stringify({ subagent_type: "coder", description: "Edit README", prompt: "Update the README installation instructions." })
    } }] } }] });
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await probeDelegation("test-model", () => jsonResponse({ choices: [{ message: { content: "Use coder." } }] })),
    { ok: false, reason: "missing-tool-call" });
  assert.deepEqual(await probeDelegation("test-model", () => jsonResponse({ choices: [{ message: { tool_calls: [{ function: {
    name: "task", arguments: { subagent_type: "researcher", description: "Research", prompt: "Look up README syntax" }
  } }] } }] })), { ok: false, reason: "wrong-arguments" });
  assert.deepEqual(await probeDelegation("test-model", () => jsonResponse({ choices: [{ message: { tool_calls: [{ function: {
    name: "task", arguments: { subagent_type: "coder", description: "Edit README", prompt: "Update README", task_id: "1" }
  } }] } }] })), { ok: false, reason: "wrong-arguments" });
});

test("loaded context reports Ollama's allocation, not model metadata", async () => {
  const request = (input: string | URL | Request) => {
    assert.match(String(input), /\/api\/ps$/);
    return jsonResponse({ models: [{ name: "another:latest", context_length: 32768 }, { name: "test-model", context_length: 4096 }] });
  };
  assert.equal(await loadedModelContext("test-model", request), 4096);
  assert.equal(await loadedModelContext("missing", request), undefined);
  assert.equal(await loadedModelContext("test-model", () => jsonResponse({ models: [{ name: "test-model", context_length: "32768" }] })), undefined);
});

test("context variant creation sets num_ctx without changing the source model", async () => {
  await createContextModel("qwen3:8b", "localstack-test:ctx32768", 32768, (input, init) => {
    assert.match(String(input), /\/api\/create$/);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      from: "qwen3:8b", model: "localstack-test:ctx32768", parameters: { num_ctx: 32768 }, stream: false
    });
    return jsonResponse({ status: "success" });
  });
  await assert.rejects(createContextModel("qwen3:8b", "alias", 32768, () => jsonResponse({ error: "bad model" }, 400)), /HTTP 400/);
});

test("coder probe executes tools and checks the temporary file independently", async () => {
  let round = 0;
  const result = await probeRepositoryEditing("test-model", (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ["read_file", "edit_file"]);
    assert.equal(body.think, false);
    if (round === 1) assert.equal(body.messages.at(-1).content, "ORIGINAL");
    if (round === 2) assert.equal(body.messages.at(-1).content, "File written. Call read_file to verify test.txt.");
    const name = round === 0 || round === 2 ? "read_file" : "edit_file";
    const args = name === "read_file" ? { path: "test.txt" } : { path: "test.txt", content: "MODIFIED" };
    round++;
    return jsonResponse({ choices: [{ message: { tool_calls: [{ id: `call-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  });
  assert.deepEqual(result, { ok: true, edited: true, readAfterEdit: true });
  assert.equal(round, 3);
});

test("coder probe rejects a success claim without a filesystem edit", async () => {
  const result = await probeRepositoryEditing("test-model", () => jsonResponse({ choices: [{ message: { content: "STATUS: SUCCESS. test.txt contains MODIFIED." } }] }));
  assert.deepEqual(result, { ok: false, edited: false, readAfterEdit: false, reason: "missing-tool-call" });
});

test("coder probe rejects an edit without post-edit verification", async () => {
  let round = 0;
  const result = await probeRepositoryEditing("test-model", () => {
    const name = round === 0 ? "read_file" : "edit_file";
    round++;
    return jsonResponse({ choices: [{ message: round > 2 ? { content: "STATUS: SUCCESS" } : { tool_calls: [{
      id: `call-${round}`, type: "function", function: { name, arguments: JSON.stringify(name === "read_file" ?
        { path: "test.txt" } : { path: "test.txt", content: "MODIFIED" }) }
    }] } }] });
  });
  assert.deepEqual(result, { ok: false, edited: true, readAfterEdit: false, reason: "missing-tool-call" });
});

test("response smoke test allows thinking models to produce a final answer", async () => {
  const result = await testModel("test-model", (input, init) => {
    assert.match(String(input), /\/api\/chat$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.think, false);
    assert.equal(body.options.num_predict, 256);
    return jsonResponse({ message: { content: "4" } });
  });
  assert.equal(result, true);
});

test("tool checks fail closed on HTTP and request errors", async () => {
  assert.deepEqual(await probeToolCalling("test-model", () => jsonResponse({}, 500)), { ok: false, reason: "request-failed" });
  assert.deepEqual(await probeToolCalling("test-model", async () => { throw new Error("offline"); }), { ok: false, reason: "request-failed" });
  assert.equal(await modelAdvertisesTools("test-model", () => jsonResponse({ capabilities: ["completion", "tools"] })), true);
  assert.equal(await modelAdvertisesTools("test-model", () => jsonResponse({ capabilities: ["completion"] })), false);
});

test("model removal uses Ollama's delete endpoint and reports failure", async () => {
  const models = await installedModelDigests(() => jsonResponse({ models: [{ name: "owned:latest", digest: "abc" }] }));
  assert.equal(models.get("owned:latest"), "abc");
  await deleteModel("owned:latest", (input, init) => {
    assert.match(String(input), /\/api\/delete$/);
    assert.equal(init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "owned:latest" });
    return jsonResponse({});
  });
  await assert.rejects(deleteModel("owned:latest", () => jsonResponse({}, 500)), /HTTP 500/);
});
