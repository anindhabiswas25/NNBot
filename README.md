# NodeNeuron 🧠⛓️ — [@NodeNeuronBot](https://t.me/NodeNeuronBot)

[![digest](https://github.com/anindhabiswas25/NNBot/actions/workflows/digest.yml/badge.svg)](https://github.com/anindhabiswas25/NNBot/actions/workflows/digest.yml)

**AI + crypto research, distilled 4× a day.** A free Telegram bot that sends students and researchers
short, source-linked briefings on AI and crypto papers, launches and news, personalised to their topics.
It runs entirely on free tiers.

| Slot (IST) | Briefing | Sources |
| --- | --- | --- |
| 7:00 AM | 🔬 Research Brief | arXiv, HF Daily Papers, Semantic Scholar, Hacker News |
| 12:00 PM | 🪙 Crypto Brief | 10 outlet RSS feeds, CryptoPanic, DefiLlama, CoinGecko, Hacker News |
| 5:00 PM | 🤖 AI Launches | 12 lab/AI blogs, HF Hub, GitHub releases & trending, Hacker News |
| 10:00 PM | 🌙 Daily Wrap | Top 3 stories of the day, how they connect, Concept of the day |

⭐ If NodeNeuron is useful to you, a star helps other students find it.

## Architecture

```
 Cloudflare cron (slot − 20 min) ──repository_dispatch──▶ GitHub Actions job (src/job)
                                                          gather → normalise → dedupe → cluster →
                                                          signals/junk filter → AI tag → AI judge →
                                                          enrich → AI write → validate → store → send
                                                                │  /internal/* (shared key)
 Telegram ──webhook──▶ Cloudflare Worker (src/worker) ◀────────┘
                        onboarding, commands, buttons, detail cards, feedback, /ask
                                   │
                              Cloudflare D1 (migrations/)
```

- `src/shared` — config (topics, slots, roles), ranking (`user_score = AI_score × (1 + weight/10)`), Telegram HTML rendering, AI client (Gemini → retry → Groq → code-only fallback)
- `src/worker` — webhook bot + authenticated internal API for the job
- `src/job` — the digest pipeline; one module per source in `src/job/connectors`, feed lists in `src/job/sources.ts`
- `migrations` — D1 schema

## Local development

```bash
npm install
npm run db:migrate:local          # create local D1 tables
cp .env.example .env              # fill in TELEGRAM_BOT_TOKEN etc. (see below)
# .dev.vars holds the Worker's secrets locally (same names as the Worker secrets)

npm run dev                        # Worker on http://127.0.0.1:8787
npm run poll                       # bridge: real Telegram updates → local Worker (removes the webhook while running)

npm run job -- research --no-wait  # build + store + send the Research Brief now
npm run job -- crypto --dry-run    # build a pool and print the digest, no DB, nothing sent
npm test                           # unit tests
```

The bot works without any AI key: digests fall back to source headlines plus a note. Add
`GEMINI_API_KEY` (free at aistudio.google.com) and optionally `GROQ_API_KEY` for AI summaries, judging,
clustering embeddings, "Explain simply" and `/ask`.

## Deploy (all free tiers)

1. **Cloudflare**
   ```bash
   npx wrangler login
   npx wrangler d1 create nodeneuron          # paste database_id into wrangler.toml
   npm run db:migrate                          # remote tables
   # set GITHUB_REPO_URL / GITHUB_DISPATCH_REPO in wrangler.toml, then:
   for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET INTERNAL_API_KEY OWNER_TG_ID GITHUB_DISPATCH_TOKEN GEMINI_API_KEY GROQ_API_KEY; do npx wrangler secret put $s; done
   npm run deploy
   ```
   `GITHUB_DISPATCH_TOKEN` is a fine-grained PAT with **Contents: read & write** on this repo only (needed for `repository_dispatch`).
2. **Telegram:** `WORKER_URL=https://nodeneuron-bot.<you>.workers.dev npm run setup:telegram` sets the webhook (with secret header), command menu, name and descriptions.
3. **GitHub:** push this repo as **public** (Actions are free on public repos) and add these repository secrets:
   `TELEGRAM_BOT_TOKEN, WORKER_URL, INTERNAL_API_KEY, OWNER_TG_ID, GEMINI_API_KEY, GROQ_API_KEY` plus optional
   `SEMANTIC_SCHOLAR_API_KEY, CRYPTOPANIC_TOKEN, COINGECKO_API_KEY`.
4. Run **Actions → digest → Run workflow** with each job once to check, then let the crons take over.

Your Telegram user ID (for `OWNER_TG_ID`, which unlocks `/admin` and alerts) is shown by bots like @userinfobot.

## Commands

`/start` setup · `/today` latest digest · `/topics` · `/settings` · `/saved` · `/ask <question>` · `/feedback <text>` · `/pause` · `/resume` · `/help` · `/deleteme` · `/admin` (owner)

## Privacy & content rules

Stores only Telegram user ID, first name, language, preferences and taps. `/deleteme` erases everything immediately.
Every item links to its source; the AI writes only from supplied text and numbers are checked against API data.
No trading advice, price predictions or token promotions. Headlines and short summaries only.
