import { handleUpdate, type Env } from "./bot";
import { handleInternal } from "./internal";

/**
 * Cron (UTC) → job. Each digest run starts at slot time − 20 min (IST = UTC+5:30).
 * Keep in sync with wrangler.toml [triggers].
 */
const CRON_JOBS: Record<string, string> = {
  "10 1 * * *": "research",  // 07:00 IST
  "10 6 * * *": "crypto",    // 12:00 IST
  "10 11 * * *": "launches", // 17:00 IST
  "10 16 * * *": "wrap",     // 22:00 IST
  "30 5 * * *": "daily",     // 11:00 IST — reminders, Sunday check-in, housekeeping
};

async function dispatch(env: Env, job: string): Promise<void> {
  if (!env.GITHUB_DISPATCH_REPO || !env.GITHUB_DISPATCH_TOKEN) {
    console.warn(`cron ${job}: GITHUB_DISPATCH_REPO/TOKEN not set, skipping`);
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_DISPATCH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "nodeneuron-bot",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: "digest", client_payload: { job } }),
  });
  if (!res.ok) throw new Error(`repository_dispatch ${job} failed: ${res.status} ${await res.text()}`);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update = await req.json();
      // Ack Telegram immediately; slow work (AI answers) continues in the background.
      ctx.waitUntil(handleUpdate(update, env, ctx));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/internal/")) return handleInternal(req, env, url);

    if (url.pathname === "/" || url.pathname === "/health") return new Response("NodeNeuron bot is running ✅");
    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = CRON_JOBS[event.cron];
    if (!job) return console.warn(`unknown cron ${event.cron}`);
    ctx.waitUntil(dispatch(env, job));
  },
} satisfies ExportedHandler<Env>;
