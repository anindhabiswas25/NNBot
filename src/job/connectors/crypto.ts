import { fmtUsd } from "../../shared/render";
import { DEFI, PRICE_MOVE_PCT } from "../sources";
import type { Connector, RawItem } from "../types";
import { getJson, truncate } from "../util";

/** CryptoPanic headlines + community sentiment (needs free CRYPTOPANIC_TOKEN). */
export const cryptoPanic: Connector = {
  name: "CryptoPanic",
  slots: ["crypto"],
  async run({ env, since }) {
    if (!env.CRYPTOPANIC_TOKEN) return [];
    const r: any = await getJson(`https://cryptopanic.com/api/developer/v2/posts/?auth_token=${env.CRYPTOPANIC_TOKEN}&public=true&kind=news`);
    return (r.results ?? [])
      .filter((p: any) => new Date(p.published_at) >= since)
      .map((p: any): RawItem => {
        const v = p.votes ?? {};
        const pos = (v.positive ?? 0) + (v.liked ?? 0);
        const neg = (v.negative ?? 0) + (v.disliked ?? 0) + (v.toxic ?? 0);
        const sentiment = pos + neg < 3 ? undefined : pos > neg * 1.5 ? "positive" : neg > pos * 1.5 ? "negative" : "neutral";
        return {
          title: p.title,
          text: p.description ?? p.title,
          url: p.original_url || p.url || `https://cryptopanic.com/news/${p.id}/${p.slug}`,
          source: p.source?.title ?? "CryptoPanic",
          published_at: p.published_at,
          type: "news",
          trust: 3,
          data: { sentiment, published: p.published_at },
        };
      });
  },
};

export interface LlamaProtocol {
  name: string; slug: string; url?: string; description?: string; category?: string; chains?: string[];
  tvl?: number; change_7d?: number; listedAt?: number; gecko_id?: string; symbol?: string;
}

let llamaCache: LlamaProtocol[] | null = null;
export async function llamaProtocols(): Promise<LlamaProtocol[]> {
  llamaCache ??= await getJson<LlamaProtocol[]>("https://api.llama.fi/protocols", { timeoutMs: 90_000 });
  return llamaCache;
}

/** DefiLlama: newly listed protocols with real TVL, and big 7-day TVL movers. */
export const defiLlama: Connector = {
  name: "DefiLlama",
  slots: ["crypto"],
  async run() {
    const all = await llamaProtocols();
    const out: RawItem[] = [];
    const recent = Date.now() / 1000 - 4 * 86_400;
    for (const p of all) {
      if (!p.tvl || DEFI.skipCategories.includes(p.category ?? "")) continue;
      const chains = (p.chains ?? []).slice(0, 3).join(", ");
      const llamaUrl = `https://defillama.com/protocol/${p.slug}`;
      if (p.listedAt && p.listedAt > recent && p.tvl >= DEFI.newProtocolMinTvl) {
        out.push({
          title: `${p.name} launches on ${chains || "DeFi"}`,
          text: truncate(`${p.name} (${p.category}) was newly listed on DefiLlama with ${fmtUsd(p.tvl)} in total value locked. ${p.description ?? ""}`, 800),
          url: llamaUrl,
          extra_urls: p.url ? [p.url] : [],
          source: "DefiLlama",
          published_at: new Date(p.listedAt * 1000).toISOString(),
          type: "data",
          trust: 1,
          topic_hint: "defi",
          ids: { llama: p.slug, gecko: p.gecko_id ?? undefined },
          data: { tvl: p.tvl, tvl_change_7d: p.change_7d ?? undefined, category: p.category, lab: p.name },
        });
      } else if (p.tvl >= DEFI.moverMinTvl && Math.abs(p.change_7d ?? 0) >= DEFI.moverMinChange7d) {
        const up = (p.change_7d ?? 0) > 0;
        out.push({
          title: `${p.name} TVL ${up ? "jumps" : "drops"} ${Math.abs(Math.round(p.change_7d!))}% in a week`,
          text: truncate(`${p.name} (${p.category} on ${chains}) total value locked is ${fmtUsd(p.tvl)}, ${up ? "up" : "down"} ${Math.abs(p.change_7d!).toFixed(1)}% over the past 7 days, per DefiLlama. ${p.description ?? ""}`, 800),
          url: llamaUrl,
          extra_urls: p.url ? [p.url] : [],
          source: "DefiLlama",
          published_at: new Date().toISOString(),
          type: "data",
          trust: 1,
          topic_hint: "defi",
          ids: { llama: p.slug, gecko: p.gecko_id ?? undefined },
          data: { tvl: p.tvl, tvl_change_7d: p.change_7d, category: p.category, lab: p.name },
        });
      }
    }
    return out.sort((a, b) => (b.data.tvl ?? 0) - (a.data.tvl ?? 0)).slice(0, 15);
  },
};

