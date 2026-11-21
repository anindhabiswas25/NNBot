import { TOPICS, type TopicId } from "../../shared/config";
import { BLOCKED_DOMAINS, JUNK_PATTERNS } from "../sources";
import type { RawItem, SlotKey } from "../types";
import { canonicalUrl, sha1 } from "../util";

/** Step 2 — normalise into one Item format. */
export function normalise(items: RawItem[]): RawItem[] {
  return items
    .filter((i) => i.title && i.url)
    .map((i) => ({
      ...i,
      title: i.title.replace(/\s+/g, " ").trim().slice(0, 300),
      text: (i.text ?? "").replace(/\s+/g, " ").trim(),
      url: canonicalUrl(i.url),
      extra_urls: (i.extra_urls ?? []).map(canonicalUrl),
      published_at: isNaN(Date.parse(i.published_at)) ? new Date().toISOString() : new Date(i.published_at).toISOString(),
    }));
}

export const urlHash = (u: string) => sha1(canonicalUrl(u));
const titleKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Step 3 — exact dedupe on canonical URL + title hash, and drop anything sent in the last 7 days. */
export function exactDedupe(items: RawItem[], sentHashes: Set<string>): RawItem[] {
  const byKey = new Map<string, RawItem>();
  for (const it of items) {
    if (sentHashes.has(urlHash(it.url))) continue;
    const k = urlHash(it.url);
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, it);
    else {
      // same URL from two connectors (e.g. arXiv + HF Papers): merge data, keep the richer one
      const keep = prev.text.length >= it.text.length ? prev : it;
      const other = keep === prev ? it : prev;
      byKey.set(k, { ...keep, data: { ...other.data, ...stripUndef(keep.data) }, extra_urls: [...new Set([...(keep.extra_urls ?? []), ...(other.extra_urls ?? [])])] });
    }
  }
  // Same title from different URLs (syndicated copies) → keep the most trusted
  const byTitle = new Map<string, RawItem>();
  for (const it of byKey.values()) {
    const k = sha1(titleKey(it.title));
    const prev = byTitle.get(k);
    if (!prev || it.trust < prev.trust) byTitle.set(k, it);
  }
  return [...byTitle.values()];
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}

/** Step 5 (part) — junk filter: paid promos, press-release wires, price-prediction clickbait. */
export function isJunk(it: RawItem): string | null {
  const u = it.url.toLowerCase();
  const b = BLOCKED_DOMAINS.find((d) => u.includes(d));
  if (b) return `blocked domain ${b}`;
  const hay = `${it.title} ${it.text.slice(0, 300)}`;
  const p = JUNK_PATTERNS.find((re) => re.test(hay));
  if (p) return `junk pattern ${p}`;
  if (it.title.length < 12) return "title too short";
  return null;
}

/** Keyword topic guess (fallback for the AI tagger, and a relevance signal). */
export function keywordTopics(text: string): { topic: TopicId; hits: number }[] {
  const t = ` ${text.toLowerCase()} `;
  return TOPICS.map((tp) => ({ topic: tp.id, hits: tp.keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0) }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

export const SLOT_TOPICS: Record<SlotKey, TopicId[]> = {
  research: TOPICS.map((t) => t.id),
  crypto: ["bitcoin", "ethereum", "defi", "regulation", "aixcrypto"],
  launches: ["llms", "agents", "safety", "robotics", "vision", "aixcrypto"],
};

const DEFAULT_TOPIC: Record<SlotKey, TopicId> = { research: "llms", crypto: "defi", launches: "llms" };

export function guessTopic(it: { title: string; text: string; topic_hint?: TopicId }, slot: SlotKey): { topic: TopicId; relevance: number } {
  if (it.topic_hint) return { topic: it.topic_hint, relevance: 3 };
  const allowed = SLOT_TOPICS[slot];
  const title = keywordTopics(it.title);
  const body = keywordTopics(`${it.title} ${it.text.slice(0, 600)}`);
  const score = new Map<TopicId, number>();
  for (const x of title) score.set(x.topic, (score.get(x.topic) ?? 0) + 2 * x.hits);
  for (const x of body) score.set(x.topic, (score.get(x.topic) ?? 0) + x.hits);
  const best = [...score.entries()].filter(([t]) => allowed.includes(t)).sort((a, b) => b[1] - a[1])[0];
  return best ? { topic: best[0], relevance: best[1] } : { topic: DEFAULT_TOPIC[slot], relevance: 0 };
}
