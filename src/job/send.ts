import { ROLES, SLOTS } from "../shared/config";
import { isWildcardSlot, rankForUser, type Ranked } from "../shared/rank";
import { renderDigest, type Rendered } from "../shared/render";
import type { PoolItem, SlotMeta, UserPrefs } from "../shared/types";
import { Telegram, TelegramError } from "../worker/tg";
import type { Api } from "./api";
import { log, pool, sleep } from "./util";

/** Global limiter: Telegram allows ~30 msg/s overall; we stay at 25. */
export class RateLimiter {
  private next = 0;
  constructor(private perSecond: number) {}
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + 1000 / this.perSecond;
    if (at > now) await sleep(at - now);
  }
}

export type SendResult = "sent" | "blocked" | "failed";

/** Send one message, honouring retry_after on 429; marks users who blocked the bot. */
export async function sendOne(tg: Telegram, limiter: RateLimiter, chatId: number, r: Rendered | string): Promise<{ result: SendResult; message_id?: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await limiter.wait();
    try {
      const m = await tg.send(chatId, r);
      return { result: "sent", message_id: m.message_id };
    } catch (e) {
      if (e instanceof TelegramError) {
        if (e.code === 429) {
          await sleep(((e.retryAfter ?? 5) + 1) * 1000);
          continue;
        }
        if (e.code === 403 || (e.code === 400 && /chat not found|user is deactivated/i.test(e.description))) return { result: "blocked" };
      }
      log(`send to ${chatId} failed: ${(e as Error).message}`);
      if (attempt === 2) return { result: "failed" };
      await sleep(1000);
    }
  }
  return { result: "failed" };
}

export function renderFor(user: UserPrefs, slot: number, slotDate: string, poolItems: PoolItem[], meta: SlotMeta): { r: Rendered; items: Ranked[] } | null {
  let items: Ranked[];
  if (SLOTS[slot].key === "wrap") {
    const byId = new Map(poolItems.map((i) => [i.item_id, i]));
    items = (meta.wrap_item_ids ?? []).map((id) => byId.get(id)).filter((i): i is PoolItem => !!i).map((i) => ({ ...i, user_score: i.ai_score }));
  } else {
    items = rankForUser(poolItems, user, { wildcard: isWildcardSlot(user, slot) });
  }
  if (!items.length) return null;
  const simpler = !!user.role && Object.hasOwn(ROLES, user.role) && ROLES[user.role].simpler;
  return { r: renderDigest(slot, slotDate, items, { depth: user.depth === "quick" ? "quick" : "detailed", simpler, meta }), items };
}

/** Step 12 — personalise and send to every active user who wants this slot and hasn't had it yet. */
export async function sendSlot(api: Api, tg: Telegram, slotDate: string, slot: number, poolItems: PoolItem[], meta: SlotMeta, onlyUser?: number) {
  const limiter = new RateLimiter(25);
  const stats = { sent: 0, blocked: 0, failed: 0, empty: 0 };
  let after = 0;
  for (;;) {
    const page = await api.recipients(slotDate, slot, after);
    const users = onlyUser ? page.users.filter((u) => u.tg_user_id === onlyUser) : page.users;
    const deliveries: { tg_user_id: number; slot_date: string; slot: number; message_id: number; item_ids: number[] }[] = [];
    const blocked: number[] = [];
    await pool(users, 8, async (u) => {
      let out: ReturnType<typeof renderFor>;
      try {
        out = renderFor(u, slot, slotDate, poolItems, meta);
      } catch (e) {
        // one bad user row must never stop delivery to everyone else
        log(`render for ${u.tg_user_id} failed: ${(e as Error).message}`);
        return void stats.failed++;
      }
      if (!out) return void stats.empty++;
      const res = await sendOne(tg, limiter, u.tg_user_id, out.r);
      stats[res.result]++;
      if (res.result === "sent") deliveries.push({ tg_user_id: u.tg_user_id, slot_date: slotDate, slot, message_id: res.message_id!, item_ids: out.items.map((i) => i.item_id) });
      if (res.result === "blocked") blocked.push(u.tg_user_id);
      // flush in chunks so a crash mid-run doesn't cause double sends on retry
      if (deliveries.length >= 100) await api.deliveries(deliveries.splice(0));
    });
    if (deliveries.length) await api.deliveries(deliveries);
    if (blocked.length) await api.blocked(blocked);
    if (page.next == null) break;
    after = page.next;
  }
  log(`sent ${SLOTS[slot].name}: ${JSON.stringify(stats)}`);
  return stats;
}
