import { DEFAULT_TOPIC_WEIGHT, MAX_WEIGHT, MIN_WEIGHT, TOPIC_IDS, istDate, type Depth, type RoleId } from "../shared/config";
import type { PoolItem, SlotMeta, UserPrefs } from "../shared/types";

export interface UserRow {
  tg_user_id: number;
  first_name: string | null;
  role: RoleId | null;
  depth: Depth;
  slots: number;
  language: string;
  status: "onboarding" | "active" | "paused" | "blocked";
  onboarding_msg_id: number | null;
  reminded_at: number | null;
  star_prompted_at: number | null;
  created_at: number;
  last_active_at: number;
}

export const now = () => Date.now();

export function rowToItem(r: any): PoolItem {
  return {
    item_id: r.item_id,
    slot_date: r.slot_date,
    slot: r.slot,
    type: r.type,
    topic: r.topic,
    title: r.title,
    summary_short: r.summary_short,
    summary_long: r.summary_long,
    why_it_matters: r.why_it_matters,
    simple_words: r.simple_words,
    data: JSON.parse(r.data_json || "{}"),
    source_urls: JSON.parse(r.source_urls_json || "[]"),
    ai_score: r.ai_score,
  };
}

export class DB {
  constructor(public d1: D1Database) {}

  getUser(id: number) {
    return this.d1.prepare("SELECT * FROM users WHERE tg_user_id = ?").bind(id).first<UserRow>();
  }

  /** Upserts the user; `isNew` is true only on the request that created the row. */
  async ensureUser(id: number, firstName: string | undefined, language: string | undefined): Promise<UserRow & { isNew: boolean }> {
    const t = now();
    await this.d1
      .prepare(
        `INSERT INTO users (tg_user_id, first_name, language, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tg_user_id) DO UPDATE SET first_name = excluded.first_name, last_active_at = excluded.last_active_at,
           status = CASE WHEN users.status = 'blocked' THEN 'active' ELSE users.status END`,
      )
      .bind(id, (firstName ?? "").slice(0, 64), (language ?? "en").slice(0, 8), t, t)
      .run();
    const row = (await this.getUser(id))!;
    return { ...row, isNew: row.created_at === t };
  }

