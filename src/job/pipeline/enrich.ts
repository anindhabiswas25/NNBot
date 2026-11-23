import { coinMarkets, llamaProtocols } from "../connectors/crypto";
import type { Story } from "../types";
import { log, sleep } from "../util";

/** Step 8 — add facts from APIs to the top stories. Every failure here is non-fatal. */
export async function enrich(stories: Story[], env: NodeJS.ProcessEnv): Promise<void> {
  await Promise.all([semanticScholar(stories, env), cryptoFacts(stories, env)]);
}

async function semanticScholar(stories: Story[], env: NodeJS.ProcessEnv) {
  const papers = stories
    .map((s) => ({ s, id: s.items.find((i) => i.ids?.arxiv)?.ids?.arxiv ?? s.urls.join(" ").match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/)?.[1] }))
    .filter((x): x is { s: Story; id: string } => !!x.id);
  if (!papers.length) return;
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "NodeNeuronBot/0.1" };
  if (env.SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = env.SEMANTIC_SCHOLAR_API_KEY;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.semanticscholar.org/graph/v1/paper/batch?fields=tldr,citationCount,influentialCitationCount,openAccessPdf,authors.name", {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: papers.map((p) => `arXiv:${p.id}`) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const rows: any[] = await res.json();
      rows.forEach((r, i) => {
        if (!r) return;
        const d = papers[i].s.data;
        if (r.tldr?.text) d.tldr = r.tldr.text;
        d.citations = r.citationCount ?? d.citations;
        d.influential = r.influentialCitationCount ?? d.influential;
        if (r.openAccessPdf?.url && !d.pdf_url) d.pdf_url = r.openAccessPdf.url;
        const names = (r.authors ?? []).map((a: any) => a.name);
        if (names.length && !d.authors) d.authors = names.length > 1 ? `${names[0]} et al.` : names[0];
      });
      return;
    } catch (e) {
      log(`semantic scholar enrich failed: ${(e as Error).message}`);
      return;
    }
  }
  log("semantic scholar rate-limited; skipping TLDR/citations (set SEMANTIC_SCHOLAR_API_KEY)");
}

/** A coin's 24h move is shown only when it differs from the market's by at least this many points. */
export const PRICE_EXCESS_PCT = 3;

/** Median 24h move of the top-20 coins: what "the market did today". */
export function marketMove(markets: { market_cap_rank: number; price_change_percentage_24h_in_currency?: number | null }[]): number {
  const moves = markets
    .filter((c) => c.market_cap_rank <= 20 && c.price_change_percentage_24h_in_currency != null)
    .map((c) => c.price_change_percentage_24h_in_currency!)
    .sort((a, b) => a - b);
  return moves.length ? moves[Math.floor(moves.length / 2)] : 0;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function cryptoFacts(stories: Story[], env: NodeJS.ProcessEnv) {
  const crypto = stories.filter((s) => ["bitcoin", "ethereum", "defi", "aixcrypto", "regulation"].includes(s.topic) && s.type !== "paper");
  if (!crypto.length) return;
  const [markets, protocols] = await Promise.all([coinMarkets(env).catch(() => []), llamaProtocols().catch(() => [])]);
  const bigProtocols = protocols.filter((p) => (p.tvl ?? 0) > 20_000_000 && p.name.length >= 4 && !["CEX", "Chain"].includes(p.category ?? ""));
  const market = marketMove(markets);
  for (const s of crypto) {
    const title = s.title;
    if (s.data.price_change_24h == null) {
      // The story's own token, matched by name ("Chainflip" → FLIP), else a ticker in the title. Shown only
      // when it moved differently from the market: "ETH 24h +4.2%" on a day everything is +4% says nothing
      // about the story.
      const coin =
        markets.find((c) => c.market_cap_rank <= 100 && c.name.length >= 4 && new RegExp(`\\b${esc(c.name)}\\b`, "i").test(title)) ??
        markets.find((c) => c.market_cap_rank <= 50 && c.symbol.length >= 3 && new RegExp(`\\b${esc(c.symbol.toUpperCase())}\\b`).test(title));
      const chg = coin?.price_change_percentage_24h_in_currency;
      if (coin && chg != null && Math.abs(chg - market) >= PRICE_EXCESS_PCT) {
        s.data.coin = coin.symbol.toUpperCase();
        s.data.price = coin.current_price;
        s.data.price_change_24h = chg;
        s.data.price_change_7d = coin.price_change_percentage_7d_in_currency;
        s.urls.push(`https://www.coingecko.com/en/coins/${coin.id}`);
      }
    }
    if (s.data.tvl == null) {
      const p = bigProtocols.find((p) => new RegExp(`\\b${esc(p.name)}\\b`, "i").test(title));
      if (p) {
        s.data.tvl = p.tvl;
        s.data.tvl_change_7d = p.change_7d ?? undefined;
        s.urls.push(`https://defillama.com/protocol/${p.slug}`);
      }
    }
  }
}
