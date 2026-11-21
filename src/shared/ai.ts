/**
 * Minimal AI client: Gemini first; on 429/error retry once, then Groq; throws if both fail
 * so the caller can fall back to code-only output (PRD § AI provider fallback).
 */
export interface AIEnv {
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  GEMINI_MODEL?: string;       // writer / judge / tutor
  GEMINI_LITE_MODEL?: string;  // tagger
  GROQ_MODEL?: string;
}

export type Tier = "flash" | "lite";

export interface AIRequest {
  system: string;
  prompt: string;
  json?: boolean;
  tier?: Tier;
  maxTokens?: number;
  temperature?: number;
}

export class AIUnavailable extends Error {}

/** Models that just returned 429 are skipped for a while instead of retried on every call. */
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

export function aiConfigured(env: AIEnv): boolean {
  return !!(env.GEMINI_API_KEY || env.GROQ_API_KEY);
}

const geminiModel = (env: AIEnv, tier: Tier) => (tier === "lite" ? env.GEMINI_LITE_MODEL || "gemini-3.5-flash-lite" : env.GEMINI_MODEL || "gemini-3.8-flash");

async function gemini(env: AIEnv, req: AIRequest, model: string): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxTokens ?? 8192,
        ...(req.json ? { responseMimeType: "application/json" } : {}),
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
  const maxTokens = Math.min(req.maxTokens ?? 3000, 3000);
  await groqPace(Math.ceil((req.system.length + req.prompt.length) / 3.5) + maxTokens);
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "openai/gpt-oss-120b",
      temperature: req.temperature ?? 0.3,
      // free tier counts prompt + max_tokens against an 8k tokens-per-minute cap
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  const text = body?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("groq empty response");
  return text;
}

export async function complete(env: AIEnv, req: AIRequest, log: (m: string) => void = console.warn): Promise<string> {
  if (env.GEMINI_API_KEY) {
    // requested model twice (503 "high demand" spikes are short), then the other tier's model once
    const primary = geminiModel(env, req.tier ?? "flash");
    const other = geminiModel(env, req.tier === "lite" ? "flash" : "lite");
    for (const [attempt, model] of [primary, primary, other].entries()) {
      if ((cooldownUntil.get(model) ?? 0) > Date.now()) continue;
      try {
        return await gemini(env, req, model);
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
      return await groq(env, req);
    } catch (e) {
      log(`[ai] groq failed: ${(e as Error).message}`);
    }
  }
  throw new AIUnavailable("no AI provider available");
}

/** Parse JSON from a model reply, tolerating ```json fences. */
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

export async function completeJson<T>(env: AIEnv, req: Omit<AIRequest, "json">, log?: (m: string) => void): Promise<T> {
  return parseJson<T>(await complete(env, { ...req, json: true }, log));
}
