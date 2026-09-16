import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "./types.js";

const endpoint = "http://127.0.0.1:11434";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ToolCallProbe {
  ok: boolean;
  reason?: "request-failed" | "missing-tool-call" | "wrong-tool" | "wrong-arguments";
}
export interface EditingProbe extends ToolCallProbe {
  edited: boolean;
  readAfterEdit: boolean;
}
export async function ollamaRunning(): Promise<boolean> {
  try { const r = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
}
export async function installedModels(): Promise<string[]> {
  try {
    const r = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const data = await r.json() as { models?: { name: string }[] };
    return data.models?.map(m => m.name) || [];
  } catch { return []; }
}
export async function installedModelDigests(request: FetchLike = fetch): Promise<Map<string, string | null>> {
  const r = await request(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`Ollama model list failed: HTTP ${r.status}`);
  const data = await r.json() as { models?: { name: string; digest?: string }[] };
  return new Map((data.models || []).map(m => [m.name, m.digest || null]));
}
export async function deleteModel(model: string, request: FetchLike = fetch): Promise<void> {
  const r = await request(`${endpoint}/api/delete`, { method: "DELETE", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30000), body: JSON.stringify({ model }) });
  if (!r.ok) throw new Error(`Ollama could not delete ${model}: HTTP ${r.status}`);
}
export async function pullModel(model: Model): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ollama", ["pull", model.ollamaModel], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`ollama pull exited with ${code}`)));
  });
}
export async function testModel(model: string, request: FetchLike = fetch): Promise<boolean> {
  try {
    const r = await request(`${endpoint}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model, stream: false, think: false, messages: [{ role: "user", content: "Return only the result of 2 + 2." }], options: { num_predict: 256 } }) });
    if (!r.ok) return false;
    const value = await r.json() as { message?: { content?: string } };
    return value.message?.content?.includes("4") ?? false;
  } catch { return false; }
}
export async function modelAdvertisesTools(model: string, request: FetchLike = fetch): Promise<boolean> {
  try {
    const r = await request(`${endpoint}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ model }) });
    if (!r.ok) return false;
    const value = await r.json() as { capabilities?: string[] };
    return value.capabilities?.includes("tools") ?? false;
  } catch { return false; }
}

export async function probeToolCalling(model: string, request: FetchLike = fetch): Promise<ToolCallProbe> {
  const token = "local-coder-probe-7f3a";
  try {
    const r = await request(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: `Call local_coder_probe with token ${token}. Do not answer in text.` }],
        tools: [{
          type: "function",
          function: {
            name: "local_coder_probe",
            description: "Checks whether structured tool calling works.",
            parameters: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"]
            }
          }
        }],
        temperature: 0,
        max_tokens: 512
      })
    });
    if (!r.ok) return { ok: false, reason: "request-failed" };
    const value = await r.json() as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } }[] };
    const calls = value.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return { ok: false, reason: "missing-tool-call" };
    const call = calls.find(item => item.function?.name === "local_coder_probe");
    if (!call) return { ok: false, reason: "wrong-tool" };
    let args = call.function?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { return { ok: false, reason: "wrong-arguments" }; }
    }
    if (!args || typeof args !== "object" || (args as Record<string, unknown>).token !== token)
      return { ok: false, reason: "wrong-arguments" };
    return { ok: true };
  } catch { return { ok: false, reason: "request-failed" }; }
}

