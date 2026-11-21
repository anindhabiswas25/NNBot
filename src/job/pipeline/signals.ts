import type { Story } from "../types";

const lg = (x: number | undefined) => Math.log10((x ?? 0) + 1);

/**
 * Step 5 — code-only signal score, 0–10: corroboration, source trust tier, HN points, HF upvotes,
 * citations, stars/likes, TVL or price change, recency.
 */
export function signalScore(s: Story): number {
  const d = s.data;
  let score = 1;
  score += Math.min(3, (s.sources.length - 1) * 1.2); // corroboration
  const bestTrust = Math.min(...s.items.map((i) => i.trust));
  score += bestTrust === 1 ? 1.5 : bestTrust === 2 ? 1 : 0;
  score += Math.min(2.5, lg(d.hn_points) * 1.1);
  score += Math.min(3, lg(d.hf_upvotes) * 1.6);
  score += Math.min(1.5, lg(d.citations));
  score += Math.min(2, lg(d.likes) * 0.7);
  score += Math.min(2, lg(d.stars) * 0.6);
  if (d.tvl_change_7d != null) score += Math.min(2, Math.abs(d.tvl_change_7d) / 30);
  if (d.price_change_24h != null) score += Math.min(2, Math.abs(d.price_change_24h) / 10);
  if (d.code_url && s.type === "paper") score += 0.5;
  const ageH = (Date.now() - Date.parse(s.items[0].published_at)) / 3_600_000;
  if (ageH > 48) score -= Math.min(1.5, (ageH - 48) / 48);
  return Math.max(0, Math.min(10, +score.toFixed(2)));
}
