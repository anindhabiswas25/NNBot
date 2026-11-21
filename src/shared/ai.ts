/**
 * AI client. Claude (Haiku 5.5) first; Gemini → Groq (free tiers) as fallbacks when Claude is
 * missing, failing, or over the monthly budget. Throws AIUnavailable if everything fails so the
 * caller can fall back to code-only output (PRD § AI provider fallback).
 *
 * Token discipline for Claude:
 *  - structured outputs (JSON schema) → always-parseable replies, no re-sends for bad JSON
 *  - thinking off by default (it is billed as output) and `effort` set per call
 *  - every call's usage is tallied; Claude is skipped once the month's budget is spent
 */
import Anthropic from "@anthropic-ai/sdk";

export interface AIEnv {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  /** Monthly Claude budget in USD (default 1). */
  CLAUDE_MONTHLY_BUDGET_USD?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_LITE_MODEL?: string;
  GROQ_MODEL?: string;
}

export type Tier = "flash" | "lite";
export type Effort = "low" | "medium" | "high";

export interface AIRequest {
  /** Short name for usage logs, e.g. "rank", "writer". */
  label: string;
  system: string;
  prompt: string;
  /** JSON schema for the reply (objects need additionalProperties: false). Implies JSON output. */
  schema?: Record<string, unknown>;
  effort?: Effort;
  /** Let the model think before answering. Off by default: thinking is billed as output, and
   *  measured on this pipeline it was ~70% of writer output with no need for it. */
  think?: boolean;
  /** Hard cap on one reply, thinking included. Generous on purpose: a cut-off reply is wasted spend. */
  maxTokens?: number;
  /** Gemini fallback model tier. */
  tier?: Tier;
}

export class AIUnavailable extends Error {}

const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
/** USD per million tokens (prompts ≤ 100k tokens). Unknown models are tallied but not priced. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
};

// ───────────────────────── usage + budget ─────────────────────────

export interface UsageLine { calls: number; input: number; output: number; thinking: number; usd: number }
const usage = new Map<string, UsageLine>();
let spentBefore = 0; // USD already spent this month before this run
let budgetUsd = 1;

/** Call once at job start with this month's spend so far (from the state store). */
export function initBudget(env: AIEnv, monthSpentUsd: number) {
  spentBefore = monthSpentUsd;
  budgetUsd = Number(env.CLAUDE_MONTHLY_BUDGET_USD ?? 1) || 1;
}

export function runSpendUsd(): number {
  return [...usage.values()].reduce((a, u) => a + u.usd, 0);
}

export function usageReport(): string {
  const lines = [...usage.entries()].map(
    ([k, u]) => `  ${k}: ${u.calls} calls, in ${u.input}, out ${u.output} (thinking ${u.thinking}), $${u.usd.toFixed(4)}`,
  );
  return `[ai] Claude usage this run — $${runSpendUsd().toFixed(4)} (month ${(spentBefore + runSpendUsd()).toFixed(4)} / ${budgetUsd})\n${lines.join("\n") || "  none"}`;
}

const overBudget = () => spentBefore + runSpendUsd() >= budgetUsd;

function tally(label: string, model: string, u: Anthropic.Usage) {
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  const thinking = (u as { output_tokens_details?: { thinking_tokens?: number } }).output_tokens_details?.thinking_tokens ?? 0;
  const p = PRICES[model];
  const usd = p ? (input * p.in + output * p.out) / 1e6 : 0;
  const line = usage.get(label) ?? { calls: 0, input: 0, output: 0, thinking: 0, usd: 0 };
  usage.set(label, { calls: line.calls + 1, input: line.input + input, output: line.output + output, thinking: line.thinking + thinking, usd: line.usd + usd });
}

// ───────────────────────── providers ─────────────────────────

export function aiConfigured(env: AIEnv): boolean {
  return !!(env.ANTHROPIC_API_KEY || env.GEMINI_API_KEY || env.GROQ_API_KEY);
}

let client: Anthropic | undefined;

