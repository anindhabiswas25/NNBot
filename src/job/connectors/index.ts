import { CRYPTO_FEEDS, LAB_FEEDS } from "../sources";
import type { Connector, SlotKey } from "../types";
import { arxiv } from "./arxiv";
import { coinGecko, cryptoPanic, defiLlama, dexScreener } from "./crypto";
import { githubReleases, githubTrending } from "./github";
import { hnCrypto, hnLaunches, hnResearch } from "./hackernews";
import { hfModels, hfPapers } from "./huggingface";
import { feedConnector } from "./rss";

export const CONNECTORS: Connector[] = [
  arxiv,
  hfPapers,
  hfModels,
  githubReleases,
  githubTrending,
  hnResearch,
  hnLaunches,
  hnCrypto,
  cryptoPanic,
  defiLlama,
  coinGecko,
  dexScreener,
  ...LAB_FEEDS.map((f) => feedConnector(f, "launches", "launch")),
  ...CRYPTO_FEEDS.map((f) => feedConnector(f, "crypto", "news")),
];

export const connectorsFor = (slot: SlotKey) => CONNECTORS.filter((c) => c.slots.includes(slot));
