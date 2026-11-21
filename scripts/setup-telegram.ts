/**
 * One-time Telegram setup (re-run any time): webhook → deployed Worker, command menu,
 * description and about text (PRD launch checklist).
 *
 *   WORKER_URL=https://nodeneuron-bot.<you>.workers.dev npm run setup:telegram
 */
import { BOT_NAME, TAGLINE } from "../src/shared/config";
import { loadDotEnv } from "../src/job/util";

loadDotEnv();
const { TELEGRAM_BOT_TOKEN: token, WORKER_URL: workerUrl, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
if (!token || !secret) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required");

async function api(method: string, params: object) {
  const r: any = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) }).then((r) => r.json());
  console.log(`${r.ok ? "✅" : "❌"} ${method}${r.ok ? "" : `: ${r.description}`}`);
}

const commands = [
  ["today", "Re-send today's latest digest"],
  ["topics", "Choose your topics"],
  ["settings", "Depth, slots, role"],
  ["saved", "Your saved items"],
  ["feedback", "Report a problem or suggest an idea"],
  ["pause", "Pause digests"],
  ["resume", "Resume digests"],
  ["help", "Guide, privacy and GitHub link"],
  ["deleteme", "Erase all my data"],
  ["start", "Run setup again"],
].map(([command, description]) => ({ command, description }));

if (workerUrl && !workerUrl.includes("127.0.0.1") && !workerUrl.includes("localhost")) {
  await api("setWebhook", {
    url: `${workerUrl.replace(/\/$/, "")}/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: true,
  });
} else {
  console.log("ℹ️  WORKER_URL is local/unset — skipping setWebhook (use `npm run poll` for local dev)");
}
await api("setMyCommands", { commands });
await api("setMyName", { name: BOT_NAME });
await api("setMyShortDescription", { short_description: TAGLINE });
await api("setMyDescription", {
  description: `${TAGLINE}\n\n4 short briefings a day for students and researchers:\n🔬 7 AM Research · 🪙 12 PM Crypto · 🤖 5 PM AI Launches · 🌙 10 PM Daily Wrap (IST)\n\nEvery item links to its sources. Free and open source. Not financial advice.`,
});
