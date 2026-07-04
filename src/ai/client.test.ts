// (F2) The provider adapter (client.ts). `fetch` is injected, so these assert the request SHAPE per style
// and the response extraction — no network. Both shapes carry the auth header the provider expects and never
// echo the key in an error.
import { test, expect } from "bun:test";
import { makeLlmClient } from "./client.ts";

const baseCfg = { llmApiKey: "sk-secret-key", llmModel: "m1", llmTimeoutMs: 5000, llmMaxResponseBytes: 256 * 1024 } as const;
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("openai style: Bearer auth + response_format json_object; parses choices[0].message.content", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return jsonRes({ choices: [{ message: { content: JSON.stringify({ name: "shop", resources: { api: { type: "app" } } }) } }] });
  };
  const client = makeLlmClient({ ...baseCfg, llmUrl: "http://llm.local/v1/chat/completions", llmStyle: "openai" }, fetchImpl);
  const out = (await client.generateSpec("a node api")) as { name: string };
  expect(out.name).toBe("shop");
  const headers = seen!.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-secret-key");
  const body = JSON.parse(seen!.init.body as string);
  expect(body.model).toBe("m1");
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.messages[1].content).toBe("a node api");
});

test("anthropic style: x-api-key + anthropic-version + forced tool_choice; extracts tool_use input", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return jsonRes({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "emit_stack", input: { name: "shop", resources: { db: { type: "database" } } } }] });
  };
  const client = makeLlmClient({ ...baseCfg, llmUrl: "http://llm.local/v1/messages", llmStyle: "anthropic" }, fetchImpl);
  const out = (await client.generateSpec("a postgres db")) as { name: string };
  expect(out.name).toBe("shop");
  const headers = seen!.init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-secret-key");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  expect(headers.authorization).toBeUndefined();
  const body = JSON.parse(seen!.init.body as string);
  expect(body.tool_choice).toEqual({ type: "tool", name: "emit_stack" });
  expect(body.tools[0].input_schema.type).toBe("object");
});

test("non-2xx status throws a status-only error (never leaks the key)", async () => {
  const fetchImpl = async () => jsonRes({ error: "sk-secret-key was rejected" }, 401);
  const client = makeLlmClient({ ...baseCfg, llmUrl: "http://llm.local/v1/chat/completions", llmStyle: "openai" }, fetchImpl);
  let msg = "";
  try {
    await client.generateSpec("x");
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("401");
  expect(msg).not.toContain("sk-secret-key");
});

test("openai content that isn't JSON throws a clean parse error", async () => {
  const fetchImpl = async () => jsonRes({ choices: [{ message: { content: "not json at all" } }] });
  const client = makeLlmClient({ ...baseCfg, llmUrl: "http://llm.local/v1/chat/completions", llmStyle: "openai" }, fetchImpl);
  expect(client.generateSpec("x")).rejects.toThrow();
});
