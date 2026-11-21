/**
 * Local development bridge: long-polls Telegram and forwards each update to the local Worker
 * (`npm run dev`) exactly as the webhook would. Removes any webhook while running —
 * run `npm run setup:telegram` afterwards to point Telegram back at the deployed Worker.
 */
import { loadDotEnv, log, sleep } from "../src/job/util";

loadDotEnv();
const token = process.env.TELEGRAM_BOT_TOKEN!;
const target = `${process.env.LOCAL_WORKER_URL ?? "http://127.0.0.1:8787"}/webhook`;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET!;
const api = (m: string, p: object = {}) =>
  fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then((r) => r.json() as any);

await api("deleteWebhook", { drop_pending_updates: false });
log(`polling @NodeNeuronBot → ${target} (Ctrl+C to stop)`);
let offset = 0;
for (;;) {
  try {
    const r = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query", "my_chat_member"] });
    for (const u of r.result ?? []) {
      offset = u.update_id + 1;
      const kind = u.message ? `message "${u.message.text ?? ""}"` : u.callback_query ? `button ${u.callback_query.data}` : Object.keys(u)[1];
      log(`→ ${kind}`);
      const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) });
      if (!res.ok) log(`  worker replied ${res.status}`);
    }
  } catch (e) {
    log(`poll error: ${(e as Error).message}`);
    await sleep(3000);
  }
}
