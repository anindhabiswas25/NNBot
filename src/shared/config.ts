export const BOT_NAME = "NodeNeuron";
export const BOT_USERNAME = "NodeNeuronBot";
export const TAGLINE = "AI + crypto research, distilled 4× a day.";

export type TopicId =
  | "llms" | "agents" | "safety" | "robotics" | "vision"
  | "bitcoin" | "ethereum" | "defi" | "regulation" | "aixcrypto";

export interface TopicDef {
  id: TopicId;
  label: string;
  domain: "ai" | "crypto" | "both";
  /** lower-case keywords used by the code-only tagger fallback */
  keywords: string[];
}

export const TOPICS: TopicDef[] = [
  { id: "llms", label: "LLMs", domain: "ai", keywords: ["llm", "language model", "transformer", "gpt", "claude", "gemini", "llama", "mistral", "qwen", "deepseek", "token", "attention", "fine-tun", "rlhf", "reasoning", "inference", "chatbot", "pretrain", "context window", "moe", "mixture of experts"] },
  { id: "agents", label: "AI Agents", domain: "ai", keywords: ["agent", "agentic", "tool use", "tool-use", "multi-agent", "autonomous", "planning", "mcp", "computer use", "workflow", "copilot", "assistant"] },
  { id: "safety", label: "AI Safety", domain: "ai", keywords: ["safety", "alignment", "jailbreak", "red team", "red-team", "interpretab", "misuse", "guardrail", "hallucinat", "robustness", "adversarial", "privacy", "bias", "fairness", "ai act", "evaluation"] },
  { id: "robotics", label: "Robotics", domain: "ai", keywords: ["robot", "embodied", "manipulation", "locomotion", "humanoid", "autonomous driving", "self-driving", "drone", "control policy", "sim-to-real"] },
  { id: "vision", label: "Computer Vision", domain: "ai", keywords: ["vision", "image", "video", "diffusion", "segmentation", "detection", "3d", "multimodal", "vlm", "visual", "text-to-image", "text-to-video", "gaussian splatting", "nerf"] },
  { id: "bitcoin", label: "Bitcoin", domain: "crypto", keywords: ["bitcoin", "btc", "lightning network", "satoshi", "ordinals", "halving", "miner", "mining"] },
  { id: "ethereum", label: "Ethereum / L2", domain: "crypto", keywords: ["ethereum", "eth ", "eth,", "layer 2", "layer-2", "l2", "rollup", "arbitrum", "optimism", "base chain", " on base", "zksync", "starknet", "polygon", "solidity", "evm", "blob", "pectra", "fusaka", "vitalik"] },
  { id: "defi", label: "DeFi", domain: "crypto", keywords: ["defi", "dex", "lending", "liquidity", "tvl", "stablecoin", "yield", "amm", "uniswap", "aave", "restaking", "staking", "perp", "protocol", "solana", "airdrop", "token"] },
  { id: "regulation", label: "Regulation", domain: "both", keywords: ["regulat", "sec ", "sec's", "cftc", "lawsuit", "court", "law", "bill", "senate", "congress", "policy", "ban", "compliance", "mica", "etf", "license", "government", "eu ", "act "] },
  { id: "aixcrypto", label: "AI × Crypto", domain: "both", keywords: ["ai agent token", "decentralized ai", "decentralised ai", "onchain ai", "on-chain ai", "zkml", "bittensor", "tao", "depin", "gpu marketplace", "render network", "fetch.ai", "ai crypto", "crypto ai", "virtuals"] },
];

export const TOPIC_IDS = TOPICS.map((t) => t.id);
export const topicLabel = (id: string) => TOPICS.find((t) => t.id === id)?.label ?? id;

export type RoleId = "student" | "researcher" | "developer" | "trader";
export type Depth = "quick" | "detailed";
export type ItemType = "paper" | "launch" | "news" | "data";

export const ROLES: Record<RoleId, { label: string; depth: Depth; boost: Partial<Record<ItemType, number>>; simpler: boolean }> = {
  student: { label: "🎓 Student", depth: "quick", boost: {}, simpler: true },
  researcher: { label: "🔬 Researcher", depth: "detailed", boost: { paper: 1.25 }, simpler: false },
  developer: { label: "💻 Developer", depth: "detailed", boost: { launch: 1.25 }, simpler: false },
  trader: { label: "📈 Trader", depth: "quick", boost: { news: 1.15, data: 1.25 }, simpler: false },
};

export interface SlotDef {
  id: 0 | 1 | 2 | 3;
  key: "research" | "crypto" | "launches" | "wrap";
  emoji: string;
  name: string;
  /** send time, IST, 24h */
  hour: number;
  button: string;
}

export const SLOTS: SlotDef[] = [
  { id: 0, key: "research", emoji: "🔬", name: "Research Brief", hour: 7, button: "7 AM Research" },
  { id: 1, key: "crypto", emoji: "🪙", name: "Crypto Brief", hour: 12, button: "12 PM Crypto" },
  { id: 2, key: "launches", emoji: "🤖", name: "AI Launches", hour: 17, button: "5 PM AI Launches" },
  { id: 3, key: "wrap", emoji: "🌙", name: "Daily Wrap", hour: 22, button: "10 PM Daily Wrap" },
];
export const ALL_SLOTS_MASK = 0b1111;
export const slotByKey = (k: string) => SLOTS.find((s) => s.key === k);

export const DEFAULT_TOPIC_WEIGHT = 10;
export const MAX_WEIGHT = 20;
export const MIN_WEIGHT = 0;
export const MAX_PER_TOPIC = 3;
/** Source variety: one website may fill at most (briefing size − 2) of a user's items… */
export const SITE_RESERVED = 2;
/** …and at most this many of a slot's 25-item shared pool. */
export const POOL_MAX_PER_SITE = 18;
export const POOL_SIZE = 25;

/** Weight deltas (PRD § Feedback) */
export const SIGNAL_DELTA = { open: 1, save: 2, more: 3, less: -3, digest_up: 1, digest_down: -1 } as const;

/** IST = UTC+5:30 */
export const IST_OFFSET_MIN = 330;

export function istDate(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export function istHour(d: Date = new Date()): number {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).getUTCHours();
}

/** UTC Date at which `slot` is due on IST date `slotDate` */
export function slotSendTime(slotDate: string, slot: number): Date {
  const s = SLOTS[slot];
  const utcMs = Date.parse(`${slotDate}T00:00:00Z`) + s.hour * 3_600_000 - IST_OFFSET_MIN * 60_000;
  return new Date(utcMs);
}

export function prettyDate(slotDate: string): string {
  const d = new Date(`${slotDate}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}
