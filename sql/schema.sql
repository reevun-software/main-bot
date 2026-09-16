-- PostgreSQL schema for main-bot.
-- Apply once against a fresh database, e.g.: psql "$DATABASE_URL" -f sql/schema.sql

CREATE TABLE IF NOT EXISTS users (
  discord_id       TEXT PRIMARY KEY,
  username         TEXT,
  dm_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  current_rank     INTEGER,
  active_warnings  INTEGER NOT NULL DEFAULT 0,
  total_warnings   INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recruitment_settings (
  id                INTEGER PRIMARY KEY,
  section           TEXT NOT NULL,
  recruitment_open  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_logs (
  id                BIGSERIAL PRIMARY KEY,
  log_type          TEXT NOT NULL, -- 'rank' | 'warn'
  user_id           TEXT NOT NULL,
  old_rank          INTEGER,
  new_rank          INTEGER,
  administrator_id  TEXT,
  reason            TEXT,
  warn_action       TEXT,          -- 'issued' | 'removed'
  warning_reason    TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_logs_user_id_idx ON user_logs (user_id);
CREATE INDEX IF NOT EXISTS user_logs_log_type_idx ON user_logs (log_type);

CREATE TABLE IF NOT EXISTS tickets (
  id                        BIGSERIAL PRIMARY KEY,
  category                  TEXT NOT NULL, -- 'application' | 'support'
  ticket_key                TEXT NOT NULL,
  uid                       TEXT,
  user_id                   TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'new',
  request_type              TEXT,
  ic_name                   TEXT,
  character_level           TEXT,
  character_static_id       TEXT,
  capt_role                 TEXT,
  ooc_age                   TEXT,
  details                   TEXT,
  claimed_by                TEXT,
  decided_by                TEXT,
  decision_reason           TEXT,
  channel_id                TEXT,
  message_id                TEXT,
  announcement_channel_id   TEXT,
  announcement_message_id   TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ,
  closed_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tickets_category_idx ON tickets (category);
CREATE INDEX IF NOT EXISTS tickets_user_id_idx ON tickets (user_id);

CREATE TABLE IF NOT EXISTS afk_sessions (
  user_id     TEXT PRIMARY KEY,
  reason      TEXT,
  started_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS afk_sessions_expires_at_idx ON afk_sessions (expires_at);

INSERT INTO recruitment_settings (id, section, recruitment_open)
VALUES (1, 'Capt', FALSE), (2, 'RP', FALSE)
ON CONFLICT (id) DO NOTHING;
