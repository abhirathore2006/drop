// (F2) The provider abstraction for the AI-intent feature: a tiny `generateSpec(prompt) → rawJson` that
// speaks the operator-configured LLM endpoint. Hand-rolled fetch, NO SDK, NO new deps.
//
// One adapter covers the two common shapes, selected by `cfg.llmStyle` ("openai" | "anthropic", inferred
// from the URL when unset — see config.ts):
//   - OpenAI-style:    POST <url> (a /chat/completions endpoint), auth `Authorization: Bearer <key>`,
//                      `response_format: {type: "json_object"}`. Answer at choices[0].message.content (a
//                      JSON string).
//   - Anthropic-style: POST <url> (a /v1/messages endpoint), auth `x-api-key: <key>` + `anthropic-version`,
//                      a single tool whose `input_schema` is the stack schema, forced via `tool_choice`.
//                      Answer at the `tool_use` content block's `input` (already an object).
//
// The returned value is UNTRUSTED raw JSON — the caller (POST /v1/stacks/generate) runs it through
// `sanitizeStackConfig`. This module NEVER sees or forwards secrets (only the user's prompt + the public
// schema go out) and NEVER logs the API key or the full response body.
import type { Config } from "../config.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { STACK_JSON_SCHEMA } from "./schema.ts";

export interface LlmClient {
  /** Given the user's natural-language prompt, return the model's RAW JSON output (untrusted). Throws a
   *  clean Error (no key, no body) on a transport / provider / parse failure — the route maps it to a 502. */
  generateSpec(userPrompt: string): Promise<unknown>;
}

// The subset of the config this module needs. Kept narrow so tests can build one without a full Config.
type LlmConfig = Pick<Config, "llmUrl" | "llmApiKey" | "llmModel" | "llmStyle" | "llmTimeoutMs" | "llmMaxResponseBytes">;

// `fetch` is injectable purely for tests (client.test.ts scripts a fake); prod passes the global.
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ANTHROPIC_VERSION = "2023-06-01";
const TOOL_NAME = "emit_stack";

export function makeLlmClient(cfg: LlmConfig, fetchImpl: FetchLike = fetch): LlmClient {
  if (!cfg.llmUrl) throw new Error("DROP_LLM_URL is not set");

  const call = async (body: unknown): Promise<unknown> => {
    if (!cfg.llmModel) throw new Error("DROP_LLM_MODEL is not set");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.llmTimeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(cfg.llmUrl!, {
        method: "POST",
        signal: ctrl.signal,
        headers:
          cfg.llmStyle === "anthropic"
            ? { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, ...(cfg.llmApiKey ? { "x-api-key": cfg.llmApiKey } : {}) }
            : { "content-type": "application/json", ...(cfg.llmApiKey ? { authorization: `Bearer ${cfg.llmApiKey}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Includes the AbortError on timeout. Never surface the key/URL in the message.
      throw new Error((e as Error).name === "AbortError" ? "LLM request timed out" : "LLM request failed");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`); // status only — no body (may echo the prompt back)
    // Bounded read: reject an implausibly large body BEFORE parsing (a hostile/broken endpoint DoS bound).
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len && len > cfg.llmMaxResponseBytes) throw new Error("LLM response too large");
    const text = await res.text();
    if (text.length > cfg.llmMaxResponseBytes) throw new Error("LLM response too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("LLM response was not valid JSON");
    }
    return parsed;
  };

  const generateSpec = async (userPrompt: string): Promise<unknown> => {
    if (cfg.llmStyle === "anthropic") {
      const envelope = await call({
        model: cfg.llmModel,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [{ name: TOOL_NAME, description: "Emit the Drop stack spec.", input_schema: STACK_JSON_SCHEMA }],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userPrompt }],
      });
      return extractAnthropic(envelope);
    }
    const envelope = await call({
      model: cfg.llmModel,
      // The schema rides in the system message; json_object mode guarantees a parseable object back.
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\nReturn a JSON object matching this JSON schema:\n${JSON.stringify(STACK_JSON_SCHEMA)}` },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2048,
    });
    return extractOpenAI(envelope);
  };

  return { generateSpec };
}

/** Pull the JSON object out of an Anthropic /v1/messages response: the forced tool_use block's `input`. */
function extractAnthropic(envelope: unknown): unknown {
  const content = (envelope as { content?: unknown[] })?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type === "tool_use" && b.input && typeof b.input === "object") return b.input;
    }
  }
  throw new Error("LLM response had no tool output");
}

/** Pull the JSON object out of an OpenAI /chat/completions response: choices[0].message.content (a string). */
function extractOpenAI(envelope: unknown): unknown {
  const content = (envelope as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("LLM message content was not valid JSON");
    }
  }
  if (content && typeof content === "object") return content; // some gateways already return an object
  throw new Error("LLM response had no message content");
}
