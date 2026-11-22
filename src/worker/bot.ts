import {
  ALL_SLOTS_MASK, BOT_NAME, ROLES, SIGNAL_DELTA, SLOTS, TAGLINE, TOPICS, TOPIC_IDS,
  istDate, topicLabel, type RoleId,
} from "../shared/config";
import { isWildcardSlot, rankForUser } from "../shared/rank";
import { esc, helpText, link, renderDetail, renderDigest, type InlineButton, type Rendered } from "../shared/render";
import type { PoolItem } from "../shared/types";
import { DB, now, type UserRow } from "./db";
import { Telegram, TelegramError } from "./tg";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTERNAL_API_KEY: string;
  OWNER_TG_ID?: string;
  GITHUB_REPO_URL: string;
  GITHUB_DISPATCH_REPO?: string;
  GITHUB_DISPATCH_TOKEN?: string;
}

interface Ctx {
  env: Env;
  db: DB;
  tg: Telegram;
  exec: ExecutionContext;
}

const ROLE_TOPICS: Record<RoleId, string[]> = {
  student: ["llms", "agents"],
  researcher: ["llms", "safety"],
  developer: ["llms", "agents", "ethereum"],
  trader: ["bitcoin", "ethereum", "defi", "aixcrypto"],
};

const MONTH_MS = 30 * 86_400_000;

// ───────────────────────── screens ─────────────────────────

function kb(rows: InlineButton[][]): Rendered["reply_markup"] {
  return { inline_keyboard: rows };
}
const cb = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const welcomeScreen = (name?: string | null): Rendered => ({
  text: `👋 Welcome to <b>${BOT_NAME}</b>${name ? `, ${esc(name)}` : ""}!\n${TAGLINE}\n\nSetup takes 30 seconds.`,
  reply_markup: kb([[cb("Let's go ➡️", "ob:go")]]),
});

const roleScreen = (prefix: "ob" | "st"): Rendered => ({
  text: "<b>Who are you?</b>\nThis just sets sensible defaults — you can change everything later.",
  reply_markup: kb(chunk((Object.keys(ROLES) as RoleId[]).map((r) => cb(ROLES[r].label, `${prefix}:role:${r}`)), 2)),
});

function topicsScreen(prefix: "ob" | "tp" | "st", weights: Record<string, number>): Rendered {
  const chosen = TOPICS.filter((t) => (weights[t.id] ?? 0) > 0);
  return {
    text: `<b>Pick your topics</b> (tap to toggle, at least one)\n\nSelected: ${chosen.length ? chosen.map((t) => t.label).join(", ") : "<i>none yet</i>"}`,
    reply_markup: kb([
      ...chunk(TOPICS.map((t) => cb(`${(weights[t.id] ?? 0) > 0 ? "✅ " : ""}${t.label}`, `${prefix}:t:${t.id}`)), 2),
      [cb("Done ➡️", `${prefix}:td`)],
    ]),
  };
}

const depthScreen = (): Rendered => ({
  text: "<b>How much detail?</b>",
  reply_markup: kb([
    [cb("⚡ Quick: headlines + 1 line", "ob:depth:quick")],
    [cb("📚 Detailed: summary + why it matters", "ob:depth:detailed")],
  ]),
});

function slotsScreen(prefix: "ob" | "st", mask: number): Rendered {
  return {
    text: "<b>When should I message you?</b> (IST, tap to turn off)",
    reply_markup: kb([
      ...SLOTS.map((s) => [cb(`${mask & (1 << s.id) ? "✅" : "⬜"} ${s.button}`, `${prefix}:s:${s.id}`)]),
      [cb("Done ➡️", `${prefix}:sd`)],
    ]),
  };
}

const starButton = (env: Env): InlineButton => ({ text: "⭐ Star on GitHub", url: env.GITHUB_REPO_URL });

const doneScreen = (env: Env): Rendered => ({
  text: `🎉 <b>You're all set!</b> Your first briefing is below.\n\n${BOT_NAME} is free and open source; if you find it useful, a GitHub star helps others discover it 🙏`,
  reply_markup: kb([[starButton(env), cb("Maybe later", "star:later")]]),
});

