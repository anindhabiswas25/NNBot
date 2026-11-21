import type { ItemType, TopicId } from "../shared/config";
import type { ItemData } from "../shared/types";

export type SlotKey = "research" | "crypto" | "launches";

/** Normalised item — one format for every connector (PRD pipeline step 2). */
export interface RawItem {
  title: string;
  text: string;
  url: string;
  source: string; // human-readable source name, e.g. "arXiv", "CoinDesk"
  published_at: string; // ISO
  type: ItemType;
  /** 1 = primary/official (arXiv, lab blog, DefiLlama), 2 = established outlet, 3 = aggregator/community */
  trust: 1 | 2 | 3;
  data: ItemData;
  extra_urls?: string[];
  topic_hint?: TopicId;
  ids?: { arxiv?: string; hf_model?: string; gecko?: string; llama?: string };
}

export interface Story {
  id: number;
  items: RawItem[];
  title: string;
  text: string;
  urls: string[];
  type: ItemType;
  topic: TopicId;
  domain_ok: boolean;
  data: ItemData;
  sources: string[];
  signal: number; // 0–10 code-only score
  judge?: number; // 1–10
  judge_reason?: string;
  difficulty?: string;
  ai_score: number;
}

export interface ConnectorCtx {
  since: Date;
  env: NodeJS.ProcessEnv;
}

export interface Connector {
  name: string;
  slots: SlotKey[];
  run(ctx: ConnectorCtx): Promise<RawItem[]>;
}
