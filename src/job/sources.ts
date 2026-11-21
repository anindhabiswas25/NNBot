/** Feed and repo lists (PRD: "Feed list kept in config"). Add or remove freely. */

export interface Feed {
  name: string;
  url: string;
  trust: 1 | 2 | 3;
}

/** Official lab / research blogs → AI Launches slot. (Anthropic and Meta AI have no public RSS.) */
export const LAB_FEEDS: Feed[] = [
  { name: "OpenAI", url: "https://openai.com/news/rss.xml", trust: 1 },
  { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", trust: 1 },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/", trust: 1 },
  { name: "Mistral AI", url: "https://mistral.ai/rss.xml", trust: 1 },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", trust: 1 },
  { name: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/", trust: 1 },
  { name: "NVIDIA", url: "https://blogs.nvidia.com/feed/", trust: 1 },
  { name: "AWS ML", url: "https://aws.amazon.com/blogs/machine-learning/feed/", trust: 1 },
  { name: "BAIR", url: "https://bair.berkeley.edu/blog/feed.xml", trust: 1 },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", trust: 2 },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", trust: 2 },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", trust: 2 },
];

/** Research blogs → Research slot (as papers). Each checked live on 2026-11-22. */
export const RESEARCH_FEEDS: Feed[] = [
  { name: "Google Research", url: "https://research.google/blog/rss/", trust: 1 },
  { name: "Apple ML Research", url: "https://machinelearning.apple.com/rss.xml", trust: 1 },
  { name: "CMU ML Blog", url: "https://blog.ml.cmu.edu/feed/", trust: 1 },
  { name: "MIT News AI", url: "https://news.mit.edu/rss/topic/artificial-intelligence2", trust: 2 },
  { name: "Sebastian Raschka", url: "https://magazine.sebastianraschka.com/feed", trust: 2 },
  { name: "Lil'Log", url: "https://lilianweng.github.io/index.xml", trust: 2 },
  // blockchain research
  { name: "a16z crypto", url: "https://a16zcrypto.com/feed/", trust: 1 },
  { name: "Vitalik Buterin", url: "https://vitalik.eth.limo/feed.xml", trust: 1 },
  { name: "Flashbots", url: "https://writings.flashbots.net/rss.xml", trust: 1 },
  { name: "Ethresear.ch", url: "https://ethresear.ch/latest.rss", trust: 3 },
];

/** Crypto outlets → Crypto Brief slot. */
export const CRYPTO_FEEDS: Feed[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", trust: 2 },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", trust: 2 },
  { name: "Decrypt", url: "https://decrypt.co/feed", trust: 2 },
  { name: "The Block", url: "https://www.theblock.co/rss.xml", trust: 2 },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed", trust: 2 },
  { name: "The Defiant", url: "https://thedefiant.io/api/feed", trust: 2 },
  { name: "Blockworks", url: "https://blockworks.co/feed", trust: 2 },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/", trust: 2 },
  { name: "Crypto Briefing", url: "https://cryptobriefing.com/feed/", trust: 3 },
  { name: "Ethereum Foundation", url: "https://blog.ethereum.org/feed.xml", trust: 1 },
  // free replacements for CryptoPanic (paid)
  { name: "Unchained", url: "https://unchainedcrypto.com/feed/", trust: 2 },
  { name: "Protos", url: "https://protos.com/feed/", trust: 2 },
  { name: "Rekt News", url: "https://rekt.news/rss/feed.xml", trust: 2 },
];

/** GitHub repos whose releases count as AI launches. */
export const RELEASE_REPOS = [
  "vllm-project/vllm",
  "huggingface/transformers",
  "ollama/ollama",
  "ggml-org/llama.cpp",
  "pytorch/pytorch",
  "langchain-ai/langchain",
  "run-llama/llama_index",
  "microsoft/autogen",
  "openai/openai-agents-python",
  "anthropics/anthropic-sdk-python",
  "modelcontextprotocol/python-sdk",
  "sgl-project/sglang",
  "unslothai/unsloth",
  "huggingface/diffusers",
];

/** arXiv categories for the Research Brief. */
export const ARXIV_CATEGORIES = ["cs.AI", "cs.LG", "cs.CL", "cs.CR", "cs.MA", "cs.CV", "cs.RO", "q-fin.TR", "q-fin.CP"];

/** Domains / phrases we never list (paid promos, press-release wires, clickbait). */
export const BLOCKED_DOMAINS = ["globenewswire.com", "prnewswire.com", "accesswire.com", "newsbtc.com/press-releases", "/press-release", "/sponsored", "/partner-content", "/pr/"];
export const JUNK_PATTERNS = [
  /price prediction/i,
  /\b(could|will|set to|poised to|ready to) (hit|reach|soar|explode|pump|rally to)\b/i,
  /\bto the moon\b/i,
  /\b\d{2,}x (gains?|returns?|potential)\b/i,
  /\bpresale\b/i,
  /\bsponsored\b/i,
  /\bpress release\b/i,
  /\b(best|top \d+) (altcoins?|crypto(s|currencies)?|meme ?coins?) to buy\b/i,
  /\bbuy (now|before)\b/i,
  /\bairdrop (guide|checker|how to claim)\b/i,
  /\bprice analysis\b/i,
  /\bwhale alert\b/i,
  /\b(uncensored|abliterated|nsfw)\b/i, // de-safetied model uploads: not for a student briefing
];

/** DefiLlama thresholds */
export const DEFI = {
  newProtocolMinTvl: 2_000_000,
  moverMinTvl: 50_000_000,
  moverMinChange7d: 25,
  skipCategories: ["CEX", "Chain", "Canonical Bridge"],
};

/** CoinGecko: report top-100 coins that moved more than this in 24h. */
export const PRICE_MOVE_PCT = 12;