  async updateUser(id: number, fields: Partial<Omit<UserRow, "tg_user_id">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE tg_user_id = ?`;
    await this.d1.prepare(sql).bind(...keys.map((k) => (fields as any)[k]), id).run();
  }

  async getWeights(id: number): Promise<Record<string, number>> {
    const { results } = await this.d1.prepare("SELECT topic, weight FROM user_topics WHERE tg_user_id = ?").bind(id).all<{ topic: string; weight: number }>();
    const w: Record<string, number> = {};
    for (const r of results) w[r.topic] = r.weight;
    return w;
  }

  async setWeight(id: number, topic: string, weight: number) {
    const w = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
    await this.d1
      .prepare("INSERT INTO user_topics (tg_user_id, topic, weight) VALUES (?, ?, ?) ON CONFLICT (tg_user_id, topic) DO UPDATE SET weight = excluded.weight")
      .bind(id, topic, w)
      .run();
  }

  /** Adjust a topic weight, clamped to [0, 20]. Feedback never pushes a chosen topic to exactly 0 via one tap. */
  async adjustWeights(id: number, deltas: Record<string, number>) {
    const stmts = Object.entries(deltas)
      .filter(([t, d]) => TOPIC_IDS.includes(t as any) && d !== 0)
      .map(([topic, d]) =>
        this.d1
          .prepare(
            `INSERT INTO user_topics (tg_user_id, topic, weight) VALUES (?1, ?2, MAX(?4, MIN(?5, ?3)))
             ON CONFLICT (tg_user_id, topic) DO UPDATE SET weight = MAX(?4, MIN(?5, user_topics.weight + ?3))`,
          )
          .bind(id, topic, d, MIN_WEIGHT, MAX_WEIGHT),
      );
    if (stmts.length) await this.d1.batch(stmts);
  }

  async resetTopics(id: number, chosen: string[]) {
    await this.d1.batch([
      this.d1.prepare("DELETE FROM user_topics WHERE tg_user_id = ?").bind(id),
      ...chosen.map((t) => this.d1.prepare("INSERT INTO user_topics (tg_user_id, topic, weight) VALUES (?, ?, ?)").bind(id, t, DEFAULT_TOPIC_WEIGHT)),
    ]);
  }

  async prefs(u: UserRow): Promise<UserPrefs> {
    return { tg_user_id: u.tg_user_id, first_name: u.first_name, role: u.role, depth: u.depth, slots: u.slots, language: u.language, weights: await this.getWeights(u.tg_user_id) };
  }

  async getPool(slotDate: string, slot: number): Promise<PoolItem[]> {
    const { results } = await this.d1.prepare("SELECT * FROM items WHERE slot_date = ? AND slot = ? ORDER BY ai_score DESC").bind(slotDate, slot).all();
    return results.map(rowToItem);
  }

  /** Most recent (date, slot) that has a pool, optionally restricted to a slot bitmask. */
  async latestPoolKey(mask = 0b1111): Promise<{ slot_date: string; slot: number } | null> {
    // Latest by schedule (date, then slot = time of day), not by build time: a rebuilt morning
    // pool must not outrank that evening's briefing.
    const { results } = await this.d1
      .prepare("SELECT DISTINCT slot_date, slot FROM items ORDER BY slot_date DESC, slot DESC LIMIT 12")
      .all<{ slot_date: string; slot: number }>();
    return results.find((r) => mask & (1 << r.slot)) ?? null;
  }

  async getItem(id: number): Promise<PoolItem | null> {
    const r = await this.d1.prepare("SELECT * FROM items WHERE item_id = ?").bind(id).first();
    return r ? rowToItem(r) : null;
  }

  async getItems(ids: number[]): Promise<PoolItem[]> {
    if (!ids.length) return [];
    const { results } = await this.d1.prepare(`SELECT * FROM items WHERE item_id IN (${ids.map(() => "?").join(",")})`).bind(...ids.slice(0, 90)).all();
    const byId = new Map(results.map((r: any) => [r.item_id, rowToItem(r)]));
    return ids.map((i) => byId.get(i)).filter(Boolean) as PoolItem[];
  }

  async recentItems(days: number, limit: number): Promise<PoolItem[]> {
    const since = istDate(new Date(Date.now() - days * 86_400_000));
    const { results } = await this.d1.prepare("SELECT * FROM items WHERE slot_date >= ? ORDER BY ai_score DESC LIMIT ?").bind(since, limit).all();
    return results.map(rowToItem);
  }

  async getSlotMeta(slotDate: string, slot: number): Promise<SlotMeta> {
    const r = await this.d1.prepare("SELECT meta_json FROM slot_meta WHERE slot_date = ? AND slot = ?").bind(slotDate, slot).first<{ meta_json: string }>();
    return r ? JSON.parse(r.meta_json) : {};
  }

  logEvent(id: number, kind: string, itemId: number | null = null) {
    return this.d1.prepare("INSERT INTO events (tg_user_id, item_id, kind, created_at) VALUES (?, ?, ?, ?)").bind(id, itemId, kind, now()).run();
  }

  async isSaved(id: number, itemId: number) {
    return !!(await this.d1.prepare("SELECT 1 FROM saved WHERE tg_user_id = ? AND item_id = ?").bind(id, itemId).first());
  }

  /** Toggle; returns true if now saved. */
  async toggleSave(id: number, itemId: number): Promise<boolean> {
    if (await this.isSaved(id, itemId)) {
      await this.d1.prepare("DELETE FROM saved WHERE tg_user_id = ? AND item_id = ?").bind(id, itemId).run();
      return false;
    }
    await this.d1.prepare("INSERT OR IGNORE INTO saved (tg_user_id, item_id, created_at) VALUES (?, ?, ?)").bind(id, itemId, now()).run();
    return true;
  }

  async listSaved(id: number, limit = 20): Promise<PoolItem[]> {
    const { results } = await this.d1
      .prepare("SELECT i.* FROM saved s JOIN items i ON i.item_id = s.item_id WHERE s.tg_user_id = ? ORDER BY s.created_at DESC LIMIT ?")
      .bind(id, limit)
      .all();
    return results.map(rowToItem);
  }

  addFeedback(id: number, text: string) {
    return this.d1.prepare("INSERT INTO feedback (tg_user_id, text, created_at) VALUES (?, ?, ?)").bind(id, text.slice(0, 2000), now()).run();
  }

  getDelivery(id: number, slotDate: string, slot: number) {
    return this.d1
      .prepare("SELECT item_ids_json, rating FROM deliveries WHERE tg_user_id = ? AND slot_date = ? AND slot = ?")
      .bind(id, slotDate, slot)
      .first<{ item_ids_json: string; rating: number | null }>();
  }

  async recordDelivery(id: number, slotDate: string, slot: number, messageId: number, itemIds: number[]) {
    await this.d1
      .prepare(
        `INSERT INTO deliveries (tg_user_id, slot_date, slot, message_id, item_ids_json, sent_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tg_user_id, slot_date, slot) DO UPDATE SET message_id = excluded.message_id, item_ids_json = excluded.item_ids_json`,
      )
      .bind(id, slotDate, slot, messageId, JSON.stringify(itemIds), now())
      .run();
  }

  async rateDelivery(id: number, slotDate: string, slot: number, rating: 1 | -1): Promise<boolean> {
    const r = await this.d1
      .prepare("UPDATE deliveries SET rating = ? WHERE tg_user_id = ? AND slot_date = ? AND slot = ? AND rating IS NULL")
      .bind(rating, id, slotDate, slot)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async countDigestUps(id: number): Promise<number> {
    const r = await this.d1.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tg_user_id = ? AND rating = 1").bind(id).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async deleteUser(id: number) {
    await this.d1.batch(
      ["users", "user_topics", "deliveries", "events", "saved", "asks", "feedback"].map((t) => this.d1.prepare(`DELETE FROM ${t} WHERE tg_user_id = ?`).bind(id)),
    );
  }
}