function settingsScreen(u: UserRow): Rendered {
  const slots = SLOTS.filter((s) => u.slots & (1 << s.id)).map((s) => s.button).join(", ") || "none";
  return {
    text: [
      "⚙️ <b>Settings</b>",
      "",
      `👤 Role: ${u.role && Object.hasOwn(ROLES, u.role) ? ROLES[u.role].label : "—"}`,
      `📚 Depth: ${u.depth === "quick" ? "⚡ Quick" : "📚 Detailed"}`,
      `🕒 Slots: ${slots}`,
      `🌐 Language: English`,
      `${u.status === "paused" ? "⏸ Digests paused" : "▶️ Digests on"}`,
    ].join("\n"),
    reply_markup: kb([
      [cb(`Depth → ${u.depth === "quick" ? "📚 Detailed" : "⚡ Quick"}`, "st:depth")],
      [cb("🕒 Slots", "st:slots"), cb("🏷 Topics", "st:topics")],
      [cb("👤 Role", "st:roles"), cb("🌐 Language", "st:lang")],
      [cb(u.status === "paused" ? "▶️ Resume digests" : "⏸ Pause digests", "st:pause")],
    ]),
  };
}

function nextSlotText(mask: number): string {
  const s = SLOTS.find((x) => mask & (1 << x.id));
  return s ? `${s.emoji} ${s.name} at ${s.button.split(" ").slice(0, 2).join(" ")} IST` : "your next slot";
}

// ───────────────────────── digests ─────────────────────────

/** Render the user's personal version of a stored pool and send it. Returns false if nothing to send. */
async function sendDigest(c: Ctx, u: UserRow, slotDate: string, slot: number): Promise<boolean> {
  const prefs = await c.db.prefs(u);
  const meta = await c.db.getSlotMeta(slotDate, slot);
  let items;
  if (SLOTS[slot].key === "wrap") {
    const wrapItems = await c.db.getItems(meta.wrap_item_ids ?? []);
    items = wrapItems.map((i) => ({ ...i, user_score: i.ai_score }));
  } else {
    items = rankForUser(await c.db.getPool(slotDate, slot), prefs, { wildcard: isWildcardSlot(prefs, slot) });
  }
  if (!items.length) return false;
  const simpler = !!u.role && Object.hasOwn(ROLES, u.role) && ROLES[u.role].simpler;
  const r = renderDigest(slot, slotDate, items, { depth: u.depth, simpler, meta });
  const m = await c.tg.send(u.tg_user_id, r);
  await c.db.recordDelivery(u.tg_user_id, slotDate, slot, m.message_id, items.map((i) => i.item_id));
  return true;
}

async function sendLatest(c: Ctx, u: UserRow, intro?: string): Promise<boolean> {
  const key = (await c.db.latestPoolKey(u.slots || ALL_SLOTS_MASK)) ?? (await c.db.latestPoolKey());
  if (!key) return false;
  if (intro) await c.tg.send(u.tg_user_id, intro);
  return sendDigest(c, u, key.slot_date, key.slot);
}

// ───────────────────────── messages ─────────────────────────

export async function handleUpdate(update: any, env: Env, exec: ExecutionContext) {
  const c: Ctx = { env, db: new DB(env.DB), tg: new Telegram(env.TELEGRAM_BOT_TOKEN), exec };
  try {
    if (update.message) await onMessage(c, update.message);
    else if (update.callback_query) await onCallback(c, update.callback_query);
    else if (update.my_chat_member) await onChatMember(c, update.my_chat_member);
  } catch (e) {
    console.error("update failed", e);
    if (update.callback_query) await c.tg.answer(update.callback_query.id, "⚠️ Something went wrong, please try again.");
  }
}

async function onChatMember(c: Ctx, m: any) {
  if (m.chat?.type !== "private") return;
  const status = m.new_chat_member?.status;
  if (status === "kicked") await c.db.updateUser(m.chat.id, { status: "blocked" });
}

