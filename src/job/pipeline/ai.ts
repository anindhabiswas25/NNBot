import { completeJson, type AIEnv } from "../../shared/ai";
import { BOT_NAME, TOPICS, type TopicId } from "../../shared/config";
import type { PoolItem } from "../../shared/types";
import type { SlotKey, Story } from "../types";
import { log, pool, sleep, truncate } from "../util";
import { SLOT_TOPICS } from "./clean";

const aiLog = (m: string) => log(m);

const RULES = `Rules: be neutral and factual. Never give financial advice, buy/sell calls, price targets or predictions. Never invent facts, names or numbers.`;

// ───────────────────────── Tagger (Flash-Lite, batched) ─────────────────────────

interface TagOut { id: number; topic: TopicId; type: Story["type"]; difficulty: string; aixcrypto: boolean; relevant: boolean }

export async function tagStories(env: AIEnv, stories: Story[], slot: SlotKey): Promise<void> {
  const allowed = SLOT_TOPICS[slot];
  const topicList = TOPICS.filter((t) => allowed.includes(t.id)).map((t) => `${t.id} (${t.label})`).join(", ");
  const audience = slot === "crypto" ? "crypto/blockchain" : slot === "research" ? "AI or blockchain research" : "AI";
  for (let i = 0; i < stories.length; i += 30) {
    const batch = stories.slice(i, i + 30);
    const res = await completeJson<{ items: TagOut[] }>(
      env,
      {
        tier: "lite",
        system: `You tag news items for ${BOT_NAME}, a briefing for students and researchers in AI and crypto. ${RULES}`,
        prompt: `Allowed topics: ${topicList}.
For each item return: id, topic (one allowed id), type (paper|launch|news|data), difficulty (intro|intermediate|advanced), aixcrypto (true if it genuinely involves both AI and crypto), relevant (false if it is not really about ${audience}, is an advert/promo, or is trivial).
Return JSON {"items":[...]} with one entry per input.

Items:
${batch.map((s) => JSON.stringify({ id: s.id, title: s.title, text: truncate(s.text, 300), source: s.sources[0] })).join("\n")}`,
      },
      aiLog,
    ).catch((e) => (aiLog(`tagger batch failed: ${(e as Error).message}`), { items: [] as TagOut[] }));
    for (const t of res.items ?? []) {
      const s = stories.find((x) => x.id === t.id);
      if (!s) continue;
      if (allowed.includes(t.topic)) s.topic = t.aixcrypto && allowed.includes("aixcrypto") ? "aixcrypto" : t.topic;
      // type comes from the connector (arXiv → paper, HF/GitHub → launch …); the tagger doesn't override it
      s.difficulty = t.difficulty;
      s.domain_ok = t.relevant !== false;
    }
  }
}

// ───────────────────────── Judge (Flash) ─────────────────────────

interface JudgeOut { id: number; novelty: number; impact: number; evidence: number; usefulness: number; reason: string }

export async function judgeStories(env: AIEnv, stories: Story[], slot: SlotKey): Promise<void> {
  const focus: Record<SlotKey, string> = {
    research: "new research papers: favour genuine novelty, strong evidence (code, benchmarks, citations) and clear takeaways",
    crypto: "crypto news: favour corroborated, substantive developments (protocol launches, regulation, security incidents, adoption data); penalise hype, rumours and price chatter",
    launches: "AI launches: favour significant new models, tools and products from credible sources; penalise minor updates and marketing",
  };
  for (let i = 0; i < stories.length; i += 20) {
    const batch = stories.slice(i, i + 20);
    const res = await completeJson<{ items: JudgeOut[] }>(
      env,
      {
        system: `You are the editor of ${BOT_NAME}. Judge ${focus[slot]}. ${RULES}`,
        prompt: `Score each item 1–10 on novelty, impact, evidence and usefulness to students/researchers, plus a reason (max 15 words).
Return JSON {"items":[{"id":0,"novelty":7,"impact":6,"evidence":8,"usefulness":7,"reason":"..."}]}.

Items:
${batch.map((s) => JSON.stringify({ id: s.id, title: s.title, topic: s.topic, sources: s.sources.length, facts: compactFacts(s), text: truncate(s.text, 400) })).join("\n")}`,
      },
      aiLog,
    ).catch((e) => (aiLog(`judge batch failed: ${(e as Error).message}`), { items: [] as JudgeOut[] }));
    for (const j of res.items ?? []) {
      const s = stories.find((x) => x.id === j.id);
      if (!s) continue;
      const vals = [j.novelty, j.impact, j.evidence, j.usefulness].map(Number).filter((v) => v >= 1 && v <= 10);
      if (vals.length) s.judge = vals.reduce((a, b) => a + b, 0) / vals.length;
      s.judge_reason = j.reason;
    }
  }
}

