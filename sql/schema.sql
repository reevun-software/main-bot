-- PostgreSQL schema for main-bot.
-- Apply once against a fresh database, e.g.: psql "$DATABASE_URL" -f sql/schema.sql
--
-- Multi-tenant: every table below (except the cross-guild `users` identity
-- cache) carries guild_id and is indexed on it, so a lookup for one guild
-- never scans another guild's rows - see sql/migrations/ for how an
-- existing single-tenant database is brought up to this shape without
-- losing data.

CREATE TABLE IF NOT EXISTS guilds (
  id                TEXT PRIMARY KEY, -- Discord guild id
  name              TEXT NOT NULL,
  icon              TEXT,
  owner_discord_id  TEXT,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-guild identity cache - a Discord user's username and DM preference
-- don't vary per guild. Per-guild state (rank, warnings) lives in
-- guild_members instead.
CREATE TABLE IF NOT EXISTS users (
  discord_id       TEXT PRIMARY KEY,
  username         TEXT,
  dm_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id         TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  discord_id       TEXT NOT NULL,
  current_rank     INTEGER,
  active_warnings  INTEGER NOT NULL DEFAULT 0,
  total_warnings   INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_id)
);
CREATE INDEX IF NOT EXISTS guild_members_guild_id_idx ON guild_members (guild_id);

CREATE TABLE IF NOT EXISTS recruitment_settings (
  guild_id          TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  section           TEXT NOT NULL,
  recruitment_open  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, section)
);

