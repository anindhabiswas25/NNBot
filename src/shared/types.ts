import type { Depth, ItemType, RoleId } from "./config";

/** Structured facts attached to a pool item. Every number here came from an API, never from the AI. */
export interface ItemData {
  authors?: string;
  published?: string; // ISO date
  category?: string;
  lab?: string;
  pdf_url?: string;
  code_url?: string;
  paper_url?: string;
  hf_upvotes?: number;
  citations?: number;
  influential?: number;
  tldr?: string;
  model_size?: string;
  license?: string;
  downloads?: number;
  likes?: number;
  stars?: number;
  tvl?: number;
  tvl_change_7d?: number;
  price?: number;
  price_change_24h?: number;
  /** Ticker the price fields refer to (e.g. "BTC"), so a % next to a news story says whose price it is. */
  coin?: string;
  price_change_7d?: number;
  sources_count?: number;
  sentiment?: "positive" | "neutral" | "negative";
  hn_points?: number;
  hn_comments?: number;
  hn_url?: string;
  version?: string;
  /** From a hand-picked research blog (editorial selection is itself a signal). */
  curated?: boolean;
}

export interface PoolItem {
  item_id: number;
  slot_date: string;
  slot: number;
  type: ItemType;
  topic: string;
  title: string;
  summary_short: string;
  summary_long: string;
  why_it_matters: string;
  simple_words: string;
  data: ItemData;
  source_urls: string[];
  ai_score: number;
}

/** Item as the job submits it (no id yet) */
export type NewPoolItem = Omit<PoolItem, "item_id" | "slot_date" | "slot">;

export interface SlotMeta {
  connection?: string;   // Daily Wrap: how the stories connect
  concept_title?: string;
  concept_body?: string;
  note?: string;         // e.g. AI fallback notice
  wrap_item_ids?: number[];
}

export interface UserPrefs {
  tg_user_id: number;
  first_name?: string | null;
  role: RoleId | null;
  depth: Depth;
  slots: number;
  language: string;
  weights: Record<string, number>;
}
