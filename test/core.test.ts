import assert from "node:assert/strict";
import { test } from "node:test";
import { slotSendTime, istDate } from "../src/shared/config";
import { isWildcardSlot, rankForUser, userScore } from "../src/shared/rank";
import { renderDetail, renderDigest } from "../src/shared/render";
import type { PoolItem, UserPrefs } from "../src/shared/types";
import { exactDedupe, isJunk, normalise, urlHash } from "../src/job/pipeline/clean";
import { validate } from "../src/job/pipeline/validate";
import type { RawItem, Story } from "../src/job/types";
import { canonicalUrl } from "../src/job/util";

const item = (id: number, topic: string, ai: number, over: Partial<PoolItem> = {}): PoolItem => ({
  item_id: id, slot_date: "2026-11-21", slot: 0, type: "paper", topic, title: `Item ${id} <b>`, summary_short: "short", summary_long: "long",
  why_it_matters: "why", simple_words: "simple", data: {}, source_urls: [`https://example.com/${id}`], ai_score: ai, ...over,
});
const user = (weights: Record<string, number>, over: Partial<UserPrefs> = {}): UserPrefs => ({
  tg_user_id: 1, role: null, depth: "detailed", slots: 15, language: "en", weights, ...over,
});

test("user_score = AI_score × (1 + weight/10)", () => {
  assert.equal(userScore(item(1, "llms", 5), user({ llms: 10 })), 10);
  assert.equal(userScore(item(1, "llms", 5), user({ llms: 0 })), 5);
  assert.equal(userScore(item(1, "llms", 5), user({ llms: 20 })), 15);
});

test("rank: 7 detailed / 5 quick, max 3 per topic", () => {
  const pool = ["llms", "agents", "safety"].flatMap((t, k) => [...Array(5)].map((_, i) => item(k * 100 + i, t, 9 - i * 0.1)));
  const d = rankForUser(pool, user({ llms: 10, agents: 10, safety: 10 }));
  assert.equal(d.length, 7);
  for (const t of ["llms", "agents", "safety"]) assert.ok(d.filter((i) => i.topic === t).length <= 3);
  assert.equal(rankForUser(pool, user({ llms: 10 }, { depth: "quick" })).length, 5);
});

test("rank: narrow pool tops up past the per-topic cap instead of sending a short brief", () => {
  const pool = [...Array(10)].map((_, i) => item(i, "llms", 5));
  assert.equal(rankForUser(pool, user({ llms: 10 })).length, 7);
});

test("rank: wildcard comes from outside the user's topics", () => {
  const pool = [item(1, "llms", 5), item(2, "llms", 5), item(3, "defi", 9), item(4, "agents", 4)];
  const r = rankForUser(pool, user({ llms: 10, agents: 10 }), { wildcard: true, limit: 3 });
  const wild = r.find((i) => i.wildcard);
  assert.equal(wild?.topic, "defi");
});

test("wildcard slot = user's first enabled content slot", () => {
  assert.equal(isWildcardSlot(user({}, { slots: 0b1111 }), 0), true);
  assert.equal(isWildcardSlot(user({}, { slots: 0b1110 }), 1), true);
  assert.equal(isWildcardSlot(user({}, { slots: 0b1110 }), 2), false);
});

test("digest render escapes HTML, stays under 4096, crypto has disclaimer", () => {
  const items = [...Array(7)].map((_, i) => ({ ...item(i, "defi", 5, { summary_short: "x".repeat(900) }), user_score: 1 }));
  const r = renderDigest(1, "2026-11-21", items, { depth: "detailed" });
  assert.ok(r.text.length <= 4096);
  assert.ok(r.text.includes("Not financial advice"));
  assert.ok(r.text.includes("&lt;b&gt;"));
  assert.equal(r.reply_markup!.inline_keyboard[0].length < 7, true); // trimmed items → fewer buttons
  for (const row of r.reply_markup!.inline_keyboard) for (const b of row) assert.ok(!b.callback_data || Buffer.byteLength(b.callback_data) <= 64);
});

test("detail card has buttons and links", () => {
  const r = renderDetail(item(5, "llms", 5, { data: { code_url: "https://github.com/x/y", citations: 12, influential: 4 } }));
  assert.ok(r.text.includes("Citations 12 (4 influential)"));
  assert.deepEqual(r.reply_markup!.inline_keyboard.flat().map((b) => b.callback_data), ["x:5", "sv:5", "m:5", "l:5"]);
});

test("IST slot times", () => {
  assert.equal(slotSendTime("2026-11-21", 0).toISOString(), "2026-11-21T01:30:00.000Z");
  assert.equal(slotSendTime("2026-11-21", 3).toISOString(), "2026-11-21T16:30:00.000Z");
  assert.equal(istDate(new Date("2026-11-21T19:00:00Z")), "2026-11-22");
});

test("canonical URL strips tracking and arXiv versions", () => {
  assert.equal(canonicalUrl("http://www.example.com/a/?utm_source=x&id=2#frag"), "https://example.com/a?id=2");
  assert.equal(canonicalUrl("https://arxiv.org/pdf/2611.12345v3"), "https://arxiv.org/abs/2611.12345");
});

const raw = (title: string, url: string, over: Partial<RawItem> = {}): RawItem => ({
  title, text: "body text", url, source: "S", published_at: new Date().toISOString(), type: "news", trust: 2, data: {}, ...over,
});

test("dedupe: same URL merges, sent URLs drop, syndicated titles collapse", () => {
  const items = normalise([
    raw("Protocol X launches V2", "https://a.com/x?utm_source=tw"),
    raw("Protocol X launches V2", "https://a.com/x"),
    raw("Protocol X launches V2", "https://b.com/copy", { trust: 3 }),
    raw("Old story", "https://c.com/old"),
  ]);
  const out = exactDedupe(items, new Set([urlHash("https://c.com/old")]));
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://a.com/x");
});

