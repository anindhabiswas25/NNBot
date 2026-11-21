import type { ItemData } from "../../shared/types";
import type { RawItem, SlotKey, Story } from "../types";
import { guessTopic } from "./clean";
import { log } from "../util";

const STOP = new Set("a an the and or of to in on for with by from at as is are was were be its it this that new how why what who will can after over into up out via vs about your our their his her has have had not more than".split(" "));

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const cosine = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
};

/** Free Gemini embeddings; returns null if no key or on failure (falls back to token overlap). */
async function embed(texts: string[], env: NodeJS.ProcessEnv): Promise<number[][] | null> {
  if (!env.GEMINI_API_KEY) return null;
  const model = env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
  try {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          requests: texts.slice(i, i + 100).map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, taskType: "CLUSTERING", outputDimensionality: 256 })),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const body: any = await res.json();
      out.push(...body.embeddings.map((e: any) => e.values as number[]));
    }
    return out;
  } catch (e) {
    log(`embeddings unavailable, using token overlap: ${(e as Error).message}`);
    return null;
  }
}

const NUM_KEYS: (keyof ItemData)[] = ["hf_upvotes", "citations", "influential", "downloads", "likes", "stars", "hn_points", "hn_comments"];

/** Step 4 — merge items about the same story; the story keeps every source link. */
export async function cluster(items: RawItem[], slot: SlotKey, env: NodeJS.ProcessEnv): Promise<Story[]> {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  // Same arXiv id → same story
  const byArxiv = new Map<string, number>();
  items.forEach((it, i) => {
    const id = it.ids?.arxiv ?? it.url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/)?.[1];
    if (!id) return;
    if (byArxiv.has(id)) union(i, byArxiv.get(id)!);
    else byArxiv.set(id, i);
  });

  const vecs = await embed(items.map((it) => `${it.title}. ${it.text.slice(0, 300)}`), env);
  const toks = items.map((it) => tokens(it.title));
  const sim = (i: number, j: number) => (vecs ? cosine(vecs[i], vecs[j]) : jaccard(toks[i], toks[j]));
  // gemini-embedding-001: unrelated news in one domain sits around 0.82 cosine, same-story pairs ≥ 0.95.
  // (The PRD's ~0.8 merges everything.) Measured 2026-11-21; override with CLUSTER_THRESHOLD.
  const threshold = vecs ? Number(env.CLUSTER_THRESHOLD ?? 0.93) : 0.5;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim(i, j) < threshold) continue;
      // Anti-chaining: must also be close to the root of the cluster it would join.
      const ri = find(i), rj = find(j);
      if (ri !== rj && (sim(i, rj) < threshold - 0.03 || sim(j, ri) < threshold - 0.03)) continue;
      union(i, j);
    }
  }

  const groups = new Map<number, RawItem[]>();
  items.forEach((it, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(it);
  });

  let id = 0;
  return [...groups.values()].map((group) => {
    // Primary = most trusted, then longest text
    const sorted = [...group].sort((a, b) => a.trust - b.trust || b.text.length - a.text.length);
    const p = sorted[0];
    const data: ItemData = {};
    for (const it of [...sorted].reverse()) Object.assign(data, Object.fromEntries(Object.entries(it.data).filter(([, v]) => v != null && v !== "")));
    for (const k of NUM_KEYS) {
      const vals = group.map((g) => g.data[k] as number | undefined).filter((v): v is number => typeof v === "number");
      if (vals.length) (data as any)[k] = Math.max(...vals);
    }
    const sources = [...new Set(group.map((g) => g.source))];
    data.sources_count = sources.length;
    const urls = [...new Set(sorted.flatMap((g) => [g.url, ...(g.extra_urls ?? [])]))];
    const g = guessTopic({ title: p.title, text: group.map((x) => x.text).join(" ").slice(0, 1500), topic_hint: p.topic_hint }, slot);
    return {
      id: id++,
      items: sorted,
      title: p.title,
      text: sorted.map((x) => x.text).filter(Boolean).join("\n").slice(0, 2500),
      urls,
      type: p.type,
      topic: g.topic,
      domain_ok: g.relevance > 0 || p.source !== "arXiv",
      data,
      sources,
      signal: 0,
      ai_score: 0,
    };
  });
}
