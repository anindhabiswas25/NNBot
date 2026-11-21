/**
 * NodeNeuron digest job (runs on GitHub Actions, or locally).
 *
 *   tsx src/job/run.ts <research|crypto|launches|wrap|daily> [--no-wait] [--dry-run] [--preview-to <tg_id>] [--only <tg_id>]
 *   tsx src/job/run.ts --cron "<cron expr>"     (maps a GitHub schedule backup to a job)
 *
 * --dry-run     build the pool without the Worker/DB and print the digest (nothing stored or sent)
 * --preview-to  with --dry-run: also send the rendered digest to this Telegram chat
 * --only        send only to this user (testing against a real DB)
 * --no-wait     send immediately instead of waiting for the slot time
 */
import { aiConfigured, initBudget, runSpendUsd, usageReport } from "../shared/ai";
import { BOT_NAME, POOL_MAX_PER_SITE, POOL_SIZE, SLOTS, TOPICS, istDate, slotByKey, slotSendTime, topicLabel } from "../shared/config";
import { hostOf, renderDigest } from "../shared/render";
import { rankForUser } from "../shared/rank";
import type { NewPoolItem, PoolItem, SlotMeta, UserPrefs } from "../shared/types";
import { Telegram } from "../worker/tg";
import { Api } from "./api";
import { conceptOfDay } from "./concepts";
import { connectorsFor } from "./connectors";
import { connectStories, rankStories, sortFeedback, writeStories, type Written } from "./pipeline/ai";
import { exactDedupe, guessTopic, isJunk, normalise, urlHash } from "./pipeline/clean";
import { cluster } from "./pipeline/cluster";
import { describeThin } from "./pipeline/describe";
import { enrich } from "./pipeline/enrich";
import { signalScore } from "./pipeline/signals";
import { fallbackItem, validate } from "./pipeline/validate";
import { RateLimiter, sendOne, sendSlot } from "./send";
import type { RawItem, SlotKey, Story } from "./types";
import { loadDotEnv, log, sleep } from "./util";

loadDotEnv();
const env = process.env;

const CRON_TO_JOB: Record<string, string> = {
  // GitHub schedule backups (UTC), 5 min after each slot; idempotent if the Cloudflare trigger already ran
  "35 1 * * *": "research",
  "35 6 * * *": "crypto",
  "35 11 * * *": "launches",
  "35 16 * * *": "wrap",
  "45 5 * * *": "daily",
};

function parseArgs() {
  const a = process.argv.slice(2);
  const flag = (n: string) => a.includes(n);
  const val = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const cron = val("--cron");
  const job = cron ? CRON_TO_JOB[cron] : a.find((x: string) => !x.startsWith("--") && x !== val("--preview-to") && x !== val("--only"));
  return { job, dryRun: flag("--dry-run"), noWait: flag("--no-wait"), previewTo: val("--preview-to"), only: val("--only") ? Number(val("--only")) : undefined };
}

const args = parseArgs();
const tg = new Telegram(env.TELEGRAM_BOT_TOKEN ?? "");
const api = args.dryRun ? null : new Api(env.WORKER_URL ?? "", env.INTERNAL_API_KEY ?? "");
const failures: string[] = [];

async function alertOwner(text: string) {
  log(`ALERT: ${text}`);
  if (!env.OWNER_TG_ID || !env.TELEGRAM_BOT_TOKEN) return;
  await tg.send(Number(env.OWNER_TG_ID), `🚨 <b>${BOT_NAME} job</b>\n${text}`).catch((e) => log(`alert failed: ${e.message}`));
}

// ───────────────────────── build a slot's pool ─────────────────────────