CREATE TABLE IF NOT EXISTS user_logs (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  log_type          TEXT NOT NULL, -- 'rank' | 'warn' | 'ban_added' | 'ban_removed'
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
CREATE INDEX IF NOT EXISTS user_logs_guild_id_idx ON user_logs (guild_id);
CREATE INDEX IF NOT EXISTS user_logs_user_id_idx ON user_logs (user_id);
CREATE INDEX IF NOT EXISTS user_logs_log_type_idx ON user_logs (log_type);

CREATE TABLE IF NOT EXISTS tickets (
  id                        BIGSERIAL PRIMARY KEY,
  guild_id                  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  category                  TEXT NOT NULL, -- 'application' | 'support'
  ticket_key                TEXT NOT NULL,
  uid                       TEXT,
  user_id                   TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'new',
  request_type              TEXT,
  department_name           TEXT,
  ic_name                   TEXT,
  character_level           TEXT,
  character_static_id       TEXT,
  capt_role                 TEXT,
  ooc_age                   TEXT,
  details                   TEXT,
  characters_link           TEXT,
  -- [{"label", "value"}] - set instead of ooc_age/details/characters_link
  -- when the department that was applied to has its own custom questions.
  custom_answers            JSONB NOT NULL DEFAULT '[]'::jsonb,
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
CREATE INDEX IF NOT EXISTS tickets_guild_id_idx ON tickets (guild_id);
CREATE INDEX IF NOT EXISTS tickets_category_idx ON tickets (category);
CREATE INDEX IF NOT EXISTS tickets_user_id_idx ON tickets (user_id);

CREATE TABLE IF NOT EXISTS afk_sessions (
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  reason      TEXT,
  started_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS afk_sessions_expires_at_idx ON afk_sessions (expires_at);

CREATE TABLE IF NOT EXISTS bans (
  id              BIGSERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  discord_user_id TEXT, -- nullable - a ban can target just an in-game name
  character_name  TEXT,
  reason          TEXT NOT NULL,
  issued_by       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bans_guild_id_idx ON bans (guild_id);

CREATE TABLE IF NOT EXISTS guild_security_settings (
  guild_id                            TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  moderator_role_ids                  TEXT[] NOT NULL DEFAULT '{}',
  ignore_command_cooldown_for_mods    BOOLEAN NOT NULL DEFAULT FALSE,
  allow_higher_mods_to_moderate_lower BOOLEAN NOT NULL DEFAULT FALSE,
  filter_links                        BOOLEAN NOT NULL DEFAULT FALSE,
  filter_invites                      BOOLEAN NOT NULL DEFAULT TRUE,
  filter_scam_links                   BOOLEAN NOT NULL DEFAULT TRUE,
  filter_bad_words                    BOOLEAN NOT NULL DEFAULT FALSE,
  filter_caps_lock                    BOOLEAN NOT NULL DEFAULT FALSE,
  filter_mention_spam                 BOOLEAN NOT NULL DEFAULT FALSE,
  mute_mode                           TEXT NOT NULL DEFAULT 'timeout', -- 'role' | 'timeout' | 'both'
  mute_role_id                        TEXT,
  mute_blocks_reactions               BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_bot_settings (
  guild_id                     TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  interface_language           TEXT NOT NULL DEFAULT 'ru',
  system_message_color         TEXT NOT NULL DEFAULT '#79040C',
  enable_slash_commands        BOOLEAN NOT NULL DEFAULT TRUE,
  enable_text_commands         BOOLEAN NOT NULL DEFAULT TRUE,
  trusted_admin_role_ids       TEXT[] NOT NULL DEFAULT '{}',
  default_role_ids             TEXT[] NOT NULL DEFAULT '{}',
  always_assign_default_roles  BOOLEAN NOT NULL DEFAULT FALSE,
  restore_nickname_on_rejoin   BOOLEAN NOT NULL DEFAULT FALSE,
  restore_old_roles_on_rejoin  BOOLEAN NOT NULL DEFAULT FALSE,
  restorable_role_ids          TEXT[] NOT NULL DEFAULT '{}',
  exempt_role_ids              TEXT[] NOT NULL DEFAULT '{}',
  project                      TEXT, -- RP platform this family plays on, e.g. "majestic" | "russiaonline" | "gta5rp"
  server                       TEXT, -- city/server within `project`
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bot-operational per-guild config that used to live in the single,
-- hardcoded config.json - which channel is which panel, which roles mean
-- what. Replacing this (a JSON file baked into the one deployment) is what
-- makes the bot able to serve more than one guild at all.
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id                      TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  leadership_role_ids           TEXT[] NOT NULL DEFAULT '{}',
  -- {"<rank>": {"roleIds": [...], "label": "...", "nicknamePrefix": "..."}} -
  -- arbitrary rank count and labels, not a fixed 1-7 ladder.
  rank_role_ids                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  warn_role_ids                 JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"1": "roleId", "2": "roleId"}
  verified_member_role_id       TEXT,
  log_channel_id                TEXT,
  applications_channel_id       TEXT,
  application_panel_channel_id  TEXT,
  support_panel_channel_id      TEXT,
  admin_panel_channel_id        TEXT,
  -- Mirrors the dashboard's "departments" module toggle - distinguishes
  -- "no departments configured yet" (falls back to the generic apply
  -- button) from "departments exist but explicitly disabled" (same
  -- fallback, different reason). Defaults true like every module.
  departments_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  -- What happens on a member's 3rd active warn: 'stripRoles' (default,
  -- historical behavior) | 'kick' | 'ban' | 'assignRole' (uses
  -- warn_punishment_role_id instead of touching their other roles).
  warn_punishment_mode          TEXT NOT NULL DEFAULT 'stripRoles',
  warn_punishment_role_id       TEXT,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (guild, module) - a module absent here is enabled by default,
-- only owner-disabled modules get an explicit row.
CREATE TABLE IF NOT EXISTS guild_modules (
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL, -- "warnings" | "tickets" | "afk" | "blacklist" | "departments"
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, module_key)
);

CREATE TABLE IF NOT EXISTS guild_departments (
  id                  BIGSERIAL PRIMARY KEY,
  guild_id            TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  member_discord_ids  TEXT[] NOT NULL DEFAULT '{}',
  -- Whether this department is currently accepting applications - the
  -- application panel lists only open departments, and shows a single
  -- generic "apply to the family" button instead when a guild has none.
  recruitment_open    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Custom application-form questions for this department, up to 4 (a 5th
  -- modal field is always the fixed IC-name/level/Static-ID one - see
  -- buildApplicationModal). [{"id", "label", "style": "short"|"paragraph",
  -- "required"}]. Empty means "use the default question set".
  questions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_departments_guild_id_idx ON guild_departments (guild_id);

-- Per-filter advanced automod settings - one row per (guild, filter type)
-- that only exists once someone actually saves that filter's settings; a
-- filter with no row here just runs with defaults.
CREATE TABLE IF NOT EXISTS automod_filter_config (
  guild_id                TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  filter_type             TEXT NOT NULL, -- e.g. "filterLinks"
  delete_message          BOOLEAN NOT NULL DEFAULT TRUE,
  punishment               TEXT NOT NULL DEFAULT 'none', -- 'none' | 'warn' | 'mute' | 'kick' | 'ban'
  strategy                 TEXT NOT NULL DEFAULT 'blocklist', -- 'blocklist' | 'allowlist'
  list                     TEXT[] NOT NULL DEFAULT '{}',
  notify_user              BOOLEAN NOT NULL DEFAULT FALSE,
  ignore_admins_and_mods   BOOLEAN NOT NULL DEFAULT FALSE,
  ignore_slash_commands    BOOLEAN NOT NULL DEFAULT FALSE,
  target_role_ids          TEXT[] NOT NULL DEFAULT '{}',
  ignored_role_ids         TEXT[] NOT NULL DEFAULT '{}',
  target_channel_ids       TEXT[] NOT NULL DEFAULT '{}',
  ignored_channel_ids      TEXT[] NOT NULL DEFAULT '{}',
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, filter_type)
);

INSERT INTO recruitment_settings (guild_id, section, recruitment_open)
SELECT id, section, FALSE FROM guilds, (VALUES ('Capt'), ('RP')) AS s(section)
ON CONFLICT (guild_id, section) DO NOTHING;
