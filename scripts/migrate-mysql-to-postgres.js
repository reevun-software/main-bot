// One-off data migration: copies every row from the legacy MySQL service into the new
// Postgres `main-db`. Run once, after applying sql/schema.sql to the Postgres database.
//
// Needs mysql2 temporarily (it's not a project dependency anymore):
//   npm install mysql2 --no-save
//
// Then run with both the old and new DB credentials in the environment, e.g. via:
//   railway run --service main-bot node scripts/migrate-mysql-to-postgres.js
// (Railway will inject POSTGRES_* from main-db automatically once step 2 is wired up;
// pass the legacy MySQL credentials explicitly as MYSQL_HOST/MYSQL_PORT/MYSQL_USER/
// MYSQL_PASSWORD/MYSQL_DBNAME — copy them from the old `MySQL` service's Variables tab.)

require("dotenv").config();
const mysql = require("mysql2/promise");
const { Pool } = require("pg");

async function main() {
  const mysqlConn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DBNAME
  });

  const pg = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DBNAME
  });

  async function copyTable(table, columns, transform = (row) => row, orderBy = null) {
    const [rows] = await mysqlConn.query(
      `SELECT * FROM \`${table}\`${orderBy ? ` ORDER BY ${orderBy}` : ""}`
    );
    console.log(`${table}: ${rows.length} rows`);
    for (const raw of rows) {
      const row = transform(raw);
      const values = columns.map((column) => row[column] ?? null);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      await pg.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
        values
      );
    }
  }

  await copyTable("users", [
    "discord_id", "username", "dm_notifications", "current_rank", "active_warnings", "total_warnings", "updated_at"
  ], (row) => ({
    ...row,
    dm_notifications: Boolean(row.dm_notifications)
  }));

  await copyTable("recruitment_settings", ["id", "section", "recruitment_open", "updated_at"], (row) => ({
    ...row,
    recruitment_open: Boolean(row.recruitment_open)
  }));

  await copyTable("capt_replay_window", [
    "id", "is_open", "opened_at", "opened_by", "thread_id", "open_count", "thread_history", "updated_at"
  ], (row) => ({
    ...row,
    is_open: Boolean(row.is_open),
    thread_history: JSON.stringify(
      typeof row.thread_history === "string" ? JSON.parse(row.thread_history || "[]") : (row.thread_history ?? [])
    )
  }));

  await copyTable("user_logs", [
    "log_type", "user_id", "old_rank", "new_rank", "administrator_id", "reason",
    "warn_action", "warning_reason", "is_active", "created_at"
  ], (row) => ({
    ...row,
    is_active: Boolean(row.is_active)
  }), "created_at, id");

  await copyTable("tickets", [
    "category", "ticket_key", "uid", "user_id", "status", "request_type", "ic_name",
    "character_level", "character_static_id", "capt_role", "ooc_age", "details",
    "claimed_by", "decided_by", "decision_reason", "channel_id", "message_id",
    "announcement_channel_id", "announcement_message_id", "created_at", "updated_at", "closed_at"
  ], (row) => row, "created_at, id");

  await copyTable("afk_sessions", ["user_id", "reason", "started_at", "expires_at", "updated_at"]);

  await mysqlConn.end();
  await pg.end();
  console.log("Migration finished.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