async function gather(slot: SlotKey, state: Record<string, string>): Promise<{ items: RawItem[]; cursors: Record<string, string> }> {
  const now = Date.now();
  const cursors: Record<string, string> = {};
  const connectors = connectorsFor(slot);
  const results = await Promise.allSettled(
    connectors.map(async (c) => {
      const cursor = Date.parse(state[`cursor:${c.name}`] ?? "") || now - 36 * 3_600_000;
      // at least the last 20 h (dedupe drops repeats), at most 72 h
      const since = new Date(Math.max(now - 72 * 3_600_000, Math.min(cursor, now - 20 * 3_600_000)));
      const t0 = Date.now();
      const items = await c.run({ since, env });
      log(`  ${c.name}: ${items.length} items (${Date.now() - t0} ms)`);
      const streak = items.length === 0 ? Number(state[`zero:${c.name}`] ?? 0) + 1 : 0;
      cursors[`zero:${c.name}`] = String(streak);
      if (streak >= 5) failures.push(`${c.name}: 0 items for ${streak} runs in a row`);
      cursors[`cursor:${c.name}`] = new Date(now).toISOString();
      return items;
    }),
  );
  const items: RawItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      log(`  ✗ ${connectors[i].name}: ${r.reason?.message ?? r.reason}`);
      failures.push(`${connectors[i].name}: ${String(r.reason?.message ?? r.reason).slice(0, 120)}`);
    }
  });
  log(`gathered ${items.length} items from ${connectors.length} sources (${results.filter((r) => r.status === "rejected").length} failed)`);
  return { items, cursors };
}

