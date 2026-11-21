/**
 * Authenticated endpoints for the GitHub Actions digest job (PRD: the job reads and writes D1
 * through a small authenticated Worker endpoint). All routes require header `x-internal-key`.
 */
import type { NewPoolItem, SlotMeta, UserPrefs } from "../shared/types";
import type { Env } from "./bot";
import { now, rowToItem } from "./db";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function handleInternal(req: Request, env: Env, url: URL): Promise<Response> {
  const key = req.headers.get("x-internal-key") ?? "";
  if (!env.INTERNAL_API_KEY || !timingSafeEqual(key, env.INTERNAL_API_KEY)) return json({ error: "unauthorized" }, 401);

  const d1 = env.DB;
  const route = `${req.method} ${url.pathname.replace(/^\/internal/, "")}`;
  const q = url.searchParams;
  const body: any = req.method === "GET" ? null : await req.json().catch(() => ({}));

  switch (route) {
    case "GET /state": {
      const { results } = await d1.prepare("SELECT key, value FROM source_state").all<{ key: string; value: string }>();
      return json(Object.fromEntries(results.map((r) => [r.key, r.value])));
    }
    case "PUT /state": {
      const entries = Object.entries(body as Record<string, string>);
      if (entries.length)
        await d1.batch(entries.map(([k, v]) => d1.prepare("INSERT INTO source_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, String(v))));
      return json({ ok: true });
    }

    case "GET /sent-urls": {
      const { results } = await d1.prepare("SELECT url_hash FROM sent_urls WHERE sent_at > ?").bind(now() - 7 * 86_400_000).all<{ url_hash: string }>();
      return json(results.map((r) => r.url_hash));
    }
    case "POST /sent-urls": {
      const hashes: string[] = body.hashes ?? [];
      const t = now();
      for (let i = 0; i < hashes.length; i += 50)
        await d1.batch(hashes.slice(i, i + 50).map((h) => d1.prepare("INSERT OR REPLACE INTO sent_urls (url_hash, sent_at) VALUES (?, ?)").bind(h, t)));
      return json({ ok: true });
    }

    case "GET /pool": {
      const { results } = await d1.prepare("SELECT * FROM items WHERE slot_date = ? AND slot = ? ORDER BY ai_score DESC").bind(q.get("date"), Number(q.get("slot"))).all();
      const meta = await d1.prepare("SELECT meta_json FROM slot_meta WHERE slot_date = ? AND slot = ?").bind(q.get("date"), Number(q.get("slot"))).first<{ meta_json: string }>();
      return json({ items: results.map(rowToItem), meta: meta ? JSON.parse(meta.meta_json) : null });
    }
    case "POST /pool": {
      const { slot_date, slot, items, meta } = body as { slot_date: string; slot: number; items: NewPoolItem[]; meta?: SlotMeta };
      const existing = await d1.prepare("SELECT COUNT(*) AS n FROM items WHERE slot_date = ? AND slot = ?").bind(slot_date, slot).first<{ n: number }>();
      if (existing?.n) return json({ error: "pool already exists" }, 409);
      const t = now();
      const res = await d1.batch(
        items.map((it) =>
          d1
            .prepare(
              `INSERT INTO items (slot_date, slot, type, topic, title, summary_short, summary_long, why_it_matters, simple_words, data_json, source_urls_json, ai_score, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING item_id`,
            )
            .bind(slot_date, slot, it.type, it.topic, it.title, it.summary_short, it.summary_long, it.why_it_matters, it.simple_words, JSON.stringify(it.data), JSON.stringify(it.source_urls), it.ai_score, t),
        ),
      );
      if (meta) await putMeta(d1, slot_date, slot, meta);
      return json({ item_ids: res.map((r: any) => r.results[0].item_id) });
    }
    case "PUT /slot-meta": {
      await putMeta(d1, body.slot_date, body.slot, body.meta);
      return json({ ok: true });
    }
    case "GET /day-items": {
      const { results } = await d1.prepare("SELECT * FROM items WHERE slot_date = ? AND slot < 3 ORDER BY ai_score DESC LIMIT 60").bind(q.get("date")).all();
      return json(results.map(rowToItem));
    }

    case "GET /recipients": {
      const slot = Number(q.get("slot"));
      const after = Number(q.get("after") ?? 0);
      const limit = Math.min(500, Number(q.get("limit") ?? 500));
      const { results: users } = await d1
        .prepare(
          `SELECT tg_user_id, first_name, role, depth, slots, language FROM users u
           WHERE status = 'active' AND (slots & ?) != 0 AND tg_user_id > ?
             AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.tg_user_id = u.tg_user_id AND d.slot_date = ? AND d.slot = ?)
           ORDER BY tg_user_id LIMIT ?`,
        )
        .bind(1 << slot, after, q.get("date"), slot, limit)
        .all<any>();
      if (!users.length) return json({ users: [], next: null });
      const lo = users[0].tg_user_id;
      const hi = users[users.length - 1].tg_user_id;
      const { results: w } = await d1.prepare("SELECT tg_user_id, topic, weight FROM user_topics WHERE tg_user_id BETWEEN ? AND ?").bind(lo, hi).all<any>();
      const byUser = new Map<number, Record<string, number>>();
      for (const r of w) (byUser.get(r.tg_user_id) ?? byUser.set(r.tg_user_id, {}).get(r.tg_user_id)!)[r.topic] = r.weight;
      const out: UserPrefs[] = users.map((u) => ({ ...u, weights: byUser.get(u.tg_user_id) ?? {} }));
      return json({ users: out, next: users.length === limit ? hi : null });
    }
    case "POST /deliveries": {
      const rows: { tg_user_id: number; slot_date: string; slot: number; message_id: number; item_ids: number[] }[] = body.deliveries ?? [];
      const t = now();
      for (let i = 0; i < rows.length; i += 50)
        await d1.batch(
          rows.slice(i, i + 50).map((r) =>
            d1
              .prepare("INSERT OR IGNORE INTO deliveries (tg_user_id, slot_date, slot, message_id, item_ids_json, sent_at) VALUES (?, ?, ?, ?, ?, ?)")
              .bind(r.tg_user_id, r.slot_date, r.slot, r.message_id, JSON.stringify(r.item_ids), t),
          ),
        );
      return json({ ok: true });
    }
    case "POST /blocked": {
      const ids: number[] = body.ids ?? [];
      for (let i = 0; i < ids.length; i += 50)
        await d1.batch(ids.slice(i, i + 50).map((id) => d1.prepare("UPDATE users SET status = 'blocked' WHERE tg_user_id = ?").bind(id)));
      return json({ ok: true });
    }

    // ── daily housekeeping job
    case "GET /stale-onboarding": {
      const { results } = await d1
        .prepare("SELECT tg_user_id, first_name FROM users WHERE status = 'onboarding' AND reminded_at IS NULL AND created_at < ? AND created_at > ? LIMIT 500")
        .bind(now() - 86_400_000, now() - 7 * 86_400_000)
        .all();
      return json(results);
    }
    case "POST /reminded": {
      const ids: number[] = body.ids ?? [];
      for (let i = 0; i < ids.length; i += 50)
        await d1.batch(ids.slice(i, i + 50).map((id) => d1.prepare("UPDATE users SET reminded_at = ? WHERE tg_user_id = ?").bind(now(), id)));
      return json({ ok: true });
    }
    case "GET /weekly": {
      const after = Number(q.get("after") ?? 0);
      const limit = 500;
      const { results: users } = await d1
        .prepare("SELECT tg_user_id FROM users WHERE status = 'active' AND tg_user_id > ? ORDER BY tg_user_id LIMIT ?")
        .bind(after, limit)
        .all<{ tg_user_id: number }>();
      if (!users.length) return json({ users: [], next: null });
      const lo = users[0].tg_user_id;
      const hi = users[users.length - 1].tg_user_id;
      const { results: ev } = await d1
        .prepare(
          `SELECT e.tg_user_id, i.topic, COUNT(*) AS n FROM events e JOIN items i ON i.item_id = e.item_id
           WHERE e.created_at > ? AND e.kind IN ('open','save','more') AND e.tg_user_id BETWEEN ? AND ?
           GROUP BY e.tg_user_id, i.topic`,
        )
        .bind(now() - 7 * 86_400_000, lo, hi)
        .all<{ tg_user_id: number; topic: string; n: number }>();
      const by = new Map<number, Record<string, number>>();
      for (const r of ev) (by.get(r.tg_user_id) ?? by.set(r.tg_user_id, {}).get(r.tg_user_id)!)[r.topic] = r.n;
      return json({ users: users.map((u) => ({ tg_user_id: u.tg_user_id, opened: by.get(u.tg_user_id) ?? {} })), next: users.length === limit ? hi : null });
    }
    case "GET /feedback-unsorted": {
      const { results } = await d1.prepare("SELECT rowid AS id, text FROM feedback WHERE ai_category IS NULL ORDER BY created_at LIMIT 200").all();
      return json(results);
    }
    case "POST /feedback-sorted": {
      const rows: { id: number; category: string }[] = body.rows ?? [];
      for (let i = 0; i < rows.length; i += 50)
        await d1.batch(rows.slice(i, i + 50).map((r) => d1.prepare("UPDATE feedback SET ai_category = ? WHERE rowid = ?").bind(r.category, r.id)));
      return json({ ok: true });
    }
    case "POST /housekeeping": {
      const t = now();
      const stmts = [
        d1.prepare("DELETE FROM sent_urls WHERE sent_at < ?").bind(t - 8 * 86_400_000),
        d1.prepare("DELETE FROM events WHERE created_at < ?").bind(t - 180 * 86_400_000),
        d1.prepare("DELETE FROM asks WHERE created_at < ?").bind(t - 30 * 86_400_000),
        d1.prepare("DELETE FROM items WHERE created_at < ? AND item_id NOT IN (SELECT item_id FROM saved)").bind(t - 90 * 86_400_000),
        d1.prepare("DELETE FROM deliveries WHERE sent_at < ?").bind(t - 120 * 86_400_000),
      ];
      if (body.decay) {
        // Slow decay: a topic the user hasn't opened, saved or ➕'d in 14 days loses 1 point (floor 2).
        stmts.push(
          d1
            .prepare(
              `UPDATE user_topics SET weight = MAX(2, weight - 1)
               WHERE weight > 2
                 AND tg_user_id IN (SELECT tg_user_id FROM users WHERE status = 'active' AND created_at < ?1)
                 AND NOT EXISTS (
                   SELECT 1 FROM events e JOIN items i ON i.item_id = e.item_id
                   WHERE e.tg_user_id = user_topics.tg_user_id AND i.topic = user_topics.topic
                     AND e.created_at > ?1 AND e.kind IN ('open','save','more'))`,
            )
            .bind(t - 14 * 86_400_000),
        );
      }
      await d1.batch(stmts);
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

async function putMeta(d1: D1Database, slotDate: string, slot: number, meta: SlotMeta) {
  await d1
    .prepare("INSERT INTO slot_meta (slot_date, slot, meta_json) VALUES (?, ?, ?) ON CONFLICT (slot_date, slot) DO UPDATE SET meta_json = excluded.meta_json")
    .bind(slotDate, slot, JSON.stringify(meta))
    .run();
}