function compactFacts(s: Story) {
  const d = s.data;
  return Object.fromEntries(
    Object.entries({ hf_upvotes: d.hf_upvotes, citations: d.citations, code: d.code_url ? true : undefined, hn_points: d.hn_points, stars: d.stars, likes: d.likes, tvl: d.tvl, tvl_change_7d: d.tvl_change_7d, price_change_24h: d.price_change_24h, license: d.license, size: d.model_size }).filter(([, v]) => v != null),
  );
}

// ───────────────────────── Writer (Flash) ─────────────────────────

export interface Written {
  id: number;
  headline: string;
  summary_short: string;
  summary_long: string;
  why_it_matters: string;
  simple_words: string;
  source_url: string;
}

export async function writeStories(env: AIEnv, stories: Story[]): Promise<Map<number, Written>> {
  const out = new Map<number, Written>();
  const batches: Story[][] = [];
  for (let i = 0; i < stories.length; i += 5) batches.push(stories.slice(i, i + 5));
  await pool(batches, 1, async (batch) => {
    let res: { items: Written[] } | undefined;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await completeJson<{ items: Written[] }>(
        env,
        {
          system: `You write ${BOT_NAME} briefings for students and researchers. Use ONLY the supplied text and facts — if something isn't there, leave it out. Only use numbers that appear in the supplied text or facts. Plain, friendly English; no hype words (revolutionary, game-changing, huge). ${RULES}`,
          prompt: `For each story write:
- headline: ≤ 80 chars, specific, no clickbait
- summary_short: 1 line, ≤ 140 chars
- summary_long: 2 lines, ≤ 300 chars
- why_it_matters: ≤ 120 chars, for a student or researcher
- simple_words: ≤ 280 chars, explain like to a first-year student
- source_url: the URL (from the story's urls) that supports the claims
Return JSON {"items":[{"id":0,"headline":"","summary_short":"","summary_long":"","why_it_matters":"","simple_words":"","source_url":""}]}.

Stories:
${batch.map((s) => JSON.stringify({ id: s.id, type: s.type, title: s.title, urls: s.urls.slice(0, 4), facts: compactFacts(s), tldr: s.data.tldr, text: truncate(s.text, 900) })).join("\n\n")}`,
        },
        aiLog,
      );
      } catch (e) {
        aiLog(`writer batch failed (attempt ${attempt + 1}): ${(e as Error).message}`);
        if (attempt === 0) await sleep(65_000); // Groq's free tier is limited per minute
      }
    }
    if (!res) return; // caller uses code-only summaries for these stories
    for (const w of res.items ?? []) if (typeof w.id === "number") out.set(w.id, w);
  });
  return out;
}

// ───────────────────────── Connector (Daily Wrap) ─────────────────────────

export interface WrapOut { top_ids: number[]; connection: string; concept_title: string; concept_body: string }

export async function connectStories(env: AIEnv, items: PoolItem[]): Promise<WrapOut> {
  return completeJson<WrapOut>(
    env,
    {
      system: `You write the ${BOT_NAME} Daily Wrap for students and researchers in AI and crypto. Use ONLY the supplied items. ${RULES}`,
      prompt: `From today's items:
1. Pick the 3 stories that mattered most (top_ids, by item_id), preferring variety across AI and crypto.
2. connection: ≤ 2 short lines on how they connect (a real link — a shared trend, technique or tension; don't force it).
3. concept_title + concept_body: one Concept of the day that today's stories touch (e.g. "Restaking", "Mixture of experts"), explained in 4 plain lines (≤ 400 chars) for a first-year student.
Return JSON {"top_ids":[..],"connection":"","concept_title":"","concept_body":""}.

Items:
${items.map((i) => JSON.stringify({ item_id: i.item_id, title: i.title, topic: i.topic, summary: i.summary_short, score: i.ai_score })).join("\n")}`,
    },
    aiLog,
  );
}

// ───────────────────────── Feedback sorter (weekly) ─────────────────────────

export async function sortFeedback(env: AIEnv, rows: { id: number; text: string }[]): Promise<{ id: number; category: string }[]> {
  if (!rows.length) return [];
  const res = await completeJson<{ items: { id: number; category: string }[] }>(
    env,
    {
      tier: "lite",
      system: "You sort user feedback for a Telegram news bot.",
      prompt: `Label each message as bug, idea or content (complaint about the content of briefings). Return JSON {"items":[{"id":1,"category":"bug"}]}.\n\n${rows.map((r) => JSON.stringify({ id: r.id, text: r.text.slice(0, 400) })).join("\n")}`,
    },
    aiLog,
  );
  return (res.items ?? []).filter((r) => ["bug", "idea", "content"].includes(r.category));
}
