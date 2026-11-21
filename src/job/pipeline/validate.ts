import { fmtNum } from "../../shared/render";
import type { NewPoolItem } from "../../shared/types";
import type { Story } from "../types";
import { firstSentence, truncate } from "../util";
import type { Written } from "./ai";

const BANNED = /\b(buy now|you should buy|sell now|price target|will (reach|hit|soar|moon)|to the moon|guaranteed|not to be missed|financial advice:)\b/i;

const LIMITS = { headline: 100, summary_short: 170, summary_long: 360, why_it_matters: 160, simple_words: 340 };

const numbersIn = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));

/** Everything the writer was allowed to draw numbers from, including our own formatted versions. */
function corpus(s: Story): string {
  const nums: string[] = [];
  for (const v of Object.values(s.data)) {
    if (typeof v !== "number") continue;
    nums.push(String(v), String(Math.round(v)), String(Math.abs(Math.round(v))), fmtNum(v), Math.abs(v).toFixed(1), Math.abs(v).toFixed(0));
  }
  return `${s.title} ${s.text} ${s.urls.join(" ")} ${s.data.tldr ?? ""} ${s.data.model_size ?? ""} ${s.data.version ?? ""} ${nums.join(" ")} ${s.sources.length}`.replace(/,(\d{3})/g, "$1");
}

/** Step 10 — every item has a URL, numbers match supplied data, lengths hold, no advice language. Failures are dropped. */
export function validate(s: Story, w: Written | undefined): { item?: NewPoolItem; reason?: string } {
  if (!s.urls.length) return { reason: "no url" };
  if (!w) return { reason: "writer returned nothing" };
  const fields = {
    headline: (w.headline ?? "").trim(),
    summary_short: (w.summary_short ?? "").trim(),
    summary_long: (w.summary_long ?? "").trim(),
    why_it_matters: (w.why_it_matters ?? "").trim(),
    simple_words: (w.simple_words ?? "").trim(),
  };
  if (!fields.headline || !fields.summary_short) return { reason: "missing headline/summary" };

  const all = Object.values(fields).join(" ");
  if (BANNED.test(all)) return { reason: "advice/prediction language" };

  const src = corpus(s);
  const unsupported = numbersIn(all).filter((n) => !src.includes(n) && !(Number(n) <= 10 && Number.isInteger(Number(n))));
  if (unsupported.length) return { reason: `unsupported numbers ${unsupported.join(",")}` };

  for (const [k, max] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    if (fields[k].length > max * 1.5) return { reason: `${k} too long` };
    fields[k] = truncate(fields[k], max);
  }

  const urls = s.urls.includes(w.source_url) ? [w.source_url, ...s.urls.filter((u) => u !== w.source_url)] : s.urls;
  return {
    item: {
      type: s.type,
      topic: s.topic,
      title: fields.headline,
      summary_short: fields.summary_short,
      summary_long: fields.summary_long,
      why_it_matters: fields.why_it_matters,
      simple_words: fields.simple_words,
      data: s.data,
      source_urls: urls.slice(0, 8),
      ai_score: +s.ai_score.toFixed(2),
    },
  };
}

/** Code-only summary used when every AI provider is down. */
export function fallbackItem(s: Story): NewPoolItem {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const text = norm(s.text).startsWith(norm(s.title)) ? s.text.slice(s.title.length).trim() : s.text;
  return {
    type: s.type,
    topic: s.topic,
    title: truncate(s.title, 100),
    summary_short: text.length > 20 ? firstSentence(text, 160) : "",
    summary_long: text.length > 20 ? truncate(text, 300) : "",
    why_it_matters: "",
    simple_words: "",
    data: s.data,
    source_urls: s.urls.slice(0, 8),
    ai_score: +s.ai_score.toFixed(2),
  };
}