async function buildPool(slot: SlotKey): Promise<{ items: NewPoolItem[]; meta: SlotMeta; hashes: string[]; cursors: Record<string, string> }> {
  const [state, sent] = api ? await Promise.all([api.state(), api.sentUrls()]) : [{}, []];
  const { items: raw, cursors } = await gather(slot, state);

  // 2–3. normalise + exact dedupe (incl. anything sent in the last 7 days)
  let items = exactDedupe(normalise(raw), new Set(sent));
  log(`after dedupe: ${items.length}`);

  // 5a. junk filter
  items = items.filter((it) => {
    const why = isJunk(it);
    if (why) log(`  junk: ${it.title.slice(0, 70)} (${why})`);
    return !why;
  });

  // Pre-cut before clustering: arXiv posts hundreds a day; keep papers that match our topics or have signals.
  const pre = items
    .map((it) => ({ it, rel: guessTopic(it, slot).relevance }))
    .filter(({ it, rel }) => it.source !== "arXiv" || rel >= 2)
    .sort((a, b) => a.it.trust - b.it.trust || (b.it.data.hf_upvotes ?? 0) - (a.it.data.hf_upvotes ?? 0) || b.rel - a.rel)
    .slice(0, 350)
    .map((x) => x.it);
  log(`pre-cut: ${pre.length}`);

  // 4. cluster, 5b. signals
  let stories = await cluster(pre, slot, env);
  for (const s of stories) s.signal = signalScore(s);
  if (slot === "research") stories = stories.filter((s) => s.type === "paper");
  stories = stories.filter((s) => s.domain_ok);
  log(`stories: ${stories.length}`);

  // Candidate cut for AI: top 60 by signal (+ a bit for keyword relevance)
  let candidates = stories
    .map((s) => ({ s, k: s.signal + Math.min(2, guessTopic({ title: s.title, text: s.text }, slot).relevance * 0.3) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, 60)
    .map((x) => x.s);

  // Title-only link posts (mostly HN): fetch the linked page's own description first
  await describeThin(candidates);

  // 6–7. AI tag + judge (one call per batch). Failures only cost ranking quality:
  // fall back to keyword topics + signal scores, still try the writer.
  let aiOk = aiConfigured(env);
  if (aiOk) {
    try {
      await rankStories(env, candidates, slot);
      candidates = candidates.filter((s) => s.domain_ok);
    } catch (e) {
      log(`AI ranking unavailable, using keyword topics + signals: ${(e as Error).message}`);
    }
  }
  for (const s of candidates) s.ai_score = s.judge != null ? 0.6 * s.judge + 0.4 * s.signal : s.signal;

  // Pick top POOL_SIZE with topic and source variety (≤ 8 per topic, ≤ POOL_MAX_PER_SITE per website)
  const perTopic: Record<string, number> = {};
  const perSite: Record<string, number> = {};
  const top: Story[] = [];
  const ordered = [...candidates].sort((a, b) => b.ai_score - a.ai_score);
  for (const s of ordered) {
    if (top.length >= POOL_SIZE) break;
    if ((perTopic[s.topic] ?? 0) >= 8) continue;
    const site = hostOf(s.urls[0] ?? "");
    if ((perSite[site] ?? 0) >= POOL_MAX_PER_SITE) continue;
    if (s.type === "data" && top.filter((t) => t.type === "data").length >= 4) continue; // keep the brief news-led
    perSite[site] = (perSite[site] ?? 0) + 1;
    perTopic[s.topic] = (perTopic[s.topic] ?? 0) + 1;
    top.push(s);
  }
  // Too few other websites today → top up from the best remaining rather than ship a short pool
  for (const s of ordered) {
    if (top.length >= POOL_SIZE) break;
    if (!top.includes(s)) top.push(s);
  }

  // 8. enrich
  await enrich(top, env);

  // 9–10. write + validate
  let written = new Map<number, Written>();
  if (aiOk) {
    try {
      written = await writeStories(env, top);
    } catch (e) {
      aiOk = false;
      failures.push(`AI writer: ${(e as Error).message}`);
    }
  }
  const out: NewPoolItem[] = [];
  const dropped: Story[] = [];
  for (const s of top) {
    if (!aiOk) {
      out.push(fallbackItem(s));
      continue;
    }
    const w = written.get(s.id);
    if (!w) {
      out.push(fallbackItem(s)); // writer unavailable for this batch → plain summary rather than dropping
      continue;
    }
    const v = validate(s, w);
    if (v.item) out.push(v.item);
    else {
      log(`  dropped "${s.title.slice(0, 60)}": ${v.reason}`);
      dropped.push(s);
    }
  }
  // A briefing with fewer than 5 items is worse than one with plain summaries — top up from the dropped ones.
  if (aiOk && out.length < 5) for (const s of dropped.slice(0, 5 - out.length)) out.push(fallbackItem(s));

  const meta: SlotMeta = {};
  if (!aiOk) meta.note = "AI summaries were unavailable this run, so these are source headlines.";
  log(`pool: ${out.length} items (AI ${aiOk ? "on" : "off"})`);
  return { items: out, meta, hashes: top.flatMap((s) => s.items.map((i) => urlHash(i.url))), cursors };
}

// ───────────────────────── Daily Wrap ─────────────────────────

async function buildWrap(dayItems: PoolItem[], date: string): Promise<SlotMeta> {
  const candidates = dayItems.slice(0, 15);
  const meta: SlotMeta = {};
  if (aiConfigured(env) && candidates.length >= 3) {
    try {
      const w = await connectStories(env, candidates);
      const ids = (w.top_ids ?? []).filter((id) => candidates.some((c) => c.item_id === id)).slice(0, 3);
      if (ids.length === 3) meta.wrap_item_ids = ids;
      if (w.connection) meta.connection = w.connection.slice(0, 300);
      if (w.concept_title && w.concept_body) {
        meta.concept_title = w.concept_title.slice(0, 60);
        meta.concept_body = w.concept_body.slice(0, 500);
      }
    } catch (e) {
      failures.push(`AI connector: ${(e as Error).message}`);
    }
  }
  if (!meta.wrap_item_ids) {
    // code fallback: top 3 by score, one per topic
    const seen = new Set<string>();
    meta.wrap_item_ids = candidates.filter((i) => !seen.has(i.topic) && seen.add(i.topic)).slice(0, 3).map((i) => i.item_id);
  }
  if (!meta.concept_title) {
    const c = conceptOfDay(date);
    meta.concept_title = c.title;
    meta.concept_body = c.body;
  }
  return meta;
}

// ───────────────────────── modes ─────────────────────────

async function waitForSlot(date: string, slot: number) {
  if (args.noWait) return;
  const ms = slotSendTime(date, slot).getTime() - Date.now();
  if (ms > 0 && ms < 40 * 60_000) {
    log(`waiting ${Math.round(ms / 1000)} s until ${SLOTS[slot].name} send time`);
    await sleep(ms);
  }
}

async function runSlot(key: SlotKey | "wrap") {
  const slot = slotByKey(key)!.id;
  // date of the slot we're preparing: runs start ≤ 40 min early, so use IST date at send time
  const date = istDate(new Date(Date.now() + 40 * 60_000));
  log(`▶ ${SLOTS[slot].name} for ${date}${args.dryRun ? " (dry run)" : ""}`);

  if (args.dryRun) return dryRun(key, slot, date);
  if (!api || !env.WORKER_URL || !env.INTERNAL_API_KEY) throw new Error("WORKER_URL and INTERNAL_API_KEY are required (or use --dry-run)");

  let pool: PoolItem[];
  let meta: SlotMeta;
  const existing = await api.getPool(date, slot);

  if (key === "wrap") {
    const day = await api.dayItems(date);
    if (day.length < 3) {
      await alertOwner(`Daily Wrap skipped: only ${day.length} items today.`);
      return;
    }
    meta = existing.meta?.wrap_item_ids ? existing.meta : await buildWrap(day, date);
    if (!existing.meta?.wrap_item_ids) await api.putMeta(date, slot, meta);
    pool = day;
  } else if (existing.items.length) {
    log(`pool already built (${existing.items.length} items) — resuming delivery only`);
    pool = existing.items;
    meta = existing.meta ?? {};
  } else {
    const built = await buildPool(key);
    if (!built.items.length) {
      await alertOwner(`${SLOTS[slot].name}: empty pool, nothing sent.\n${failures.join("\n")}`);
      return;
    }
    const res = await api.putPool(date, slot, built.items, built.meta);
    if (res.error) log(`pool store: ${res.error}`);
    await api.addSentUrls(built.hashes);
    await api.putState(built.cursors);
    const stored = await api.getPool(date, slot);
    pool = stored.items;
    meta = stored.meta ?? built.meta;
  }

  const streaks = failures.filter((f) => f.includes("runs in a row"));
  if (failures.length - streaks.length >= 3 || streaks.length) await alertOwner(`${SLOTS[slot].name}: source problems\n${failures.map((f) => `• ${f}`).join("\n")}`);

  await waitForSlot(date, slot);
  await sendSlot(api, tg, date, slot, pool, meta, args.only);
}

async function dryRun(key: SlotKey | "wrap", slot: number, date: string) {
  if (key === "wrap") {
    log("dry-run for wrap needs stored items; run a content slot instead");
    return;
  }
  const built = await buildPool(key);
  const pool: PoolItem[] = built.items.map((it, i) => ({ ...it, item_id: 900000 + i, slot_date: date, slot }));
  const demo: UserPrefs = { tg_user_id: 0, role: "researcher", depth: "detailed", slots: 15, language: "en", weights: Object.fromEntries(TOPICS.map((t) => [t.id, 10])) };
  const r = renderDigest(slot, date, rankForUser(pool, demo, { wildcard: false }), { depth: "detailed", meta: built.meta });
  console.log("\n──────── pool ────────");
  for (const it of pool) console.log(`${it.ai_score.toFixed(1).padStart(5)}  [${topicLabel(it.topic)}/${it.type}] ${it.title}  ← ${it.source_urls[0]}`);
  console.log("\n──────── digest (HTML) ────────\n" + r.text + `\n\n(${r.text.length} chars)`);
  console.log("\n──────── detail text, top 5 ────────");
  for (const it of pool.slice(0, 5)) console.log(`\n■ ${it.title}  (${it.source_urls[0]})\n  long:   ${it.summary_long}\n  why:    ${it.why_it_matters}\n  simple: ${it.simple_words}`);
  if (failures.length) console.log(`\nsource issues:\n${failures.map((f) => ` • ${f}`).join("\n")}`);
  if (args.previewTo) {
    await sendOne(tg, new RateLimiter(1), Number(args.previewTo), r);
    log(`preview sent to ${args.previewTo} (buttons need the Worker running)`);
  }
}

async function runDaily() {
  if (!api) throw new Error("daily job needs WORKER_URL and INTERNAL_API_KEY");
  const isSunday = new Date(Date.now() + 330 * 60_000).getUTCDay() === 0;
  const limiter = new RateLimiter(25);

  // Onboarding reminder: once, 24 h after an unfinished /start
  const stale = await api.staleOnboarding();
  const reminded: number[] = [];
  for (const u of stale) {
    const r = await sendOne(tg, limiter, u.tg_user_id, `👋 ${u.first_name ? `Hi ${u.first_name}! ` : ""}You're one tap away from your first ${BOT_NAME} briefing. Send /start to finish setup — it takes 30 seconds.`);
    reminded.push(u.tg_user_id);
    if (r.result === "blocked") await api.blocked([u.tg_user_id]);
  }
  if (reminded.length) await api.reminded(reminded);
  log(`onboarding reminders: ${reminded.length}`);

  if (isSunday) {
    // Weekly check-in (Sunday 11 AM IST)
    let after = 0, n = 0;
    for (;;) {
      const page = await api.weekly(after);
      for (const u of page.users) {
        const top = Object.entries(u.opened).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => topicLabel(t));
        if (!top.length) continue; // nothing opened this week → nothing meaningful to summarise
        const r = await sendOne(tg, limiter, u.tg_user_id, {
          text: `📅 <b>Your week with ${BOT_NAME}</b>\nThis week you opened mostly ${top.join(" and ")}. Keep this mix?`,
          reply_markup: { inline_keyboard: [[{ text: "✅ Keep", callback_data: "wk:keep" }, { text: "⚙️ Adjust", callback_data: "wk:adj" }]] },
        });
        if (r.result === "sent") n++;
      }
      if (page.next == null) break;
      after = page.next;
    }
    log(`weekly check-ins: ${n}`);

    // Feedback sorter + weekly summary to the owner
    const rows = await api.feedbackUnsorted();
    if (rows.length) {
      let sorted: { id: number; category: string }[] = [];
      try {
        sorted = await sortFeedback(env, rows);
        await api.feedbackSorted(sorted);
      } catch (e) {
        log(`feedback sort failed: ${(e as Error).message}`);
      }
      const cat = new Map(sorted.map((s) => [s.id, s.category]));
      const groups: Record<string, string[]> = {};
      for (const r of rows) (groups[cat.get(r.id) ?? "unsorted"] ??= []).push(r.text);
      const body = Object.entries(groups).map(([k, v]) => `<b>${k}</b> (${v.length})\n${v.slice(0, 8).map((t) => `• ${t.slice(0, 200).replace(/[<>&]/g, "")}`).join("\n")}`).join("\n\n");
      await alertOwner(`📝 Weekly feedback (${rows.length})\n\n${body}`.slice(0, 4000));
    }
  }

  await api.housekeeping(isSunday);
  log("housekeeping done");
}

/** Claude spend is tracked per calendar month (UTC) in the Worker's state store. */
const spendKey = () => `claude_usd:${new Date().toISOString().slice(0, 7)}`;

async function main() {
  const job = args.job;
  if (!job) throw new Error("usage: run.ts <research|crypto|launches|wrap|daily> [--dry-run] [--no-wait]");
  if (job !== "daily" && !["research", "crypto", "launches", "wrap"].includes(job)) throw new Error(`unknown job ${job}`);

  const spent = api ? Number((await api.state())[spendKey()] ?? 0) || 0 : 0;
  initBudget(env, spent);
  try {
    if (job === "daily") await runDaily();
    else await runSlot(job as SlotKey | "wrap");
  } finally {
    log(usageReport());
    // re-read just before writing: another job may have run in parallel
    if (api && runSpendUsd() > 0) {
      const latest = Number((await api.state())[spendKey()] ?? 0) || 0;
      await api.putState({ [spendKey()]: (latest + runSpendUsd()).toFixed(6) }).catch((e) => log(`spend save failed: ${e.message}`));
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  await alertOwner(`Job ${args.job} crashed: ${(e as Error).message}`.slice(0, 1000));
  process.exit(1);
});
