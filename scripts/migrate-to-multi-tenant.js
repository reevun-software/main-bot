// One-time migration: brings an existing single-tenant database (built
// for exactly one Discord guild) up to the multi-tenant shape in
// sql/schema.sql, without losing any existing data.
//
// Safe to re-run - every step is guarded (IF NOT EXISTS / ON CONFLICT DO
// NOTHING). Deliberately does NOT drop the legacy users.current_rank /
// active_warnings / total_warnings columns or make the new guild_id
// columns NOT NULL yet - the running bot still writes through the old
// shape until its code is updated to be guild-aware, and this script
// must not break that in-between period.
//
// Usage: node scripts/migrate-to-multi-tenant.js
// Needs DISCORD_GUILD_ID (the one guild all existing rows belong to) and
// either TUNNEL_DATABASE_URL/DATABASE_URL or the POSTGRES_* vars storage.js
// itself uses.
require("dotenv").config();
const path = require("node:path");
const { Pool } = require("pg");

async function main() {
  const { DISCORD_GUILD_ID, TUNNEL_DATABASE_URL, DATABASE_URL } = process.env;
  if (!DISCORD_GUILD_ID) {
    throw new Error("DISCORD_GUILD_ID is required - every existing row is backfilled as belonging to this guild.");
  }

  const connectionString = TUNNEL_DATABASE_URL || DATABASE_URL;
  const pool = connectionString
    ? new Pool({ connectionString, ssl: false })
    : new Pool({
        host: process.env.POSTGRES_HOST,
        port: Number(process.env.POSTGRES_PORT || 5432),
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DBNAME,
        ssl: process.env.POSTGRES_SSL_CA_PATH
          ? { ca: require("node:fs").readFileSync(path.resolve(__dirname, "..", process.env.POSTGRES_SSL_CA_PATH), "utf8") }
          : undefined
      });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Create every brand-new table from the target schema (guilds must
    // come first - everything else references it).
    await client.query(`
      CREATE TABLE IF NOT EXISTS guilds (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        icon              TEXT,
        owner_discord_id  TEXT,
        installed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    let legacyConfig = {};
    try {
      legacyConfig = require(path.join(__dirname, "..", "config.json"));
    } catch {
      // config.json missing/unreadable - guild_config below just gets defaults.
    }
    await client.query(
      `INSERT INTO guilds (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [DISCORD_GUILD_ID, legacyConfig.familyName || "Family"]
    );

    await client.query(`
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
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bans (
        id              BIGSERIAL PRIMARY KEY,
        guild_id        TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        discord_user_id TEXT,
        character_name  TEXT,
        reason          TEXT NOT NULL,
        issued_by       TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS bans_guild_id_idx ON bans (guild_id);
    `);

    await client.query(`
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
        mute_mode                           TEXT NOT NULL DEFAULT 'timeout',
        mute_role_id                        TEXT,
        mute_blocks_reactions               BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // guild_bot_settings and guild_modules used to be created here too, but
    // neither was ever read or written by any bot JS - they only mirrored
    // the website's own tables of the same name (which own that data for
    // real: interface_language/system_message_color/trusted_admin_role_ids/
    // project/server, and the dashboard's own module-visibility toggles).
    // Dropped as dead scaffolding; do not recreate them here.

    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_departed_members (
        guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        discord_id  TEXT NOT NULL,
        nickname    TEXT,
        role_ids    TEXT[] NOT NULL DEFAULT '{}',
        left_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (guild_id, discord_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_departments (
        id                  BIGSERIAL PRIMARY KEY,
        guild_id            TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        member_discord_ids  TEXT[] NOT NULL DEFAULT '{}',
        recruitment_open    BOOLEAN NOT NULL DEFAULT TRUE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS guild_departments_guild_id_idx ON guild_departments (guild_id);
    `);
    await client.query(`ALTER TABLE guild_departments ADD COLUMN IF NOT EXISTS recruitment_open BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE guild_departments ADD COLUMN IF NOT EXISTS questions JSONB NOT NULL DEFAULT '[]'::jsonb;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS automod_filter_config (
        guild_id                TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        filter_type              TEXT NOT NULL,
        delete_message           BOOLEAN NOT NULL DEFAULT TRUE,
        punishment                TEXT NOT NULL DEFAULT 'none',
        strategy                  TEXT NOT NULL DEFAULT 'blocklist',
        list                      TEXT[] NOT NULL DEFAULT '{}',
        notify_user               BOOLEAN NOT NULL DEFAULT FALSE,
        ignore_admins_and_mods    BOOLEAN NOT NULL DEFAULT FALSE,
        ignore_slash_commands     BOOLEAN NOT NULL DEFAULT FALSE,
        target_role_ids           TEXT[] NOT NULL DEFAULT '{}',
        ignored_role_ids          TEXT[] NOT NULL DEFAULT '{}',
        target_channel_ids        TEXT[] NOT NULL DEFAULT '{}',
        ignored_channel_ids       TEXT[] NOT NULL DEFAULT '{}',
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (guild_id, filter_type)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id                      TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
        leadership_role_ids           TEXT[] NOT NULL DEFAULT '{}',
        rank_role_ids                 JSONB NOT NULL DEFAULT '{}'::jsonb,
        warn_role_ids                 JSONB NOT NULL DEFAULT '{}'::jsonb,
        verified_member_role_id       TEXT,
        log_channel_id                TEXT,
        applications_channel_id       TEXT,
        application_panel_channel_id  TEXT,
        support_panel_channel_id      TEXT,
        admin_panel_channel_id        TEXT,
        departments_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS departments_enabled BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS warn_punishment_mode TEXT NOT NULL DEFAULT 'stripRoles';`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS warn_punishment_role_id TEXT;`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS default_role_ids TEXT[] NOT NULL DEFAULT '{}';`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS always_assign_default_roles BOOLEAN NOT NULL DEFAULT FALSE;`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS restore_nickname_on_rejoin BOOLEAN NOT NULL DEFAULT FALSE;`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS restore_old_roles_on_rejoin BOOLEAN NOT NULL DEFAULT FALSE;`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS restorable_role_ids TEXT[] NOT NULL DEFAULT '{}';`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS exempt_role_ids TEXT[] NOT NULL DEFAULT '{}';`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS enable_slash_commands BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS enable_text_commands BOOLEAN NOT NULL DEFAULT TRUE;`);

    // rank_role_ids is {"<rank>": {roleIds: [...], label, nicknamePrefix}} -
    // an arbitrary-length, self-describing structure (any rank count, any
    // label) rather than a bare role-id map, since a different family can
    // have a completely different rank ladder (not fixed at 7 like this one).
    const RANK_LABELS = {
      5: { label: "High-Staff", nicknamePrefix: "High" },
      6: { label: "Deputy Leader", nicknamePrefix: "Deputy" },
      7: { label: "Leader", nicknamePrefix: "Leader" }
    };
    function buildRankDefinitions(rankRoleIds) {
      const result = {};
      for (const [rank, roleIdOrIds] of Object.entries(rankRoleIds || {})) {
        const meta = RANK_LABELS[rank] || { label: rank, nicknamePrefix: rank };
        result[rank] = {
          roleIds: Array.isArray(roleIdOrIds) ? roleIdOrIds : [roleIdOrIds],
          label: meta.label,
          nicknamePrefix: meta.nicknamePrefix
        };
      }
      return result;
    }

    // Seeded from config.json (per-guild leadership/rank roles) plus the
    // channel/role constants that used to be hardcoded at the top of
    // index.js - both only ever described this one guild anyway.
    await client.query(
      `INSERT INTO guild_config (
        guild_id, leadership_role_ids, rank_role_ids, warn_role_ids,
        verified_member_role_id, log_channel_id, applications_channel_id,
        application_panel_channel_id, support_panel_channel_id, admin_panel_channel_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (guild_id) DO NOTHING`,
      [
        DISCORD_GUILD_ID,
        legacyConfig.leadershipRoleIds || [],
        JSON.stringify(buildRankDefinitions(legacyConfig.rankRoleIds)),
        JSON.stringify({ 1: "1290775235360194610", 2: "1290775323373211770" }),
        "1265995505524015245",
        legacyConfig.logChannelId || null,
        legacyConfig.applicationsChannelId || null,
        "1315860449442398239",
        "1509572136694452407",
        "1291543297747194010"
      ]
    );

    // Reshape rank_role_ids on a row from an earlier version of this
    // migration, which seeded the old flat {"<rank>": roleId} shape.
    // Guarded on the actual stored shape (not a version flag) and only
    // touches that one column, so it never overwrites rank config a family
    // has since edited themselves through the (future) dashboard - editing
    // there always produces the new shape already.
    const { rows: existingConfigRows } = await client.query(
      `SELECT rank_role_ids FROM guild_config WHERE guild_id = $1`,
      [DISCORD_GUILD_ID]
    );
    const storedRankRoleIds = existingConfigRows[0]?.rank_role_ids;
    const isOldFlatShape = storedRankRoleIds && Object.keys(storedRankRoleIds).length > 0 &&
      !Object.values(storedRankRoleIds).some((value) => value && typeof value === "object" && !Array.isArray(value) && "roleIds" in value);
    if (isOldFlatShape) {
      await client.query(
        `UPDATE guild_config SET rank_role_ids = $2, updated_at = now() WHERE guild_id = $1`,
        [DISCORD_GUILD_ID, JSON.stringify(buildRankDefinitions(storedRankRoleIds))]
      );
    }

    // 2. Backfill guild_members from the existing single-tenant users table
    // (rank/warning columns stay on `users` too for now - dropped in a
    // later migration once bot code no longer reads them from there).
    await client.query(`
      INSERT INTO guild_members (guild_id, discord_id, current_rank, active_warnings, total_warnings, updated_at)
      SELECT $1, discord_id, current_rank, active_warnings, total_warnings, updated_at FROM users
      ON CONFLICT (guild_id, discord_id) DO NOTHING;
    `, [DISCORD_GUILD_ID]);

    // 3. Add nullable guild_id to existing single-tenant tables and
    // backfill it - NOT NULL / PK changes land in a follow-up migration
    // once the bot writes guild_id on every insert itself.
    await client.query(`ALTER TABLE recruitment_settings ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE recruitment_settings SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);

    // The application flow used to be hardcoded to two sections (Capt/RP)
    // via recruitment_settings - it's department-driven now (any number of
    // departments, any names). A guild with zero departments gets a single
    // generic "apply to the family" button instead, which would silently
    // replace this guild's real, currently-working Capt/RP recruitment the
    // moment this deploys. Seed two departments from its legacy
    // recruitment_settings rows (same open/closed state) so the live
    // family's recruitment keeps working exactly as it does today under
    // the new system - guarded on guild_departments already being empty,
    // so this never runs again or touches departments a family has since
    // configured themselves.
    const { rows: existingDepartmentCount } = await client.query(
      `SELECT count(*)::int AS n FROM guild_departments WHERE guild_id = $1`,
      [DISCORD_GUILD_ID]
    );
    if (existingDepartmentCount[0].n === 0) {
      const { rows: legacyRecruitment } = await client.query(
        `SELECT section, recruitment_open FROM recruitment_settings WHERE guild_id = $1`,
        [DISCORD_GUILD_ID]
      );
      for (const row of legacyRecruitment) {
        const name = String(row.section).toLowerCase() === "capt" ? "Капт-состав" : "RP-состав";
        await client.query(
          `INSERT INTO guild_departments (guild_id, name, recruitment_open) VALUES ($1, $2, $3)`,
          [DISCORD_GUILD_ID, name, row.recruitment_open]
        );
      }
    }

    await client.query(`ALTER TABLE user_logs ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE user_logs SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);
    await client.query(`CREATE INDEX IF NOT EXISTS user_logs_guild_id_idx ON user_logs (guild_id);`);

    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE tickets SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);
    await client.query(`CREATE INDEX IF NOT EXISTS tickets_guild_id_idx ON tickets (guild_id);`);
    // characters_link was never persisted at all before this (only held in
    // the in-memory applications map, lost on every restart) - added here
    // alongside custom_answers since both need the same treatment.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS characters_link TEXT;`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS custom_answers JSONB NOT NULL DEFAULT '[]'::jsonb;`);
    // department_name was never persisted either - held only in the
    // in-memory applications map, so every application's shown department
    // reverted to the generic "Общая заявка" fallback after a restart.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS department_name TEXT;`);

    await client.query(`ALTER TABLE afk_sessions ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE afk_sessions SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);

    // Widen the primary key from just user_id to (guild_id, user_id) - the
    // same Discord user can be AFK in two different guilds at once, which
    // the old single-column PK couldn't represent at all (a second guild's
    // insert would just clobber the first guild's row). Guarded on the
    // actual constraint shape, not a version flag, so it only runs once.
    const { rows: pkColumns } = await client.query(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'afk_sessions'::regclass AND i.indisprimary
    `);
    const isComposite = pkColumns.length === 2 && pkColumns.some((r) => r.attname === "guild_id");
    if (!isComposite) {
      await client.query(`ALTER TABLE afk_sessions ALTER COLUMN guild_id SET NOT NULL;`);
      const { rows: pkConstraint } = await client.query(`
        SELECT conname FROM pg_constraint WHERE conrelid = 'afk_sessions'::regclass AND contype = 'p'
      `);
      if (pkConstraint[0]) {
        await client.query(`ALTER TABLE afk_sessions DROP CONSTRAINT ${pkConstraint[0].conname};`);
      }
      await client.query(`ALTER TABLE afk_sessions ADD PRIMARY KEY (guild_id, user_id);`);
    }

    await client.query("COMMIT");
    console.log(`Migration complete. Existing rows backfilled to guild_id = ${DISCORD_GUILD_ID}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