async function onMessage(c: Ctx, msg: any) {
  if (msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
  const id: number = msg.from.id;
  const text: string = (msg.text ?? "").trim();
  const u = await c.db.ensureUser(id, msg.from.first_name, msg.from.language_code);
  if (u.isNew) notifyOwnerNewUser(c, msg.from);

  const m = text.match(/^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i);
  if (!m) {
    if (u.status === "onboarding") return void (await c.tg.send(id, "Tap /start to finish setup — it takes 30 seconds."));
    return void (await c.tg.send(id, "I work with buttons and commands 🙂 Try /today for the latest briefing, /topics to tune it, or /help."));
  }
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();

  switch (cmd) {
    case "start": {
      const r = await c.tg.send(id, welcomeScreen(msg.from.first_name));
      if (u.status === "onboarding") await c.db.updateUser(id, { onboarding_msg_id: r.message_id });
      return;
    }
    case "help":
      return void (await c.tg.send(id, helpText(c.env.GITHUB_REPO_URL)));
    case "today": {
      const ok = await sendLatest(c, u);
      if (!ok) await c.tg.send(id, `No briefing yet today — the next one is the ${nextSlotText(u.slots || ALL_SLOTS_MASK)}.`);
      return;
    }
    case "topics":
      return void (await c.tg.send(id, topicsScreen("tp", await c.db.getWeights(id))));
    case "settings":
      return void (await c.tg.send(id, settingsScreen(u)));
    case "pause":
      await c.db.updateUser(id, { status: "paused" });
      return void (await c.tg.send(id, "⏸ Digests paused. Your settings are kept — /resume any time."));
    case "resume":
      await c.db.updateUser(id, { status: "active" });
      return void (await c.tg.send(id, `▶️ Welcome back! Next up: ${nextSlotText(u.slots || ALL_SLOTS_MASK)}.`));
    case "saved":
      return cmdSaved(c, id);
    case "feedback":
      if (!arg) return void (await c.tg.send(id, "Send it like this:\n<code>/feedback the crypto brief has too many Solana items</code>"));
      await c.db.addFeedback(id, arg);
      return void (await c.tg.send(id, "🙏 Thanks! Your feedback reached the team."));
    case "deleteme":
      return void (await c.tg.send(id, {
        text: "⚠️ This permanently erases your settings, saved items and history. Are you sure?",
        reply_markup: kb([[cb("🗑 Yes, delete everything", "del:yes"), cb("Cancel", "del:no")]]),
      }));
    case "admin":
      return cmdAdmin(c, id);
    default:
      return void (await c.tg.send(id, "Unknown command. /help lists everything I can do."));
  }
}

async function cmdSaved(c: Ctx, id: number) {
  const items = await c.db.listSaved(id);
  if (!items.length) return void (await c.tg.send(id, "Nothing saved yet. Tap 🔖 Save on any detail card."));
  const lines = ["🔖 <b>Your saved items</b>", ""];
  items.forEach((it, i) => lines.push(`${i + 1}. ${it.source_urls[0] ? link(it.source_urls[0], it.title) : esc(it.title)}`));
  lines.push("", "Tap a number for the detail card 👇");
  await c.tg.send(id, { text: lines.join("\n"), reply_markup: kb(chunk(items.map((it, i) => cb(`${i + 1}`, `d:${it.item_id}`)), 5)) });
}

/** Pings the owner (OWNER_TG_ID) when someone uses the bot for the first time. Runs in the background; never blocks or breaks the user's request. */
function notifyOwnerNewUser(c: Ctx, from: { id: number; first_name?: string; username?: string; language_code?: string }) {
  const owner = Number(c.env.OWNER_TG_ID);
  if (!owner || from.id === owner) return;
  c.exec.waitUntil(
    (async () => {
      const total = (await c.db.d1.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? "?";
      const who = [esc(from.first_name || "Someone"), from.username ? `@${esc(from.username)}` : "", from.language_code ? `(${esc(from.language_code)})` : ""].filter(Boolean).join(" ");
      await c.tg.send(owner, `👋 <b>New user:</b> ${who}\nTotal users: ${total}`);
    })().catch((e) => console.error("owner new-user ping failed", e)),
  );
}

async function cmdAdmin(c: Ctx, id: number) {
  if (String(id) !== c.env.OWNER_TG_ID) return void (await c.tg.send(id, "Unknown command. /help lists everything I can do."));
  const d1 = c.env.DB;
  const weekAgo = now() - 7 * 86_400_000;
  const [status, d7, topics, ratings, onb] = await d1.batch([
    d1.prepare("SELECT status, COUNT(*) AS n FROM users GROUP BY status"),
    // D7 retention: users created 7–14 days ago who are still active (not paused/blocked)
    d1.prepare("SELECT COUNT(*) AS total, SUM(status = 'active') AS kept FROM users WHERE created_at BETWEEN ? AND ?").bind(now() - 14 * 86_400_000, weekAgo),
    d1.prepare("SELECT topic, COUNT(*) AS n, ROUND(AVG(weight),1) AS w FROM user_topics WHERE weight > 0 GROUP BY topic ORDER BY n DESC"),
    d1.prepare("SELECT SUM(rating = 1) AS up, SUM(rating = -1) AS down FROM deliveries WHERE sent_at > ?").bind(weekAgo),
    d1.prepare("SELECT COUNT(*) AS total, SUM(status != 'onboarding') AS done FROM users WHERE created_at > ?").bind(now() - 30 * 86_400_000),
  ]);
  const s = Object.fromEntries((status.results as any[]).map((r) => [r.status, r.n]));
  const d7r: any = d7.results[0] ?? {};
  const rr: any = ratings.results[0] ?? {};
  const ob: any = onb.results[0] ?? {};
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  await c.tg.send(id, [
    "📊 <b>Admin stats</b>",
    `Users: ${Object.values(s).reduce((a: number, b: any) => a + b, 0)} (active ${s.active ?? 0}, paused ${s.paused ?? 0}, onboarding ${s.onboarding ?? 0}, blocked ${s.blocked ?? 0})`,
    `Onboarding completion (30d): ${pct(ob.done ?? 0, ob.total ?? 0)}`,
    `D7 retention: ${pct(d7r.kept ?? 0, d7r.total ?? 0)} of ${d7r.total ?? 0}`,
    `👍 share (7d): ${pct(rr.up ?? 0, (rr.up ?? 0) + (rr.down ?? 0))} (${rr.up ?? 0}👍 / ${rr.down ?? 0}👎)`,
    "",
    "<b>Top topics</b>",
    ...(topics.results as any[]).map((t) => `${esc(topicLabel(t.topic))}: ${t.n} users (avg w ${t.w})`),
  ].join("\n"));
}

// ───────────────────────── buttons ─────────────────────────

async function onCallback(c: Ctx, q: any) {
  const id: number = q.from.id;
  const chatId: number = q.message?.chat?.id ?? id;
  const msgId: number | undefined = q.message?.message_id;
  const data: string = q.data ?? "";
  const [a, b, x] = data.split(":");
  const u = await c.db.ensureUser(id, q.from.first_name, q.from.language_code);
  if (u.isNew) notifyOwnerNewUser(c, q.from);
  const edit = (r: Rendered) => (msgId ? c.tg.edit(chatId, msgId, r) : c.tg.send(chatId, r));

  // ── onboarding / topics / settings screens
  if (a === "ob" || a === "tp" || a === "st") {
    await c.tg.answer(q.id);
    const prefix = a as "ob" | "tp" | "st";
    switch (b) {
      case "go":
        return void (await edit(roleScreen("ob")));
      case "role": {
        if (!Object.hasOwn(ROLES, x)) return;
        const role = x as RoleId;
        if (prefix === "ob") {
          await c.db.updateUser(id, { role, depth: ROLES[role].depth });
          const w = await c.db.getWeights(id);
          if (!Object.values(w).some((v) => v > 0)) await c.db.resetTopics(id, ROLE_TOPICS[role]);
          return void (await edit(topicsScreen("ob", await c.db.getWeights(id))));
        }
        await c.db.updateUser(id, { role });
        return void (await edit(settingsScreen((await c.db.getUser(id))!)));
      }
      case "roles":
        return void (await edit(roleScreen("st")));
      case "t": {
        if (!TOPIC_IDS.includes(x as any)) return;
        const w = await c.db.getWeights(id);
        await c.db.setWeight(id, x, (w[x] ?? 0) > 0 ? 0 : 10);
        return void (await edit(topicsScreen(prefix, await c.db.getWeights(id))));
      }
      case "td": {
        const w = await c.db.getWeights(id);
        if (!Object.values(w).some((v) => v > 0)) return void (await c.tg.answer(q.id, "Pick at least one topic 🙂", true));
        if (prefix === "ob") return void (await edit(depthScreen()));
        if (prefix === "st") return void (await edit(settingsScreen(u)));
        const chosen = TOPICS.filter((t) => (w[t.id] ?? 0) > 0).map((t) => t.label);
        return void (await edit({ text: `✅ Topics saved: ${esc(chosen.join(", "))}` }));
      }
      case "menu": // ⚙️ Topics on a digest → open a fresh topics message
        return void (await c.tg.send(chatId, topicsScreen("tp", await c.db.getWeights(id))));
      case "depth":
        if (prefix === "ob") {
          await c.db.updateUser(id, { depth: x === "quick" ? "quick" : "detailed" });
          return void (await edit(slotsScreen("ob", u.slots)));
        }
        await c.db.updateUser(id, { depth: u.depth === "quick" ? "detailed" : "quick" });
        return void (await edit(settingsScreen((await c.db.getUser(id))!)));
      case "s": {
        const n = Number(x);
        if (!SLOTS.some((s) => s.id === n)) return;
        const bit = 1 << n;
        const slots = u.slots ^ bit;
        await c.db.updateUser(id, { slots });
        return void (await edit(slotsScreen(prefix === "ob" ? "ob" : "st", slots)));
      }
      case "sd":
        if (!u.slots) return void (await c.tg.answer(q.id, "Keep at least one slot on — or use /pause to stop digests.", true));
        if (prefix === "st") return void (await edit(settingsScreen(u)));
        return finishOnboarding(c, u, chatId, msgId);
      case "slots":
        return void (await edit(slotsScreen("st", u.slots)));
      case "topics":
        return void (await edit(topicsScreen("st", await c.db.getWeights(id))));
      case "lang":
        return void (await c.tg.answer(q.id, "More languages (Hindi first) are coming soon!", true));
      case "pause": {
        const status = u.status === "paused" ? "active" : "paused";
        await c.db.updateUser(id, { status });
        return void (await edit(settingsScreen({ ...u, status })));
      }
      case "back":
        return void (await edit(settingsScreen(u)));
    }
    return;
  }

  switch (a) {
    case "star": // "Maybe later" on a star prompt: just drop the buttons
      await c.tg.answer(q.id, "No worries 🙂");
      if (msgId) await c.tg.editMarkup(chatId, msgId, kb([]));
      return;

    case "d": { // detail card
      const item = await c.db.getItem(Number(b));
      if (!item) return void (await c.tg.answer(q.id, "That item has expired.", true));
      await c.tg.answer(q.id);
      await c.tg.send(chatId, renderDetail(item, { saved: await c.db.isSaved(id, item.item_id) }));
      await Promise.all([c.db.logEvent(id, "open", item.item_id), c.db.adjustWeights(id, { [item.topic]: SIGNAL_DELTA.open })]);
      return;
    }

    case "sv": {
      const item = await c.db.getItem(Number(b));
      if (!item) return void (await c.tg.answer(q.id, "That item has expired.", true));
      const saved = await c.db.toggleSave(id, item.item_id);
      await c.tg.answer(q.id, saved ? "🔖 Saved — see /saved" : "Removed from saved");
      if (msgId) await c.tg.editMarkup(chatId, msgId, renderDetail(item, { saved }).reply_markup);
      if (saved) await Promise.all([c.db.logEvent(id, "save", item.item_id), c.db.adjustWeights(id, { [item.topic]: SIGNAL_DELTA.save })]);
      return;
    }

    case "m":
    case "l": {
      const item = await c.db.getItem(Number(b));
      if (!item) return void (await c.tg.answer(q.id, "That item has expired.", true));
      const more = a === "m";
      await c.db.adjustWeights(id, { [item.topic]: more ? SIGNAL_DELTA.more : SIGNAL_DELTA.less });
      await c.db.logEvent(id, more ? "more" : "less", item.item_id);
      return void (await c.tg.answer(q.id, `Got it, ${more ? "more" : "less"} ${topicLabel(item.topic)} 👌`));
    }

    case "x": { // explain simply — pre-written by the digest job, no AI call per tap
      const item = await c.db.getItem(Number(b));
      if (!item) return void (await c.tg.answer(q.id, "That item has expired.", true));
      await c.tg.answer(q.id);
      return void (await c.tg.send(chatId, `🧒 <b>In simple words</b>\n\n${esc(item.simple_words || item.summary_long || item.summary_short)}`, { reply_parameters: msgId ? { message_id: msgId } : undefined }));
    }

    case "du":
    case "dd": {
      const slotDate = b;
      const slot = Number(x);
      const up = a === "du";
      const delivery = await c.db.getDelivery(id, slotDate, slot);
      if (!delivery) return void (await c.tg.answer(q.id, "Thanks!"));
      if (!(await c.db.rateDelivery(id, slotDate, slot, up ? 1 : -1))) return void (await c.tg.answer(q.id, "You already rated this one 🙏"));
      const items = await c.db.getItems(JSON.parse(delivery.item_ids_json));
      const deltas: Record<string, number> = {};
      for (const it of items) deltas[it.topic] = up ? SIGNAL_DELTA.digest_up : SIGNAL_DELTA.digest_down;
      await Promise.all([c.db.adjustWeights(id, deltas), c.db.logEvent(id, up ? "digest_up" : "digest_down")]);
      await c.tg.answer(q.id, up ? "Thanks! Glad it helped 🙌" : "Thanks — I'll tune your briefing. Tap ➖ on items you don't want.");
      if (up) await maybeStarPrompt(c, u);
      return;
    }

    case "del":
      await c.tg.answer(q.id);
      if (b === "yes") {
        await c.db.deleteUser(id);
        return void (await edit({ text: "🗑 Done — all your data is erased. Send /start if you ever want to come back. 👋" }));
      }
      return void (await edit({ text: "Cancelled — nothing was deleted." }));

    case "wk":
      if (b === "keep") {
        await c.tg.answer(q.id, "👌 Keeping your mix");
        if (msgId) await c.tg.editMarkup(chatId, msgId, kb([]));
        return;
      }
      await c.tg.answer(q.id);
      return void (await c.tg.send(chatId, topicsScreen("tp", await c.db.getWeights(id))));
  }
  await c.tg.answer(q.id);
}

async function finishOnboarding(c: Ctx, u: UserRow, chatId: number, msgId?: number) {
  const wasNew = u.status === "onboarding";
  await c.db.updateUser(u.tg_user_id, { status: u.status === "paused" ? "paused" : "active", star_prompted_at: wasNew ? now() : u.star_prompted_at });
  // The star ask is shown at first setup only; re-running /start just confirms.
  const r = wasNew ? doneScreen(c.env) : { text: "✅ Settings saved! Here's the latest briefing 👇" };
  if (msgId) await c.tg.edit(chatId, msgId, r);
  else await c.tg.send(chatId, r);
  const fresh = (await c.db.getUser(u.tg_user_id))!;
  const sent = await sendLatest(c, fresh);
  if (!sent) await c.tg.send(chatId, `Your first briefing arrives with the ${nextSlotText(fresh.slots)}. Meanwhile, /help shows what I can do.`);
}

/** At most monthly, and only for users who rated 5+ digests 👍. Never checks whether anyone starred. */
async function maybeStarPrompt(c: Ctx, u: UserRow) {
  if (u.star_prompted_at && now() - u.star_prompted_at < MONTH_MS) return;
  if ((await c.db.countDigestUps(u.tg_user_id)) < 5) return;
  await c.db.updateUser(u.tg_user_id, { star_prompted_at: now() });
  await c.tg.send(u.tg_user_id, {
    text: `🙌 Glad ${BOT_NAME} is useful! It's free and open source — a GitHub star helps other students find it. No pressure!`,
    reply_markup: kb([[starButton(c.env), cb("Maybe later", "star:later")]]),
  });
}

export { TelegramError };