export interface Market {
  id: string; symbol: string; name: string; current_price: number; market_cap_rank: number;
  price_change_percentage_24h_in_currency?: number; price_change_percentage_7d_in_currency?: number;
}

let marketsCache: Market[] | null = null;
export async function coinMarkets(env: NodeJS.ProcessEnv): Promise<Market[]> {
  if (marketsCache) return marketsCache;
  const headers: Record<string, string> = env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {};
  marketsCache = await getJson<Market[]>("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&price_change_percentage=24h,7d", { headers });
  return marketsCache;
}

/** CoinGecko: big moves among the top-100 coins (reported as facts, never as predictions). */
export const coinGecko: Connector = {
  name: "CoinGecko",
  slots: ["crypto"],
  async run({ env }) {
    const m = await coinMarkets(env);
    return m
      .filter((c) => Math.abs(c.price_change_percentage_24h_in_currency ?? 0) >= PRICE_MOVE_PCT)
      .slice(0, 6)
      .map((c): RawItem => {
        const ch = c.price_change_percentage_24h_in_currency!;
        return {
          title: `${c.name} (${c.symbol.toUpperCase()}) ${ch > 0 ? "up" : "down"} ${Math.abs(ch).toFixed(0)}% in 24 hours`,
          text: `${c.name}, ranked #${c.market_cap_rank} by market cap, moved ${ch.toFixed(1)}% in 24 hours and ${(c.price_change_percentage_7d_in_currency ?? 0).toFixed(1)}% over 7 days, per CoinGecko.`,
          url: `https://www.coingecko.com/en/coins/${c.id}`,
          source: "CoinGecko",
          published_at: new Date().toISOString(),
          type: "data",
          trust: 1,
          ids: { gecko: c.id },
          data: { coin: c.symbol.toUpperCase(), price: c.current_price, price_change_24h: ch, price_change_7d: c.price_change_percentage_7d_in_currency },
        };
      });
  },
};

/**
 * DEX Screener new tokens — OFF by default (ENABLE_DEXSCREENER=1). Even when on, only tokens with
 * ≥ $1M liquidity are kept, and they're tagged data-only so they never read as recommendations.
 */
export const dexScreener: Connector = {
  name: "DEX Screener",
  slots: ["crypto"],
  async run({ env }) {
    if (env.ENABLE_DEXSCREENER !== "1") return [];
    const boosted: any[] = await getJson("https://api.dexscreener.com/token-boosts/top/v1");
    const out: RawItem[] = [];
    for (const t of boosted.slice(0, 20)) {
      const pairs: any[] = await getJson(`https://api.dexscreener.com/tokens/v1/${t.chainId}/${t.tokenAddress}`).catch(() => []);
      const p = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!p || (p.liquidity?.usd ?? 0) < 1_000_000) continue;
      if (Date.now() - (p.pairCreatedAt ?? Date.now()) < 3 * 86_400_000) continue;
      out.push({
        title: `${p.baseToken.name} sees heavy trading on ${p.dexId}`,
        text: `${p.baseToken.symbol} on ${p.chainId}: liquidity ${Math.round(p.liquidity.usd)} USD, 24h volume ${Math.round(p.volume?.h24 ?? 0)} USD.`,
        url: p.url,
        source: "DEX Screener",
        published_at: new Date().toISOString(),
        type: "data",
        trust: 3,
        data: { coin: /^[A-Za-z0-9$._-]{1,15}$/.test(p.baseToken?.symbol ?? "") ? p.baseToken.symbol.toUpperCase() : undefined, price_change_24h: p.priceChange?.h24 },
      });
    }
    return out;
  },
};
