import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/** Load KEY=VALUE lines from .env (and .secrets.local) without overriding real env vars. */
export function loadDotEnv(files = [".env"]) {
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

export const UA = "NodeNeuronBot/0.1 (research digest; +https://t.me/NodeNeuronBot)";

export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { "user-agent": UA, ...(rest.headers as Record<string, string>) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.replace(/(key|token|auth_token)=[^&]+/gi, "$1=***")}`);
  return res;
}

export const getJson = async <T = any>(url: string, init?: RequestInit & { timeoutMs?: number }) => (await http(url, init)).json() as Promise<T>;
export const getText = async (url: string, init?: RequestInit & { timeoutMs?: number }) => (await http(url, init)).text();

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);

const TRACKING = /^(utm_|ref$|ref_src|source$|fbclid|gclid|mc_cid|mc_eid|_hs|cmpid|s$)/i;

/** Canonical URL: https, no www, no tracking params, no fragment, no trailing slash, arXiv version stripped. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    url.protocol = "https:";
    url.hostname = url.hostname.replace(/^www\./, "");
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    let s = url.toString().replace(/\/$/, "");
    s = s.replace(/arxiv\.org\/(abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?(\.pdf)?/, "arxiv.org/abs/$2");
    return s;
  } catch {
    return u.trim();
  }
}

export function stripHtml(s: string | undefined | null): string {
  return (s ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

export function firstSentence(s: string, max = 180): string {
  const m = s.match(/^(.{30,}?[.!?])(\s|$)/);
  return truncate(m ? m[1] : s, max);
}

/** Run async tasks with limited concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

export function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}
