<p align="center">
  <img src="assets/logo.jpg" alt="NodeNeuron logo" width="160">
</p>

<h1 align="center">NodeNeuron</h1>

<p align="center">
  <b>AI + crypto research, distilled 4× a day.</b><br>
  A free Telegram bot: <a href="https://t.me/NodeNeuronBot">@NodeNeuronBot</a>
</p>

<p align="center">
  <a href="https://github.com/anindhabiswas25/NNBot/actions/workflows/digest.yml"><img src="https://github.com/anindhabiswas25/NNBot/actions/workflows/digest.yml/badge.svg" alt="digest"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/runs%20on-free%20tiers-brightgreen" alt="Free tiers">
  <img src="https://img.shields.io/badge/TypeScript-5-3178c6" alt="TypeScript">
</p>

---

NodeNeuron sends students, researchers and builders short, source-linked briefings on **AI and
crypto**: new papers, model and tool launches, protocol news and on-chain data. Each briefing is
ranked for the reader's own topics and role. The whole system runs on free tiers: a Cloudflare
Worker, Cloudflare D1 and GitHub Actions. AI costs are capped by a monthly budget.

⭐ If NodeNeuron is useful to you, a star helps other students find it.

## Contents

- [What you get](#what-you-get)
- [Features](#features)
- [How it works](#how-it-works)
- [The digest pipeline](#the-digest-pipeline)
- [Ranking and personalisation](#ranking-and-personalisation)
- [Sources](#sources)
- [Project layout](#project-layout)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Deploy (all free tiers)](#deploy-all-free-tiers)
- [Commands](#commands)
- [Data model](#data-model)
- [Privacy & content rules](#privacy--content-rules)
- [Contributing](#contributing)
- [License](#license)

## What you get

| Slot (IST) | Briefing | Sources |
| --- | --- | --- |
| 7:00 AM | 🔬 **Research Brief** | arXiv, Hugging Face Daily Papers, Semantic Scholar, research blogs, Hacker News |
| 12:00 PM | 🪙 **Crypto Brief** | 13 outlet RSS feeds, DefiLlama, CoinGecko, Hacker News |
| 5:00 PM | 🤖 **AI Launches** | 12 lab/AI blogs, Hugging Face Hub, GitHub releases & trending, Hacker News |
| 10:00 PM | 🌙 **Daily Wrap** | The day's top 3 stories, how they connect, and a *Concept of the day* |

Each briefing is a numbered list of 5 items (*quick*) or 7 items (*detailed*). Tapping a number opens a
**detail card** with a longer summary, *why it matters*, source links and buttons:

- 🧒 **Explain simply**: a plain-language version, written ahead of time by the digest job
- 🔖 **Save**: keep it for later with `/saved`
- ➕ **More like this** / ➖ **Less like this**: tune your topic weights
- 👍 / 👎 on the whole briefing

## Features

- **Personalised ranking.** 10 topics (LLMs, AI Agents, AI Safety, Robotics, Computer Vision, Bitcoin,
  Ethereum / L2, DeFi, Regulation, AI × Crypto) with weights that learn from your taps.
- **Roles.** 🎓 Student, 🔬 Researcher, 💻 Developer and 📈 Trader each get a different default depth
  and a small boost for papers, launches, news or market data.
- **Choose your slots.** Turn any of the four daily briefings on or off.
- **A daily wildcard.** One high-scoring story from outside your topics, so you see more than what you
  already follow.
- **Source variety.** No single website can fill a briefing. Topics are capped too.
- **Facts are checked.** The AI writes only from the supplied source text. Numbers in the summary are
  checked against API data, and summaries that give advice are dropped.
- **Junk filter.** Press releases, sponsored posts, price predictions, "top coins to buy" lists and
  de-safetied model uploads are removed before ranking.
- **Works without AI.** If no AI provider is available, the briefing is still sent using source
  headlines and a short note.
- **Reliable delivery.** A Cloudflare cron starts each run 20 minutes before its slot, and a GitHub
  schedule runs 5 minutes after it as a backup. Runs are idempotent, so the backup sends only what is
  still missing.
- **Owner tools.** `/admin` stats (users, onboarding completion, D7 retention, 👍 share, top topics),
  Telegram alerts for failing sources or crashed jobs, and a weekly summary of sorted user feedback.
- **Engagement.** A single onboarding reminder 24 h after an unfinished `/start`, and a Sunday
  check-in ("This week you opened mostly LLMs and DeFi. Keep this mix?").

## How it works

```
 Cloudflare cron (slot − 20 min) ──repository_dispatch──▶ GitHub Actions job (src/job)
                                                          gather → normalise → dedupe → cluster →
                                                          signals/junk filter → AI tag → AI judge →
                                                          enrich → AI write → validate → store → send
                                                                │  /internal/* (shared key)
 Telegram ──webhook──▶ Cloudflare Worker (src/worker) ◀────────┘
                        onboarding, commands, buttons, detail cards, feedback
                                   │
                              Cloudflare D1 (migrations/)
```

There are two parts:

1. **The Worker** (`src/worker`) is the bot. It receives Telegram webhooks (checked with a secret
   header), handles onboarding, commands and buttons, and serves an authenticated `/internal/*` API
   that the job uses to read and write D1. **The Worker makes no AI calls.** Every button response is
   served from data that was written ahead of time.
2. **The job** (`src/job`) runs on GitHub Actions. For each slot it builds a shared pool of 25 stories,
   stores it through the Worker, waits until send time, then ranks the pool for each user and
   delivers it, respecting Telegram rate limits.

### Schedule

| Cloudflare cron (UTC) | Job | Purpose |
| --- | --- | --- |
| `10 1 * * *` | `research` | Build and send the 7 AM IST Research Brief |
| `10 6 * * *` | `crypto` | Build and send the 12 PM IST Crypto Brief |
| `10 11 * * *` | `launches` | Build and send the 5 PM IST AI Launches |
| `10 16 * * *` | `wrap` | Build and send the 10 PM IST Daily Wrap |
| `30 5 * * *` | `daily` | Onboarding reminders, the Sunday check-in, feedback sorting and housekeeping |

The Cloudflare free plan allows 5 cron triggers. The crons in `wrangler.toml` must stay in sync with
`CRON_JOBS` in `src/worker/index.ts`. The GitHub backup crons are in `.github/workflows/digest.yml`.

## The digest pipeline

`src/job/run.ts` runs these steps for each content slot:

1. **Gather.** All connectors for the slot run in parallel. Each source keeps a cursor and reads
   between the last 20 and 72 hours. If a source returns nothing for 5 runs in a row, the owner gets
   an alert.
2. **Normalise and dedupe.** URLs are made canonical (tracking parameters and arXiv versions are
   removed). Duplicate URLs merge, syndicated titles collapse into one, and anything sent in the last
   7 days is dropped.
3. **Junk filter.** Blocked domains and junk patterns from `src/job/sources.ts` are removed.
4. **Pre-cut.** arXiv publishes hundreds of papers a day, so only papers that match our topics are
   kept. At most 350 items go on to the next step.
5. **Cluster.** Stories about the same event are grouped, using Gemini embeddings when available.
6. **Signal score (0–10, code only).** Based on corroboration across sources, source trust tier,
   HN points, HF upvotes, citations, stars and likes, TVL and price moves, a code link for papers,
   and recency.
7. **Describe thin items.** For title-only link posts (mostly HN), the job fetches the linked page's
   description. The fetch is hardened: public http(s) addresses only (checked on every redirect and
   on the connected socket), a 500 KB read cap and an 8 s deadline.
8. **AI tag + judge.** The top 60 candidates get a topic and a 0–10 judgement in one batched call.
   `ai_score = 0.6 × judge + 0.4 × signal`.
9. **Pool selection.** The top 25 are chosen, with at most 8 per topic, at most 18 per website and at
   most 4 market-data items.
10. **Enrich.** Numbers are added from APIs (DefiLlama, CoinGecko, Semantic Scholar…).
11. **AI write + validate.** The AI writes the short and long summaries, *why it matters* and the
    *simple words* version. The validator rejects invented numbers and advice. A rejected item
    falls back to a plain summary rather than leaving the briefing short.
12. **Store, wait, send.** The pool is stored once per slot, which makes re-runs resume delivery only.
    The job then waits for the slot time and delivers to each user.

The **Daily Wrap** reuses the day's stored items. The AI picks the top 3 stories, writes how they
connect, and writes a *Concept of the day*. Without AI, it uses the top 3 by score (one per topic)
and a concept from a built-in rotation.

### AI providers and budget

| Order | Provider | Notes |
| --- | --- | --- |
| 1 | **Claude Haiku 5.5** (`ANTHROPIC_API_KEY`) | Primary. Structured JSON outputs, thinking off, usage logged per run and tracked per month. Skipped once `CLAUDE_MONTHLY_BUDGET_USD` (default **$1**) is spent. |
| 2 | **Gemini** (`GEMINI_API_KEY`, free) | Fallback. Also provides the clustering embeddings. |
| 3 | **Groq** (`GROQ_API_KEY`, free) | Second fallback. |
| 4 | Code only | Keyword topics, signal scores and source headlines. |

The writer prompt tells the model to ignore any instructions that appear inside story text.

## Ranking and personalisation

```
user_score = ai_score × (1 + topic_weight / 10) × role_boost(item type)
```

- Topic weights range from 0 to 20 (a chosen topic starts at 10). Taps change them:
  open +1, save +2, more like this +3, less like this −3, briefing 👍 +1, 👎 −1.
- Role boosts: Researcher ×1.25 on papers, Developer ×1.25 on launches, Trader ×1.15 on news and
  ×1.25 on market data.
- Each user gets 5 items (*quick*) or 7 (*detailed*), with at most **3 per topic** and at most
  **(limit − 2) from any one website**. If the pool is too narrow for these caps, the briefing is
  filled with the next best items rather than sent short.
- The **wildcard** goes into the user's first enabled content slot each day. It is the highest-scoring
  item from a topic the user hasn't chosen.

## Sources

All feed lists are in [`src/job/sources.ts`](src/job/sources.ts). You can add or remove entries
freely. Each feed has a trust tier (1–3) that feeds into the signal score.

- **Research:** arXiv (`cs.AI, cs.LG, cs.CL, cs.CR, cs.MA, cs.CV, cs.RO, q-fin.TR, q-fin.CP`),
  Hugging Face Daily Papers, Semantic Scholar, Google Research, Apple ML Research, CMU ML Blog,
  MIT News AI, Sebastian Raschka, Lil'Log, a16z crypto, Vitalik Buterin, Flashbots, Ethresear.ch
- **Crypto:** CoinDesk, Cointelegraph, Decrypt, The Block, Bitcoin Magazine, The Defiant, Blockworks,
  CryptoSlate, Crypto Briefing, Ethereum Foundation, Unchained, Protos, Rekt News, plus DefiLlama
  (new protocols ≥ $2M TVL, movers ≥ $50M TVL and ±25% over 7 days) and CoinGecko (top-100 coins that
  moved more than 12% in 24 h)
- **AI launches:** OpenAI, Google DeepMind, Google AI, Mistral AI, Hugging Face, Microsoft Research,
  NVIDIA, AWS ML, BAIR, TechCrunch AI, The Verge AI, Simon Willison, the Hugging Face Hub, GitHub
  trending, and releases from vLLM, Transformers, Ollama, llama.cpp, PyTorch, LangChain, LlamaIndex,
  AutoGen, OpenAI Agents SDK, Anthropic SDK, MCP SDK, SGLang, Unsloth and Diffusers
- **Everywhere:** Hacker News

## Project layout

```
src/
  shared/      config (topics, slots, roles), ranking, Telegram HTML rendering, AI client + budget
  worker/      Cloudflare Worker: webhook bot (bot.ts), internal API (internal.ts), D1 access, Telegram client
  job/
    run.ts       entry point for every job (research | crypto | launches | wrap | daily)
    sources.ts   feeds, repos, arXiv categories, blocklists, thresholds
    connectors/  one module per source: arxiv, huggingface, github, hackernews, rss, crypto
    pipeline/    clean, cluster, signals, describe, ai, enrich, validate
    send.ts      rate-limited per-user delivery
migrations/    D1 schema
scripts/       poll.ts (local Telegram bridge), setup-telegram.ts (webhook, menu, descriptions)
test/          unit tests (node:test via tsx)
.github/workflows/digest.yml   the job runner and backup schedule
```

## Local development

Requirements: **Node 22+** and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
npm run db:migrate:local          # create local D1 tables
cp .env.example .env              # fill in TELEGRAM_BOT_TOKEN etc. (see Configuration)
# .dev.vars holds the Worker's secrets locally (same names as the Worker secrets)

npm run dev                        # Worker on http://127.0.0.1:8787
npm run poll                       # bridge: real Telegram updates → local Worker (removes the webhook while running)

npm run job -- research --no-wait  # build + store + send the Research Brief now
npm run job -- crypto --dry-run    # build a pool and print the digest, no DB, nothing sent
npm run typecheck
npm test                           # unit tests
```

Job flags (`npm run job -- <research|crypto|launches|wrap|daily> [flags]`):

| Flag | Effect |
| --- | --- |
| `--dry-run` | Build the pool without the Worker or DB. Prints the pool, the rendered digest and the detail text. Nothing is stored or sent. |
| `--preview-to <tg_id>` | With `--dry-run`, also send the rendered digest to this chat. |
| `--only <tg_id>` | Deliver only to this user (for testing against a real DB). |
| `--no-wait` | Send immediately instead of waiting for the slot time. |
| `--cron "<expr>"` | Map a GitHub backup cron expression to its job (used by the workflow). |

The bot works without any AI key. In that case digests use source headlines plus a note.

## Configuration

### Job (`.env` locally, GitHub Actions secrets in CI)

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
| `WORKER_URL` | ✅ | Base URL of the Worker (`http://127.0.0.1:8787` locally) |
| `INTERNAL_API_KEY` | ✅ | Shared secret for `/internal/*`. Must match the Worker's value. |
| `OWNER_TG_ID` | recommended | Your Telegram user ID. Unlocks `/admin` and alerts. |
| `ANTHROPIC_API_KEY` | recommended | Claude for ranking, summaries and the Daily Wrap |
| `CLAUDE_MODEL` | – | Default `claude-haiku-5-5` |
| `CLAUDE_MONTHLY_BUDGET_USD` | – | Default `1` |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | – | Free fallbacks. Gemini also enables clustering embeddings. |
| `SEMANTIC_SCHOLAR_API_KEY`, `COINGECKO_API_KEY`, `CRYPTOPANIC_TOKEN` | – | Higher rate limits / extra data |
| `GITHUB_TOKEN` | – | GitHub API rate limits (provided automatically in Actions) |
| `TELEGRAM_WEBHOOK_SECRET` | setup only | Used by `npm run setup:telegram` |

### Worker (`wrangler secret put`, or `.dev.vars` locally)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_API_KEY`, `OWNER_TG_ID`,
`GITHUB_DISPATCH_TOKEN`. The plain vars `GITHUB_REPO_URL` and `GITHUB_DISPATCH_REPO` are in
`wrangler.toml`.

## Deploy (all free tiers)

1. **Cloudflare**
   ```bash
   npx wrangler login
   npx wrangler d1 create nodeneuron          # paste database_id into wrangler.toml
   npm run db:migrate                          # remote tables
   # set GITHUB_REPO_URL / GITHUB_DISPATCH_REPO in wrangler.toml, then:
   for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET INTERNAL_API_KEY OWNER_TG_ID GITHUB_DISPATCH_TOKEN; do npx wrangler secret put $s; done
   npm run deploy
   ```
   `GITHUB_DISPATCH_TOKEN` is a fine-grained PAT with **Contents: read & write** on this repo only.
   It is needed for `repository_dispatch`.
2. **Telegram:** `WORKER_URL=https://nodeneuron-bot.<you>.workers.dev npm run setup:telegram` sets the
   webhook (with the secret header), the command menu, the name and the descriptions.
3. **GitHub:** push this repo as **public** (Actions are free on public repos) and add these repository secrets:
   `TELEGRAM_BOT_TOKEN, WORKER_URL, INTERNAL_API_KEY, OWNER_TG_ID, ANTHROPIC_API_KEY` (optionally
   `GEMINI_API_KEY`, `GROQ_API_KEY` as free fallbacks) plus optional
   `SEMANTIC_SCHOLAR_API_KEY, COINGECKO_API_KEY`.
4. Run **Actions → digest → Run workflow** once with each job to check it works, then let the crons
   take over. A manual run also runs the typecheck and the tests.

To find your Telegram user ID (for `OWNER_TG_ID`), message a bot like @userinfobot.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Setup: role, topics, depth and slots (run it again any time) |
| `/today` | Re-send today's latest briefing |
| `/topics` | Choose and weight your topics |
| `/settings` | Depth, slots, role, language, pause |
| `/saved` | Your saved items |
| `/feedback <text>` | Report a problem or suggest an idea |
| `/pause` / `/resume` | Stop or restart briefings (settings are kept) |
| `/help` | Guide, privacy and GitHub link |
| `/deleteme` | Permanently erase all your data |
| `/admin` | Owner-only stats |

## Data model

The schema is in [`migrations/0001_init.sql`](migrations/0001_init.sql) (Cloudflare D1 / SQLite):

| Table | Holds |
| --- | --- |
| `users` | Telegram ID, first name, role, depth, slot bitmask, language, status |
| `user_topics` | Per-user topic weights |
| `items` | Each slot's shared pool: summaries, source URLs, data, `ai_score` |
| `slot_meta` | Daily Wrap connection, Concept of the day, fallback note |
| `deliveries` | What was sent to whom, plus the 👍/👎 rating |
| `events` | Taps (open, save, more, less, …) that drive the weights |
| `saved`, `feedback` | Saved items, and user feedback with its AI-sorted category |
| `asks` | Reserved for questions and answers (cleared after 30 days) |
| `source_state` | Source cursors, failure streaks, monthly AI spend |
| `sent_urls` | Hashes of URLs sent in the last 7 days, for exact dedupe |

## Privacy & content rules

- The bot stores only the Telegram user ID, first name, language, preferences and taps.
  `/deleteme` erases everything immediately.
- Every item links to its source. The AI writes only from the supplied text, and numbers are checked
  against API data.
- There is no trading advice, no price predictions and no token promotion. Briefings carry headlines
  and short summaries only, and the Crypto Brief has a disclaimer.

## Contributing

Issues and PRs are welcome, especially new high-quality feeds for `src/job/sources.ts`. Before
opening a PR, run:

```bash
npm run typecheck && npm test
npm run job -- <slot> --dry-run   # check what the briefing looks like
```

## License

[Apache License 2.0](LICENSE)
