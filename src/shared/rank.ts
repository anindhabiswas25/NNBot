import { MAX_PER_TOPIC, ROLES, SLOTS } from "./config";
import type { PoolItem, UserPrefs } from "./types";

export interface Ranked extends PoolItem {
  user_score: number;
  wildcard?: boolean;
}

/** user_score = AI_score × (1 + topic_weight / 10), × a small role boost on item type. */
export function userScore(item: PoolItem, user: UserPrefs): number {
  const w = user.weights[item.topic] ?? 0;
  const boost = user.role && Object.hasOwn(ROLES, user.role) ? ROLES[user.role].boost[item.type] ?? 1 : 1;
  return item.ai_score * (1 + w / 10) * boost;
}

/** Wildcard goes into the user's first enabled slot of the day — one per day, no state needed. */
export function isWildcardSlot(user: UserPrefs, slot: number): boolean {
  for (const s of SLOTS) {
    if (s.key === "wrap") continue;
    if (user.slots & (1 << s.id)) return s.id === slot;
  }
  return false;
}

/**
 * Pick the user's items from the shared pool: top 5 (quick) or 7 (detailed) by user_score,
 * at most 3 per topic, plus one high-scoring wildcard from outside their topics when `wildcard`.
 */
export function rankForUser(pool: PoolItem[], user: UserPrefs, opts: { wildcard?: boolean; limit?: number } = {}): Ranked[] {
  const limit = opts.limit ?? (user.depth === "quick" ? 5 : 7);
  const scored = pool
    .map((it) => ({ ...it, user_score: userScore(it, user) }))
    .sort((a, b) => b.user_score - a.user_score);

  const out: Ranked[] = [];
  const perTopic: Record<string, number> = {};
  const wantWildcard = !!opts.wildcard;
  const mainLimit = wantWildcard ? limit - 1 : limit;

  for (const it of scored) {
    if (out.length >= mainLimit) break;
    if ((perTopic[it.topic] ?? 0) >= MAX_PER_TOPIC) continue;
    perTopic[it.topic] = (perTopic[it.topic] ?? 0) + 1;
    out.push(it);
  }
  // Pool too narrow for the per-topic cap → top up rather than send a short briefing
  if (out.length < mainLimit) {
    const taken = new Set(out.map((i) => i.item_id));
    for (const it of scored) {
      if (out.length >= mainLimit) break;
      if (!taken.has(it.item_id)) out.push(it);
    }
  }

  if (wantWildcard) {
    const taken = new Set(out.map((i) => i.item_id));
    const wild = pool
      .filter((it) => !taken.has(it.item_id) && (user.weights[it.topic] ?? 0) <= 0)
      .sort((a, b) => b.ai_score - a.ai_score)[0];
    if (wild) out.push({ ...wild, user_score: wild.ai_score, wildcard: true });
    else {
      // nothing outside their topics — fill normally
      for (const it of scored) {
        if (out.length >= limit) break;
        if (!taken.has(it.item_id) && (perTopic[it.topic] ?? 0) < MAX_PER_TOPIC) out.push(it);
      }
    }
  }
  return out;
}