test("junk filter catches promos and predictions", () => {
  assert.ok(isJunk(raw("XRP price prediction: will it reach $10?", "https://x.com/a")));
  assert.ok(isJunk(raw("Top 5 altcoins to buy this week", "https://x.com/b")));
  assert.ok(isJunk(raw("Token launch", "https://globenewswire.com/news/1")));
  assert.equal(isJunk(raw("Ethereum developers schedule Fusaka upgrade", "https://x.com/c")), null);
});

const story = (over: Partial<Story> = {}): Story => ({
  id: 1, items: [], title: "Sparse attention cuts inference cost 60%", text: "We cut cost by 60% on 3 benchmarks.", urls: ["https://arxiv.org/abs/2611.1"],
  type: "paper", topic: "llms", domain_ok: true, data: { hf_upvotes: 214 }, sources: ["arXiv"], signal: 5, ai_score: 7, ...over,
});
const w = (over = {}) => ({ id: 1, headline: "Sparse attention cuts cost 60%", summary_short: "Skips most tokens.", summary_long: "", why_it_matters: "Cheaper AI.", simple_words: "", source_url: "https://arxiv.org/abs/2611.1", ...over });

test("validate: accepts supported numbers, rejects invented ones and advice", () => {
  assert.ok(validate(story(), w()).item);
  assert.match(validate(story(), w({ summary_short: "Upvoted 214 times on HF." })).item!.summary_short, /214/);
  assert.match(validate(story(), w({ summary_short: "Saves $4,500 per month." })).reason!, /unsupported numbers/);
  assert.match(validate(story(), w({ why_it_matters: "You should buy this token now" })).reason!, /advice/);
  assert.equal(validate(story({ urls: [] }), w()).reason, "no url");
});

test("rank: one website fills at most limit − 2 items when others exist", () => {
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => item(100 + i, ["llms", "vision", "robotics", "agents"][i % 4], 9 - i * 0.1, { source_urls: [`https://arxiv.org/abs/${i}`] })),
    item(200, "llms", 4, { source_urls: ["https://research.google/blog/x"] }),
    item(201, "vision", 3, { source_urls: ["https://machinelearning.apple.com/y"] }),
  ];
  const r = rankForUser(pool, user(Object.fromEntries(["llms", "vision", "robotics", "agents"].map((t) => [t, 10]))));
  assert.equal(r.length, 7);
  assert.equal(r.filter((i) => i.source_urls[0].includes("arxiv.org")).length, 5);
  // only arXiv available → still a full briefing
  assert.equal(rankForUser(pool.slice(0, 10), user(Object.fromEntries(["llms", "vision", "robotics", "agents"].map((t) => [t, 10])))).length, 7);
});

test("page description: meta description + first real paragraph, no repeats", async () => {
  const { pageDescription } = await import("../src/job/pipeline/describe");
  const html = `<html><head><meta property="og:description" content="Signal explains how AI agents in mobile OSes can read private chats."></head>
    <body><nav><p>Home About Blog Contact and a lot of other navigation text that is long enough to pass</p></nav>
    <p>By Jane</p><p>Operating systems are adding AI agents that can see everything on screen, including end-to-end encrypted messages, and Signal is asking platforms for an opt-out.</p></body></html>`;
  const d = pageDescription(html);
  assert.match(d, /^Signal explains/);
  assert.match(d, /opt-out/);
  assert.doesNotMatch(d, /navigation|By Jane/);
});

test("junk: de-safetied model uploads are filtered", () => {
  const base: RawItem = { title: "OpenUncensored releases Inkling-2-Mini-Uncensored", text: "", url: "https://huggingface.co/x/y", source: "HF", published_at: new Date().toISOString(), type: "launch", trust: 2, data: {} };
  assert.ok(isJunk(base));
  assert.equal(isJunk({ ...base, title: "A study of jailbreak robustness in LLM safety training" }), null);
});

test("describe: internal addresses are never fetched", async () => {
  const { isPrivateIp } = await import("../src/job/pipeline/describe");
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1",
    // IPv4 hidden inside IPv6, in every spelling
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:0:4136:e378::1", "0:0:0:0:0:ffff:7f00:0001",
  ]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::6810:84e5"]) assert.equal(isPrivateIp(ip), false, ip);
});

test("codeUrlFrom: pulls repo links out of arXiv abstracts", async () => {
  const { codeUrlFrom } = await import("../src/job/connectors/arxiv");
  assert.equal(codeUrlFrom("Code is available at https://github.com/ambroise-b/hisa."), "https://github.com/ambroise-b/hisa");
  assert.equal(codeUrlFrom("see github.com/nari-labs/nari-llama.cpp."), "https://github.com/nari-labs/nari-llama.cpp");
  assert.equal(codeUrlFrom("repo: https://GitHub.com/a/b.git, thanks"), "https://github.com/a/b");
  assert.equal(codeUrlFrom("project page https://dreamtechai.github.io/Direct3D-V3"), undefined);
  assert.equal(codeUrlFrom("no links here"), undefined);
});

test("dataLine: labels a price move with its coin ticker", async () => {
  const { dataLine } = await import("../src/shared/render");
  assert.match(dataLine("news", { coin: "BTC", price_change_24h: 5.9 }, 1), /BTC 24h \+5\.9%/);
  assert.match(dataLine("news", { price_change_24h: 5.9 }, 1), /^24h \+5\.9%/);
});