async function claude(env: AIEnv, req: AIRequest): Promise<string> {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const res = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 8000,
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
    // Haiku 5.5 thinks by default; "disabled" is allowed at effort high or below
    thinking: req.think ? { type: "adaptive" } : { type: "disabled" },
    output_config: {
      effort: req.effort ?? "medium",
      ...(req.schema ? { format: { type: "json_schema" as const, schema: req.schema } } : {}),
    },
  });
  tally(req.label, model, res.usage);
  if (res.stop_reason === "refusal") throw new Error("claude refused");
  if (res.stop_reason === "max_tokens") throw new Error(`claude hit max_tokens (${req.maxTokens ?? 8000})`);
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (!text) throw new Error("claude empty response");
  return text;
}

/** Gemini models that just returned 429 are skipped for a while instead of retried on every call. */
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 10 * 60_000;

/** Groq free tier: ~8k tokens per minute (prompt + max_tokens). Pace calls instead of failing. */
const GROQ_TPM = 7500;
const groqWindow: { at: number; tokens: number }[] = [];
async function groqPace(tokens: number) {
  for (;;) {
    const now = Date.now();
    while (groqWindow.length && now - groqWindow[0].at > 60_000) groqWindow.shift();
    const used = groqWindow.reduce((a, w) => a + w.tokens, 0);
    if (used + tokens <= GROQ_TPM || !groqWindow.length) break;
    await sleep(60_000 - (now - groqWindow[0].at) + 250);
  }
  groqWindow.push({ at: Date.now(), tokens });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const geminiModel = (env: AIEnv, tier: Tier) => (tier === "lite" ? env.GEMINI_LITE_MODEL || "gemini-3.5-flash-lite" : env.GEMINI_MODEL || "gemini-3.8-flash");

async function gemini(env: AIEnv, req: AIRequest, model: string): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        ...(req.schema ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error(`gemini empty response: ${JSON.stringify(body).slice(0, 300)}`);
  return text;
}

async function groq(env: AIEnv, req: AIRequest): Promise<string> {
  const maxTokens = 3000;
  await groqPace(Math.ceil((req.system.length + req.prompt.length) / 3.5) + maxTokens);
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "openai/gpt-oss-120b",
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      ...(req.schema ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  const text = body?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("groq empty response");
  return text;
}

/** Free fallbacks get the schema spelled out in the prompt, since they can't enforce it. */
function withSchemaHint(req: AIRequest): AIRequest {
  if (!req.schema) return req;
  return { ...req, prompt: `${req.prompt}\n\nReply with JSON only, matching this JSON schema:\n${JSON.stringify(req.schema)}` };
}

let budgetWarned = false;

export async function complete(env: AIEnv, req: AIRequest, log: (m: string) => void = console.warn): Promise<string> {
  if (env.ANTHROPIC_API_KEY) {
    if (overBudget()) {
      if (!budgetWarned) log(`[ai] Claude monthly budget ($${budgetUsd}) reached — using free fallbacks`);
      budgetWarned = true;
    } else {
      try {
        return await claude(env, req);
      } catch (e) {
        log(`[ai] claude ${req.label} failed: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
      }
    }
  }
  const free = withSchemaHint(req);
  if (env.GEMINI_API_KEY) {
    const primary = geminiModel(env, req.tier ?? "flash");
    const other = geminiModel(env, req.tier === "lite" ? "flash" : "lite");
    for (const [attempt, model] of [primary, primary, other].entries()) {
      if ((cooldownUntil.get(model) ?? 0) > Date.now()) continue;
      try {
        return await gemini(env, free, model);
      } catch (e) {
        const msg = (e as Error).message;
        log(`[ai] gemini ${model} attempt ${attempt + 1} failed: ${msg.split("\n")[0].slice(0, 160)}`);
        if (msg.startsWith("gemini 429")) cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
        else if (attempt === 0) await sleep(3000);
      }
    }
  }
  if (env.GROQ_API_KEY) {
    try {
      return await groq(env, free);
    } catch (e) {
      log(`[ai] groq failed: ${(e as Error).message}`);
    }
  }
  throw new AIUnavailable("no AI provider available");
}

/** Parse JSON from a model reply, tolerating ```json fences (free fallbacks). */
export function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error("model did not return JSON");
  }
}

export async function completeJson<T>(env: AIEnv, req: AIRequest & { schema: Record<string, unknown> }, log?: (m: string) => void): Promise<T> {
  return parseJson<T>(await complete(env, req, log));
}

/** Small helper for strict JSON schemas: an object whose every property is required. */
export function obj(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
