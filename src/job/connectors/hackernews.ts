import type { Connector, RawItem, SlotKey } from "../types";
import { getJson } from "../util";

const AI_RE = /\b(ai|llm|llms|gpt|openai|anthropic|claude|gemini|deepmind|mistral|llama|model|neural|machine learning|transformer|agent|agents|diffusion|robot|hugging ?face|inference|deepseek|qwen)\b/i;
const CRYPTO_RE = /\b(crypto|bitcoin|btc|ethereum|eth|blockchain|defi|stablecoin|solana|web3|token|coinbase|binance|ledger|wallet|zk|rollup)\b/i;

/** HN stories as a buzz signal; also a source for AI launches and crypto news. */
function hn(slot: SlotKey, re: RegExp, type: RawItem["type"]): Connector {
  return {
    name: `Hacker News (${slot})`,
    slots: [slot],
    async run({ since }) {
      const ts = Math.floor(since.getTime() / 1000);
      const r: any = await getJson(`https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=300&numericFilters=${encodeURIComponent(`created_at_i>${ts},points>40`)}`);
      return (r.hits ?? [])
        .filter((h: any) => h.title && re.test(h.title))
        .map((h: any): RawItem => ({
          title: h.title,
          text: h.story_text ? String(h.story_text).slice(0, 800) : h.title,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          source: "Hacker News",
          published_at: h.created_at,
          type,
          trust: 3,
          data: { hn_points: h.points, hn_comments: h.num_comments, hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`, published: h.created_at },
        }));
    },
  };
}

export const hnLaunches = hn("launches", AI_RE, "launch");
export const hnCrypto = hn("crypto", CRYPTO_RE, "news");
export const hnResearch: Connector = {
  ...hn("research", /arxiv\.org|paper|research|study/i, "paper"),
  name: "Hacker News (research)",
};
