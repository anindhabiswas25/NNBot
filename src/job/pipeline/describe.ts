import type { Story } from "../types";
import { http, log, pool, stripHtml, truncate } from "../util";

/**
 * Link posts (mostly Hacker News) arrive with only a title. For those, fetch the linked page and
 * use its own description (og:/meta description) plus its first real paragraphs, so the AI can
 * judge and summarise what the story actually says. Free to fetch; failures keep the title.
 */

/** Text that adds nothing beyond the title. */
const isThin = (s: Story) => {
  const t = s.text.trim();
  return t.length < 120 || t === s.title.trim();
};

/** Pages that aren't articles, or that block bots / need JS. */
const SKIP = /\.(pdf|png|jpe?g|gif|webp|mp4|zip|gz)(\?|$)|news\.ycombinator\.com|youtube\.com|youtu\.be|(^|\/\/)(x|twitter)\.com|reddit\.com/i;

function metaContent(html: string, key: string): string {
  const k = key.replace(":", "\\:");
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']+)["']`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${k}["']`, "i"));
  // twice: some sites double-encode entities (&amp;quot;)
  return stripHtml(stripHtml(a?.[1] ?? b?.[1] ?? "")).trim();
}

function firstParagraphs(html: string, max = 900): string {
  const body = html.replace(/<(script|style|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const out: string[] = [];
  let len = 0;
  for (const m of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const p = stripHtml(m[1]).replace(/\s+/g, " ").trim();
    // real prose only: skip bylines, cookie notices, captions
    if (p.length < 80 || /cookie|subscribe|sign up|javascript|all rights reserved/i.test(p)) continue;
    out.push(p);
    len += p.length;
    if (len >= max || out.length >= 3) break;
  }
  return out.join(" ");
}

/** Exposed for tests. */
export function pageDescription(html: string): string {
  const desc = metaContent(html, "og:description") || metaContent(html, "description") || metaContent(html, "twitter:description");
  const paras = firstParagraphs(html);
  const norm = (x: string) => x.toLowerCase().replace(/\W+/g, " ").trim();
  // skip the paragraphs when they just repeat the description
  const repeats = desc && norm(paras).startsWith(norm(desc).slice(0, 60));
  const text = repeats ? desc : [desc, paras].filter(Boolean).join(" ");
  return truncate(text.replace(/\s+/g, " ").trim(), 1200);
}

export async function describeThin(stories: Story[]): Promise<void> {
  const thin = stories.filter((s) => isThin(s) && s.urls[0] && !SKIP.test(s.urls[0]));
  if (!thin.length) return;
  let ok = 0;
  await pool(thin, 8, async (s) => {
    try {
      const res = await http(s.urls[0], { timeoutMs: 8000, headers: { accept: "text/html,application/xhtml+xml" } });
      if (!(res.headers.get("content-type") ?? "").includes("html")) return;
      const text = pageDescription((await res.text()).slice(0, 500_000));
      if (text.length >= 60) {
        s.text = text;
        ok++;
      }
    } catch {
      // blocked, paywalled or slow: keep the title-only text
    }
  });
  log(`descriptions: ${ok}/${thin.length} title-only stories filled from their pages`);
}