export async function probeDelegation(model: string, request: FetchLike = fetch): Promise<ToolCallProbe> {
  try {
    const r = await request(`${endpoint}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model, stream: false, temperature: 0, max_tokens: 512,
        messages: [
          { role: "system", content: "You are a read-only coding orchestrator. For repository changes, call the task tool with the correct specialist. Never tell the user to call a specialist." },
          { role: "user", content: "Update the README installation instructions in this repository. Delegate the edit now." }
        ],
        tools: [{ type: "function", function: {
          name: "task", description: "Launch a specialist agent to perform a task.",
          parameters: { type: "object", properties: {
            subagent_type: { type: "string", enum: ["coder", "researcher", "reviewer"] },
            description: { type: "string" }, prompt: { type: "string" }
          }, required: ["subagent_type", "description", "prompt"] }
        } }]
      })
    });
    if (!r.ok) return { ok: false, reason: "request-failed" };
    const value = await r.json() as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } }[] };
    const calls = value.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return { ok: false, reason: "missing-tool-call" };
    const call = calls.find(item => item.function?.name === "task");
    if (!call) return { ok: false, reason: "wrong-tool" };
    let args = call.function?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { return { ok: false, reason: "wrong-arguments" }; }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, reason: "wrong-arguments" };
    const task = args as Record<string, unknown>;
    if (task.subagent_type !== "coder" || typeof task.prompt !== "string" || !task.prompt.trim() ||
        typeof task.description !== "string" || !task.description.trim())
      return { ok: false, reason: "wrong-arguments" };
    return { ok: true };
  } catch { return { ok: false, reason: "request-failed" }; }
}

// Exercise real filesystem mutation through a narrow synthetic tool interface. This
// checks model behaviour independently of its final text, without touching a project.
export async function probeRepositoryEditing(model: string, request: FetchLike = fetch): Promise<EditingProbe> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "local-coder-edit-probe-"));
  const file = path.join(directory, "test.txt");
  let readBeforeEdit = false;
  let edited = false;
  let readAfterEdit = false;
  try {
    await writeFile(file, "ORIGINAL");
    const messages: Record<string, unknown>[] = [
      { role: "system", content: "You are a coding agent. Call read_file to read test.txt now. After seeing its contents, call edit_file with content MODIFIED, then call read_file again. Do not answer with a plan. Textual claims do not change files." },
      { role: "user", content: "Edit test.txt: replace its complete contents ORIGINAL with MODIFIED. Start by calling read_file." }
    ];
    const tools = [
      { type: "function", function: { name: "read_file", description: "Read test.txt from the temporary worktree.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
      { type: "function", function: { name: "edit_file", description: "Replace the complete contents of test.txt with the supplied content.",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }
    ];
    for (let round = 0; round < 6; round++) {
      const response = await request(`${endpoint}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ model, stream: false, think: false, temperature: 0, max_tokens: 512, messages, tools })
      });
      if (!response.ok) return { ok: false, edited, readAfterEdit, reason: "request-failed" };
      const value = await response.json() as { choices?: { message?: { content?: string; tool_calls?: {
        id?: string; type?: string; function?: { name?: string; arguments?: unknown }
      }[] } }[] };
      const message = value.choices?.[0]?.message;
      if (!message) return { ok: false, edited, readAfterEdit, reason: "request-failed" };
      const calls = message.tool_calls;
      if (!Array.isArray(calls) || !calls.length) break;
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        if (typeof call.id !== "string" || !call.id) return { ok: false, edited, readAfterEdit, reason: "wrong-arguments" };
        let args: unknown = call.function?.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { return { ok: false, edited, readAfterEdit, reason: "wrong-arguments" }; }
        }
        if (!args || typeof args !== "object" || Array.isArray(args) || (args as Record<string, unknown>).path !== "test.txt")
          return { ok: false, edited, readAfterEdit, reason: "wrong-arguments" };
        const name = call.function?.name;
        let result: string;
        if (name === "read_file") {
          result = await readFile(file, "utf8");
          if (!edited && result === "ORIGINAL") readBeforeEdit = true;
          if (edited && result === "MODIFIED") readAfterEdit = true;
        } else if (name === "edit_file") {
          if (!readBeforeEdit || (args as Record<string, unknown>).content !== "MODIFIED")
            return { ok: false, edited, readAfterEdit, reason: "wrong-arguments" };
          await writeFile(file, "MODIFIED");
          edited = true;
          result = "File written. Call read_file to verify test.txt.";
        } else return { ok: false, edited, readAfterEdit, reason: "wrong-tool" };
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (edited && readAfterEdit) break;
    }
    const actual = await readFile(file, "utf8");
    return { ok: edited && readAfterEdit && actual === "MODIFIED", edited, readAfterEdit,
      ...(!edited || !readAfterEdit || actual !== "MODIFIED" ? { reason: "missing-tool-call" as const } : {}) };
  } catch { return { ok: false, edited, readAfterEdit, reason: "request-failed" }; }
  finally { await rm(directory, { recursive: true, force: true }); }
}
