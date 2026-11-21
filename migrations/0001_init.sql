-- NodeNeuron D1 schema (PRD § Data model)

CREATE TABLE IF NOT EXISTS users (
  tg_user_id        INTEGER PRIMARY KEY,
  first_name        TEXT,
  role              TEXT,                       -- student | researcher | developer | trader
  depth             TEXT NOT NULL DEFAULT 'detailed', -- quick | detailed
  slots             INTEGER NOT NULL DEFAULT 15,      -- bitmask: 1 research, 2 crypto, 4 launches, 8 wrap
  language          TEXT NOT NULL DEFAULT 'en',
  status            TEXT NOT NULL DEFAULT 'onboarding', -- onboarding | active | paused | blocked
  onboarding_msg_id INTEGER,
  reminded_at       INTEGER,
  star_prompted_at  INTEGER,
  created_at        INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_topics (
  tg_user_id INTEGER NOT NULL,
  topic      TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_user_id, topic)
);

CREATE TABLE IF NOT EXISTS items (
  item_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_date        TEXT NOT NULL,   -- YYYY-MM-DD (IST)
  slot             INTEGER NOT NULL, -- 0 research, 1 crypto, 2 launches, 3 wrap
  type             TEXT NOT NULL,   -- paper | launch | news | data
  topic            TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary_short    TEXT NOT NULL DEFAULT '',
  summary_long     TEXT NOT NULL DEFAULT '',
  why_it_matters   TEXT NOT NULL DEFAULT '',
  simple_words     TEXT NOT NULL DEFAULT '',
  data_json        TEXT NOT NULL DEFAULT '{}',
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  ai_score         REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_slot ON items (slot_date, slot);

-- Per-slot extras (Daily Wrap "how they connect", Concept of the day, fallback note)
CREATE TABLE IF NOT EXISTS slot_meta (
  slot_date TEXT NOT NULL,
  slot      INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (slot_date, slot)
);

CREATE TABLE IF NOT EXISTS deliveries (
  tg_user_id    INTEGER NOT NULL,
  slot_date     TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  message_id    INTEGER,
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  rating        INTEGER,          -- 1 / -1 once the user taps 👍/👎
  sent_at       INTEGER NOT NULL,
  UNIQUE (tg_user_id, slot_date, slot)
);

CREATE TABLE IF NOT EXISTS events (
  tg_user_id INTEGER NOT NULL,
  item_id    INTEGER,
  kind       TEXT NOT NULL, -- open, up, down, more, less, save, digest_up, digest_down
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events (tg_user_id, created_at);

CREATE TABLE IF NOT EXISTS saved (
  tg_user_id INTEGER NOT NULL,
  item_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tg_user_id, item_id)
);

CREATE TABLE IF NOT EXISTS asks (
  tg_user_id INTEGER NOT NULL,
  question   TEXT NOT NULL,
  answer     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asks_user ON asks (tg_user_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
  tg_user_id  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  ai_category TEXT,
  created_at  INTEGER NOT NULL
);

-- Source cursors and other job state
CREATE TABLE IF NOT EXISTS source_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 7-day sent-URL list for exact dedupe
CREATE TABLE IF NOT EXISTS sent_urls (
  url_hash TEXT PRIMARY KEY,
  sent_at  INTEGER NOT NULL
);
