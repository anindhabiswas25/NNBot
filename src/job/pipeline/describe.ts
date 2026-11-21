import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Story } from "../types";
import { UA, log, pool, stripHtml, truncate } from "../util";

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

// ───────────── safe fetch: story links are user-submitted (HN), so never reach internal addresses ─────────────

/** True for loopback, private, link-local (cloud metadata), CGNAT, unique-local and other non-public IPs. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

async function isPublicHttpUrl(raw: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port && !["80", "443"].includes(u.port)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

/** GET with every hop (including redirects) checked to be a public http(s) address; ≤ 3 redirects. */
async function safeGet(url: string): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!(await isPublicHttpUrl(current))) return null;
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      current = new URL(loc, current).toString();
      continue;
    }
    return res.ok ? res : null;
  }
  return null;
}

/** Read at most `max` bytes of a body, then cancel the stream (a huge or endless page can't stall the job). */
async function readCapped(res: Response, max = 500_000): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
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
      const res = await safeGet(s.urls[0]);
      if (!res || !(res.headers.get("content-type") ?? "").includes("html")) return;
      const text = pageDescription(await readCapped(res));
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
