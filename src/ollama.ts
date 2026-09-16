import { spawn } from "node:child_process";
import type { Model } from "./types.js";

const endpoint = "http://127.0.0.1:11434";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ToolCallProbe {
  ok: boolean;
  reason?: "request-failed" | "missing-tool-call" | "wrong-tool" | "wrong-arguments";
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
