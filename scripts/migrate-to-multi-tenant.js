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

    let familyName = "Family";
    try {
      familyName = require(path.join(__dirname, "..", "config.json")).familyName || familyName;
    } catch {
      // config.json missing/unreadable - fall back to the placeholder name above.
    }
    await client.query(
      `INSERT INTO guilds (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [DISCORD_GUILD_ID, familyName]
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

    await client.query(`
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
        project                      TEXT,
        server                       TEXT,
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_modules (
        guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        module_key  TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (guild_id, module_key)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_departments (
        id                  BIGSERIAL PRIMARY KEY,
        guild_id            TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        member_discord_ids  TEXT[] NOT NULL DEFAULT '{}',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS guild_departments_guild_id_idx ON guild_departments (guild_id);
    `);

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

    await client.query(`ALTER TABLE user_logs ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE user_logs SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);
    await client.query(`CREATE INDEX IF NOT EXISTS user_logs_guild_id_idx ON user_logs (guild_id);`);

    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE tickets SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);
    await client.query(`CREATE INDEX IF NOT EXISTS tickets_guild_id_idx ON tickets (guild_id);`);

    await client.query(`ALTER TABLE afk_sessions ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;`);
    await client.query(`UPDATE afk_sessions SET guild_id = $1 WHERE guild_id IS NULL;`, [DISCORD_GUILD_ID]);

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
