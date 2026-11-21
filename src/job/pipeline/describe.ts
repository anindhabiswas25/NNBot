import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
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

const v4ToInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];

/** Expand any IPv6 text form (incl. ::, embedded IPv4) to 8 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.every((n) => n >= 0 && n <= 0xffff) ? nums : null;
}

/**
 * True unless the address is plainly public. IPv4: not in any reserved/private/link-local/CGNAT range.
 * IPv6: only global unicast 2000::/3 is allowed, minus 6to4 (2002::/16), Teredo (2001::/32) and documentation
 * (2001:db8::/32) — so every IPv4-mapped/compatible/NAT64 form is rejected however it is written.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => n >>> (32 - bits) === v4ToInt(base) >>> (32 - bits));
  }
  if (isIP(ip) !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  if ((g[0] & 0xe000) !== 0x2000) return true; // not global unicast
  return g[0] === 0x2002 || (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8));
}

/** dns.lookup replacement used *by the socket itself*: the address actually connected to is the one checked. */
function guardedLookup(host: string, opts: LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error(`blocked non-public address for ${host}`), { code: "EBLOCKED" }), "");
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

interface Page { status: number; location?: string; contentType: string; body: string }

/** One GET, no redirects followed, body capped at `max` bytes, 8 s total. */
function getOnce(url: URL, max = 500_000): Promise<Page> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { lookup: guardedLookup as any, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, timeout: 8000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).subarray(0, max).toString("utf8") });
      if ((res.statusCode ?? 0) >= 300 || !String(res.headers["content-type"] ?? "").includes("html")) {
        res.destroy();
        return finish();
      }
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size >= max) {
          res.destroy(); // stop reading a huge or endless page
          finish();
        }
      });
      res.on("end", finish);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** GET following ≤ 3 redirects; every hop must be http(s) on a default port, and every socket is address-checked. */
async function safeGet(raw: string): Promise<Page | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  for (let hop = 0; hop <= 3; hop++) {
    if ((url.protocol !== "https:" && url.protocol !== "http:") || (url.port && !["80", "443"].includes(url.port))) return null;
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateIp(url.hostname.replace(/^\[|\]$/g, ""))) return null; // literal IPs skip DNS
    const page = await getOnce(url);
    if (page.status >= 300 && page.status < 400) {
      if (!page.location) return null;
      url = new URL(page.location, url);
      continue;
    }
    return page.status >= 200 && page.status < 300 ? page : null;
  }
  return null;
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
      const page = await safeGet(s.urls[0]);
      if (!page || !page.contentType.includes("html")) return;
      const text = pageDescription(page.body);
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
