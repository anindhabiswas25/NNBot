import { SLOTS, prettyDate, topicLabel, BOT_NAME } from "./config";
import type { Ranked } from "./rank";
import type { ItemData, PoolItem, SlotMeta } from "./types";

export interface InlineButton { text: string; callback_data?: string; url?: string }
export interface Rendered { text: string; reply_markup?: { inline_keyboard: InlineButton[][] } }

const MAX_LEN = 4096;
const NUM = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

export function esc(s: string | undefined | null): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function link(url: string, text: string): string {
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

export function fmtNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
export const fmtUsd = (n: number) => `$${fmtNum(n)}`;
export const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}%`;

const SENTIMENT = { positive: "🟢", neutral: "⚪", negative: "🔴" } as const;

/** One compact line of evidence for an item. Only numbers from ItemData (API data) are shown. */
export function dataLine(type: string, d: ItemData, sources: number): string {
  const parts: string[] = [];
  if (type === "paper") {
    parts.push(d.code_url ? "Code ✅" : "Code ❌");
    if (d.hf_upvotes) parts.push(`HF 🔥${d.hf_upvotes}`);
    if (d.citations) parts.push(`Cites ${d.citations}`);
    if (d.category) parts.push(d.category);
  } else if (type === "launch") {
    if (d.lab) parts.push(d.lab);
    if (d.model_size) parts.push(d.model_size);
    if (d.license) parts.push(d.license);
    if (d.downloads) parts.push(`⬇️${fmtNum(d.downloads)}`);
    if (d.version) parts.push(d.version);
    if (d.stars) parts.push(`⭐${fmtNum(d.stars)}`);
  } else {
    if (d.tvl) parts.push(`TVL ${fmtUsd(d.tvl)}${d.tvl_change_7d != null ? ` (${fmtPct(d.tvl_change_7d)} 7d)` : ""}`);
    if (d.price_change_24h != null) parts.push(`${d.coin ? `${d.coin} ` : ""}24h ${fmtPct(d.price_change_24h)}`);
    if (sources > 1) parts.push(`${sources} sources`);
    if (d.sentiment) parts.push(`Sentiment ${SENTIMENT[d.sentiment]}`);
  }
  if (d.hn_points) parts.push(`HN ▲${d.hn_points}`);
  return parts.join(" · ");
}

function sourcesCount(it: PoolItem): number {
  return it.data.sources_count ?? it.source_urls.length;
}

function renderItem(i: number, it: Ranked, depth: "quick" | "detailed", simpler: boolean): string {
  const url = it.source_urls[0];
  const head = `${NUM[i] ?? `${i}.`} <b>${url ? link(url, it.title) : esc(it.title)}</b>${it.wildcard ? " 🎲" : ""}`;
  const dl = dataLine(it.type, it.data, sourcesCount(it));
  const lines = [head];
  if (depth === "detailed") {
    const body = simpler && it.simple_words ? it.simple_words : it.summary_short;
    if (body) lines.push(esc(body));
    if (it.why_it_matters) lines.push(`💡 <i>Why it matters:</i> ${esc(it.why_it_matters)}`);
  }
  if (dl) lines.push(`📊 ${esc(dl)}`);
  return lines.join("\n");
}

function numberButtons(items: { item_id: number }[]): InlineButton[] {
  return items.map((it, i) => ({ text: `${i + 1}`, callback_data: `d:${it.item_id}` }));
}

function feedbackRow(slotDate: string, slot: number): InlineButton[] {
  return [
    { text: "👍 Useful", callback_data: `du:${slotDate}:${slot}` },
    { text: "👎 Not useful", callback_data: `dd:${slotDate}:${slot}` },
    { text: "⚙️ Topics", callback_data: "tp:menu" },
  ];
}

export function renderDigest(
  slot: number,
  slotDate: string,
  items: Ranked[],
  opts: { depth: "quick" | "detailed"; simpler?: boolean; meta?: SlotMeta },
): Rendered {
  const s = SLOTS[slot];
  if (s.key === "wrap") return renderWrap(slotDate, items, opts.meta ?? {});
  const header = `${s.emoji} <b>${s.name}</b> · ${prettyDate(slotDate)} · ${s.hour > 12 ? s.hour - 12 : s.hour}:00 ${s.hour >= 12 ? "PM" : "AM"}`;
  const footer: string[] = [];
  if (opts.meta?.note) footer.push(`<i>${esc(opts.meta.note)}</i>`);
  if (s.key === "crypto") footer.push("<i>Not financial advice.</i>");
  footer.push("Tap a number for details 👇");

  // Keep under Telegram's 4,096-char limit by dropping trailing items if needed.
  let shown = items;
  let text = "";
  while (shown.length > 0) {
    const body = shown.map((it, i) => renderItem(i + 1, it, opts.depth, !!opts.simpler)).join("\n\n");
    text = `${header}\n\n${body}\n\n${footer.join("\n")}`;
    if (text.length <= MAX_LEN) break;
    shown = shown.slice(0, -1);
  }
  return {
    text,
    reply_markup: { inline_keyboard: [numberButtons(shown), feedbackRow(slotDate, slot)] },
  };
}

export function renderWrap(slotDate: string, items: Ranked[] | PoolItem[], meta: SlotMeta): Rendered {
  const top = items.slice(0, 3);
  const lines = [`🌙 <b>Daily Wrap</b> · ${prettyDate(slotDate)}`, "", "<b>The 3 stories that mattered today</b>"];
  top.forEach((it, i) => {
    const url = it.source_urls[0];
    lines.push(`${NUM[i + 1]} ${url ? link(url, it.title) : esc(it.title)}`);
    if (it.summary_short) lines.push(`   ${esc(it.summary_short)}`);
  });
  if (meta.connection) lines.push("", `🔗 <b>How they connect:</b> ${esc(meta.connection)}`);
  if (meta.concept_title && meta.concept_body) {
    lines.push("", `📘 <b>Concept of the day: ${esc(meta.concept_title)}</b>`, esc(meta.concept_body));
  }
  if (meta.note) lines.push("", `<i>${esc(meta.note)}</i>`);
  lines.push("", "Tap a number for details 👇");
  return {
    text: lines.join("\n").slice(0, MAX_LEN),
    reply_markup: { inline_keyboard: [numberButtons(top), feedbackRow(slotDate, 3)] },
  };
}

const TYPE_EMOJI: Record<string, string> = { paper: "📄", launch: "🚀", news: "📰", data: "📊" };

export function renderDetail(it: PoolItem, opts: { saved?: boolean } = {}): Rendered {
  const d = it.data;
  const lines = [`${TYPE_EMOJI[it.type] ?? "📄"} <b>${esc(it.title)}</b>`];
  const meta: string[] = [];
  if (d.authors) meta.push(`👥 ${esc(d.authors)}`);
  if (d.lab && it.type !== "paper") meta.push(`🏷 ${esc(d.lab)}`);
  if (d.published) meta.push(esc(prettyDate(d.published.slice(0, 10))));
  if (d.category) meta.push(esc(d.category));
  meta.push(`#${esc(topicLabel(it.topic)).replace(/[^\p{L}\p{N}]+/gu, "")}`);
  lines.push(meta.join(" · "), "");

  if (d.tldr) lines.push(`<b>TL;DR:</b> ${esc(d.tldr)}`);
  if (it.summary_long) lines.push(esc(it.summary_long));
  if (it.simple_words) lines.push(`🧠 <b>In simple words:</b> ${esc(it.simple_words)}`);
  if (it.why_it_matters) lines.push(`💡 <b>Why it matters:</b> ${esc(it.why_it_matters)}`);

  const facts: string[] = [];
  if (d.citations != null) facts.push(`Citations ${d.citations}${d.influential ? ` (${d.influential} influential)` : ""}`);
  if (it.type === "paper") facts.push(d.code_url ? "Code ✅" : "Code ❌");
  if (d.hf_upvotes) facts.push(`HF 🔥${d.hf_upvotes}`);
  if (d.downloads) facts.push(`Downloads ${fmtNum(d.downloads)}`);
  if (d.likes) facts.push(`Likes ${fmtNum(d.likes)}`);
  if (d.stars) facts.push(`Stars ${fmtNum(d.stars)}`);
  if (d.model_size) facts.push(`Size ${esc(d.model_size)}`);
  if (d.license) facts.push(`Licence ${esc(d.license)}`);
  if (d.tvl) facts.push(`TVL ${fmtUsd(d.tvl)}${d.tvl_change_7d != null ? ` (${fmtPct(d.tvl_change_7d)} 7d)` : ""} (DefiLlama)`);
  if (d.price != null) facts.push(`${d.coin ? `${esc(d.coin)} price` : "Price"} $${d.price < 1 ? d.price.toPrecision(3) : d.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (CoinGecko)`);
  if (d.price_change_24h != null) facts.push(`${d.coin ? `${esc(d.coin)} ` : ""}24h ${fmtPct(d.price_change_24h)}`);
  if (d.price_change_7d != null) facts.push(`7d ${fmtPct(d.price_change_7d)}`);
  if (d.sources_count && d.sources_count > 1) facts.push(`${d.sources_count} sources`);
  if (d.sentiment) facts.push(`Sentiment ${SENTIMENT[d.sentiment]}`);
  if (d.hn_points) facts.push(`HN ▲${d.hn_points}${d.hn_comments ? ` · ${d.hn_comments} comments` : ""}`);
  if (facts.length) lines.push(`📈 ${facts.join(" · ")}`);

  const links: string[] = [];
  if (d.paper_url) links.push(link(d.paper_url, "Paper"));
  if (d.pdf_url) links.push(link(d.pdf_url, "PDF"));
  if (d.code_url) links.push(link(d.code_url, "Code"));
  if (d.hn_url) links.push(link(d.hn_url, "HN discussion"));
  const seen = new Set([d.paper_url, d.pdf_url, d.code_url, d.hn_url]);
  it.source_urls.filter((u) => !seen.has(u)).slice(0, 6).forEach((u) => links.push(link(u, hostOf(u))));
  if (links.length) lines.push(`🔗 ${links.join(" · ")}`);
  if (it.slot === 1 || it.topic === "defi" || it.topic === "bitcoin") lines.push("", "<i>Not financial advice.</i>");

  return {
    text: lines.join("\n").slice(0, MAX_LEN),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🧒 Explain simply", callback_data: `x:${it.item_id}` },
          { text: opts.saved ? "✅ Saved" : "🔖 Save", callback_data: `sv:${it.item_id}` },
        ],
        [
          { text: "➕ More like this", callback_data: `m:${it.item_id}` },
          { text: "➖ Less like this", callback_data: `l:${it.item_id}` },
        ],
      ],
    },
  };
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

export function helpText(repoUrl: string): string {
  return [
    `🧭 <b>${BOT_NAME}</b> — AI + crypto research, distilled 4× a day.`,
    "",
    "🔬 7 AM Research · 🪙 12 PM Crypto · 🤖 5 PM AI Launches · 🌙 10 PM Daily Wrap (IST)",
    "",
    "/today — re-send today's latest digest",
    "/topics — choose your topics",
    "/settings — depth, slots, role",
    "/saved — your saved items",
    "/feedback &lt;text&gt; — report a problem or suggest an idea",
    "/pause · /resume — stop or restart digests",
    "/deleteme — erase all your data",
    "/start — run setup again",
    "",
    "🔒 <b>Privacy:</b> we store only your Telegram ID, first name, language and preferences, plus what you tap so your briefing gets better. /deleteme erases it all instantly.",
    "⚠️ Nothing here is financial advice.",
    "",
    `⭐ Open source: ${link(repoUrl, "GitHub")}`,
  ].join("\n");
}
