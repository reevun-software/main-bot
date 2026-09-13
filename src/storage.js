const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");

const state = {
  applications: {},
  botInfo: {},
  captReplayWindow: { isOpen: false, openedAt: null, openedBy: null, threadId: null, openCount: 0, threadHistory: [] },
  ranks: {},
  supportTickets: {},
  users: {},
  warnings: {}
};

let pool;
let writeQueue = Promise.resolve();
let reloadQueue = Promise.resolve();
let lastWriteError = null;

function pgTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function queueWrite(label, operation) {
  const operationPromise = writeQueue.catch(() => null).then(operation);
  writeQueue = operationPromise.then(
    () => {
      lastWriteError = null;
    },
    (error) => {
      lastWriteError = error;
      console.error(`Postgres write failed (${label}):`, error);
    }
  );
  return operationPromise;
}

async function replaceRows(table, insertRows, where = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (where) {
      await client.query(`DELETE FROM ${table} WHERE ${where.sql}`, where.params);
    } else {
      await client.query(`DELETE FROM ${table}`);
    }
    await insertRows(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function initStorage() {
  const required = ["POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DBNAME"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Не заданы переменные Postgres: ${missing.join(", ")}`);

  // TLS is required and pinned to a specific CA only when POSTGRES_SSL_CA_PATH is explicitly
  // set. Providers reachable only over a private/internal network (e.g. Railway's
  // <service>.railway.internal) neither offer nor need that — leave it unset there.
  const sslCaPath = process.env.POSTGRES_SSL_CA_PATH
    ? path.resolve(ROOT, process.env.POSTGRES_SSL_CA_PATH)
    : null;
  if (sslCaPath && !fs.existsSync(sslCaPath)) {
    throw new Error(`Не найден TLS-сертификат: ${sslCaPath}`);
  }

  const poolOptions = {
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DBNAME,
      max: 5,
      connectionTimeoutMillis: 15000,
      ...(sslCaPath
        ? { ssl: { ca: fs.readFileSync(sslCaPath, "utf8"), rejectUnauthorized: true } }
        : {})
    };
  const retryDelays = [0, 2000, 5000, 10000, 20000];
  let tls;
  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) {
      console.warn(`Postgres недоступна, повторное подключение через ${retryDelays[attempt] / 1000} сек.`);
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
    pool = new Pool(poolOptions);
    pool.on("error", (error) => console.error("Postgres pool error:", error));
    try {
      const { rows } = await pool.query("SELECT ssl, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
      tls = rows[0];
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => null);
      pool = null;
    }
  }
  if (lastError) throw lastError;
  if (sslCaPath && !tls?.cipher) throw new Error("Postgres-соединение установлено без TLS");
  resetState();
  await loadState();
  console.log(tls?.cipher ? `Postgres storage connected with TLS (${tls.cipher}).` : "Postgres storage connected (private network, no TLS).");
}

function resetState() {
  state.applications = {};
  state.botInfo = {};
  state.captReplayWindow = { isOpen: false, openedAt: null, openedBy: null, threadId: null, openCount: 0, threadHistory: [] };
  state.ranks = {};
  state.supportTickets = {};
  state.users = {};
  state.warnings = {};
}

function reloadStorage() {
  const reload = reloadQueue.catch(() => null).then(async () => {
    await flushStorage();
    resetState();
    await loadState();
  });
  reloadQueue = reload.catch(() => null);
  return reload;
}

async function loadState() {
  const { rows: recruitmentRows } = await pool.query(
    "SELECT id, section, recruitment_open, updated_at FROM recruitment_settings ORDER BY id"
  );
  const captSettings = recruitmentRows.find((row) => row.id === 1 || String(row.section).toLowerCase() === "capt");
  const rpSettings = recruitmentRows.find((row) => row.id === 2 || String(row.section).toLowerCase() === "rp");
  state.botInfo = {
    captRecruitmentOpen: Boolean(captSettings?.recruitment_open),
    rpRecruitmentOpen: Boolean(rpSettings?.recruitment_open),
    captUpdatedAt: isoDate(captSettings?.updated_at),
    rpUpdatedAt: isoDate(rpSettings?.updated_at)
  };

  const { rows: captReplayRows } = await pool.query(
    "SELECT is_open, opened_at, opened_by, thread_id, open_count, thread_history FROM capt_replay_window WHERE id = 1"
  );
  state.captReplayWindow = {
    isOpen: Boolean(captReplayRows[0]?.is_open),
    openedAt: isoDate(captReplayRows[0]?.opened_at),
    openedBy: captReplayRows[0]?.opened_by ?? null,
    threadId: captReplayRows[0]?.thread_id ?? null,
    openCount: Number(captReplayRows[0]?.open_count ?? 0),
    threadHistory: parseJsonArray(captReplayRows[0]?.thread_history)
  };

  const { rows: users } = await pool.query("SELECT * FROM users");
  for (const row of users) {
    state.users[row.discord_id] = { dmNotifications: Boolean(row.dm_notifications) };
  }

  // rank_logs and warning_logs are merged into one user_logs table, discriminated
  // by log_type — both are the same shape (who, when, which admin, why), just
  // with a few type-specific columns left null on the other type's rows.
  const { rows: logRows } = await pool.query("SELECT * FROM user_logs ORDER BY created_at, id");
  for (const row of logRows) {
    if (row.log_type === "rank") {
      state.ranks[row.user_id] ??= [];
      state.ranks[row.user_id].push({
        oldRank: row.old_rank == null ? null : Number(row.old_rank),
        newRank: row.new_rank == null ? null : Number(row.new_rank),
        adminId: row.administrator_id ?? "system",
        reason: row.reason,
        createdAt: isoDate(row.created_at)
      });
    } else if (row.log_type === "warn") {
      state.warnings[row.user_id] ??= { active: [], history: [] };
      const action = row.warn_action === "issued" ? "add" : "remove";
      state.warnings[row.user_id].history.push({
        action,
        adminId: row.administrator_id ?? "system",
        reason: row.reason,
        warnReason: row.warning_reason,
        createdAt: isoDate(row.created_at)
      });
      if (row.is_active) {
        state.warnings[row.user_id].active.push({
          reason: row.warning_reason,
          issuedBy: row.administrator_id ?? "system",
          issuedAt: isoDate(row.created_at)
        });
      }
    }
  }

  const { rows: ticketRows } = await pool.query("SELECT * FROM tickets ORDER BY created_at, id");
  for (const row of ticketRows) {
    if (row.category === "application") {
      state.applications[row.ticket_key] = {
        userId: row.user_id,
        uid: row.uid,
        status: row.status,
        characterInfo: [row.ic_name, row.character_level, row.character_static_id]
          .filter((part) => part !== null && part !== undefined && part !== "")
          .join(" / "),
        captRole: row.capt_role,
        oocAge: row.ooc_age,
        reason: row.details,
        requestType: row.request_type,
        claimedBy: row.claimed_by,
        closedBy: row.decided_by,
        decisionReason: row.decision_reason,
        channelId: row.channel_id,
        messageId: row.message_id,
        announcementChannelId: row.announcement_channel_id,
        announcementMessageId: row.announcement_message_id,
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        closedAt: isoDate(row.closed_at)
      };
    } else if (row.category === "support") {
      state.supportTickets[row.ticket_key] = {
        id: row.ticket_key,
        uid: row.uid,
        userId: row.user_id,
        status: row.status,
        requestType: row.request_type,
        details: row.details,
        claimedBy: row.claimed_by,
        closedBy: row.decided_by,
        decisionReason: row.decision_reason,
        channelId: row.channel_id,
        messageId: row.message_id,
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        closedAt: isoDate(row.closed_at)
      };
    }
  }
}

function getWarnings() { return state.warnings; }
function getBotInfo() { return state.botInfo; }
function getCaptReplayWindow() { return state.captReplayWindow; }
function getApplications() { return state.applications; }
function getUserDb() { return state.users; }
function getRankHistory() { return state.ranks; }
function getSupportTickets() { return state.supportTickets; }

async function getActiveGameAfkSessions() {
  const { rows } = await pool.query(
    `SELECT user_id, reason, started_at, expires_at
     FROM afk_sessions
     WHERE expires_at > now()
     ORDER BY expires_at, started_at`
  );
  return rows.map((row) => ({
    userId: row.user_id,
    reason: row.reason,
    startedAt: isoDate(row.started_at),
    expiresAt: isoDate(row.expires_at)
  }));
}

async function getGameAfkSession(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, reason, started_at, expires_at
     FROM afk_sessions WHERE user_id = $1 LIMIT 1`,
    [String(userId)]
  );
  const row = rows[0];
  return row ? {
    userId: row.user_id,
    reason: row.reason,
    startedAt: isoDate(row.started_at),
    expiresAt: isoDate(row.expires_at)
  } : null;
}

async function saveGameAfkSession({ userId, reason, startedAt, expiresAt }) {
  await pool.query(
    `INSERT INTO afk_sessions (user_id, reason, started_at, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       started_at = EXCLUDED.started_at,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [String(userId), reason, pgTimestamp(startedAt), pgTimestamp(expiresAt)]
  );
}

async function removeGameAfkSession(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT user_id, reason, started_at, expires_at
       FROM afk_sessions WHERE user_id = $1 FOR UPDATE`,
      [String(userId)]
    );
    if (!rows.length) {
      await client.query("COMMIT");
      return null;
    }
    await client.query("DELETE FROM afk_sessions WHERE user_id = $1", [String(userId)]);
    await client.query("COMMIT");
    const row = rows[0];
    return {
      userId: row.user_id,
      reason: row.reason,
      startedAt: isoDate(row.started_at),
      expiresAt: isoDate(row.expires_at)
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function takeExpiredGameAfkSessions() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT user_id, reason, started_at, expires_at
       FROM afk_sessions
       WHERE expires_at <= now()
       ORDER BY expires_at
       FOR UPDATE`
    );
    if (rows.length) {
      await client.query("DELETE FROM afk_sessions WHERE expires_at <= now()");
    }
    await client.query("COMMIT");
    return rows.map((row) => ({
      userId: row.user_id,
      reason: row.reason,
      startedAt: isoDate(row.started_at),
      expiresAt: isoDate(row.expires_at)
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function saveBotInfo(info, section = "both") {
  state.botInfo = info;
  return queueWrite("recruitment settings", async () => {
    const updates = [];
    if (section === "capt" || section === "both") {
      updates.push([1, "Capt", Boolean(info.captRecruitmentOpen)]);
    }
    if (section === "rp" || section === "both") {
      updates.push([2, "RP", Boolean(info.rpRecruitmentOpen)]);
    }
    for (const [id, sectionName, open] of updates) {
      await pool.query(
        `INSERT INTO recruitment_settings (id, section, recruitment_open, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET
           section = EXCLUDED.section,
           recruitment_open = EXCLUDED.recruitment_open,
           updated_at = now()`,
        [id, sectionName, open]
      );
    }
  });
}

function saveCaptReplayWindow(window) {
  state.captReplayWindow = window;
  return queueWrite("capt replay window", async () => {
    await pool.query(
      `INSERT INTO capt_replay_window (id, is_open, opened_at, opened_by, thread_id, open_count, thread_history, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         is_open = EXCLUDED.is_open,
         opened_at = EXCLUDED.opened_at,
         opened_by = EXCLUDED.opened_by,
         thread_id = EXCLUDED.thread_id,
         open_count = EXCLUDED.open_count,
         thread_history = EXCLUDED.thread_history,
         updated_at = now()`,
      [
        Boolean(window.isOpen),
        pgTimestamp(window.openedAt),
        window.openedBy ?? null,
        window.threadId ?? null,
        Number(window.openCount) || 0,
        json(window.threadHistory ?? [])
      ]
    );
  });
}

function saveUserDb(users) {
  state.users = users;
  return queueWrite("users", async () => {
    for (const [userId, user] of Object.entries(users)) {
      await pool.query(
        `INSERT INTO users (discord_id, dm_notifications) VALUES ($1, $2)
         ON CONFLICT (discord_id) DO UPDATE SET dm_notifications = EXCLUDED.dm_notifications`,
        [userId, user.dmNotifications !== false]
      );
    }
  });
}

function saveRankHistory(history) {
  state.ranks = history;
  return queueWrite("rank logs", () => replaceRows("user_logs", async (client) => {
    for (const [userId, entries] of Object.entries(history)) {
      for (const entry of entries) {
        await client.query(
          `INSERT INTO user_logs
           (log_type, user_id, old_rank, new_rank, administrator_id, reason, created_at)
           VALUES ('rank', $1, $2, $3, $4, $5, $6)`,
          [userId,
            Number.isFinite(Number(entry.oldRank)) ? Number(entry.oldRank) : null,
            Number.isFinite(Number(entry.newRank)) ? Number(entry.newRank) : null,
            entry.adminId === "system" ? null : entry.adminId ?? null,
            entry.reason ?? null, pgTimestamp(entry.createdAt)]
        );
      }
      const latest = entries.at(-1);
      if (latest) {
        await client.query(
          `UPDATE users SET current_rank = $1 WHERE discord_id = $2`,
          [Number.isFinite(Number(latest.newRank)) ? Number(latest.newRank) : null, userId]
        );
      }
    }
  }, { sql: "log_type = $1", params: ["rank"] }));
}

function saveWarnings(warnings) {
  state.warnings = warnings;
  return queueWrite("warning logs", () => replaceRows("user_logs", async (client) => {
    await client.query("UPDATE users SET active_warnings = 0, total_warnings = 0");
    for (const [userId, record] of Object.entries(warnings)) {
      const active = record.active ?? [];
      const history = record.history ?? [];
      // Match "add" history entries to still-active warnings by their shared issuedAt/createdAt
      // timestamp rather than by position: active warnings are removed LIFO, so the most
      // recently *issued* entry in history is not always the one still active (e.g. warn ->
      // remove -> warn again). Matching by identity avoids dropping or duplicating rows.
      const activeTimestamps = new Set(active.map((warning) => warning.issuedAt).filter(Boolean));
      const matchedTimestamps = new Set();
      for (const entry of history) {
        const issued = entry.action === "add";
        const isStillActive = issued &&
          entry.createdAt &&
          activeTimestamps.has(entry.createdAt) &&
          !matchedTimestamps.has(entry.createdAt);
        if (isStillActive) matchedTimestamps.add(entry.createdAt);
        await client.query(
          `INSERT INTO user_logs
           (log_type, user_id, warn_action, warning_reason, reason, administrator_id, is_active, created_at)
           VALUES ('warn', $1, $2, $3, $4, $5, $6, $7)`,
          [userId, issued ? "issued" : "removed", entry.warnReason ?? entry.reason ?? null,
            entry.reason ?? null, entry.adminId === "system" ? null : entry.adminId ?? null,
            isStillActive, pgTimestamp(entry.createdAt)]
        );
      }
      // Active warnings without a matching history "add" entry (e.g. synced from Discord roles,
      // which are never logged to history) still need their own row.
      for (const warning of active) {
        if (warning.issuedAt && matchedTimestamps.has(warning.issuedAt)) continue;
        await client.query(
          `INSERT INTO user_logs
           (log_type, user_id, warn_action, warning_reason, reason, administrator_id, is_active, created_at)
           VALUES ('warn', $1, 'issued', $2, $3, $4, TRUE, $5)`,
          [userId, warning.reason ?? null, warning.reason ?? null,
            warning.issuedBy === "system" ? null : warning.issuedBy ?? null,
            pgTimestamp(warning.issuedAt)]
        );
      }
      await client.query(
        `UPDATE users SET active_warnings = $1, total_warnings = $2 WHERE discord_id = $3`,
        [active.length, history.filter((entry) => entry.action === "add").length, userId]
      );
    }
  }, { sql: "log_type = $1", params: ["warn"] }));
}

async function syncUserProfile(userId, profile) {
  state.users[userId] ??= { dmNotifications: true };
  await pool.query(
    `INSERT INTO users (discord_id, username, current_rank)
     VALUES ($1, $2, $3)
     ON CONFLICT (discord_id) DO UPDATE SET
       username = EXCLUDED.username,
       current_rank = EXCLUDED.current_rank,
       updated_at = users.updated_at`,
    [userId, profile.username ?? null, profile.currentRank ?? null]
  );
}

async function deleteUserProfile(userId) {
  const normalizedUserId = String(userId);
  await flushStorage();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM user_logs WHERE user_id = $1", [normalizedUserId]);
    await client.query("DELETE FROM tickets WHERE user_id = $1", [normalizedUserId]);
    await client.query("DELETE FROM afk_sessions WHERE user_id = $1", [normalizedUserId]);
    await client.query("DELETE FROM users WHERE discord_id = $1", [normalizedUserId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  delete state.users[normalizedUserId];
  delete state.ranks[normalizedUserId];
  delete state.warnings[normalizedUserId];
  for (const [key, application] of Object.entries(state.applications)) {
    if (application.userId === normalizedUserId) delete state.applications[key];
  }
  for (const [key, ticket] of Object.entries(state.supportTickets)) {
    if (ticket.userId === normalizedUserId) delete state.supportTickets[key];
  }
}

function replaceTicketCategory(category, insertRows) {
  return queueWrite(`tickets:${category}`, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM tickets WHERE category = $1", [category]);
      await insertRows(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

function saveApplications(applications) {
  state.applications = applications;
  return replaceTicketCategory("application", async (client) => {
    for (const [applicationKey, application] of Object.entries(applications)) {
      const characterParts = String(application.characterInfo ?? "")
        .split("/")
        .map((part) => part.trim());
      await client.query(
         `INSERT INTO tickets
         (category, ticket_key, uid, user_id, status, request_type, ic_name, character_level,
          character_static_id, capt_role, ooc_age, details, claimed_by, decided_by, decision_reason,
          channel_id, message_id, announcement_channel_id, announcement_message_id,
          created_at, updated_at, closed_at)
         VALUES ('application', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [applicationKey, application.uid ?? null, application.userId,
          application.status ?? "new", application.requestType ?? "rp", characterParts[0] || null,
          characterParts[1] || null, characterParts[2] || null, application.captRole ?? null,
          application.oocAge ?? null,
          application.reason ?? null,
          application.claimedBy ?? null,
          application.closedBy ?? null,
          application.decisionReason ?? null,
          application.channelId ?? null, application.messageId ?? null,
          application.announcementChannelId ?? null,
          application.announcementMessageId ?? null,
          pgTimestamp(application.createdAt), pgTimestamp(application.updatedAt),
          pgTimestamp(application.closedAt)]
      );
    }
  });
}

function saveSupportTickets(tickets) {
  state.supportTickets = tickets;
  return replaceTicketCategory("support", async (client) => {
    for (const [ticketId, ticket] of Object.entries(tickets)) {
      await client.query(
        `INSERT INTO tickets
         (category, ticket_key, uid, user_id, status, request_type, details,
          claimed_by, decided_by, decision_reason, channel_id, message_id,
          created_at, updated_at, closed_at)
         VALUES ('support', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [ticket.id ?? ticketId, ticket.uid ?? null, ticket.userId,
          ticket.status ?? "new", ticket.requestType ?? null, ticket.details ?? null,
          ticket.claimedBy ?? null,
          ticket.closedBy ?? null,
          ticket.decisionReason ?? null, ticket.channelId ?? null,
          ticket.messageId ?? null, pgTimestamp(ticket.createdAt),
          pgTimestamp(ticket.updatedAt), pgTimestamp(ticket.closedAt)]
      );
    }
  });
}

async function flushStorage() {
  await writeQueue;
  if (lastWriteError) throw lastWriteError;
}

async function closeStorage() {
  await flushStorage();
  if (pool) await pool.end();
}

module.exports = {
  closeStorage,
  deleteUserProfile,
  flushStorage,
  getActiveGameAfkSessions,
  getApplications,
  getBotInfo,
  getCaptReplayWindow,
  getGameAfkSession,
  getRankHistory,
  getSupportTickets,
  getUserDb,
  getWarnings,
  initStorage,
  reloadStorage,
  removeGameAfkSession,
  saveApplications,
  saveBotInfo,
  saveCaptReplayWindow,
  saveGameAfkSession,
  saveRankHistory,
  saveSupportTickets,
  saveUserDb,
  saveWarnings,
  syncUserProfile,
  takeExpiredGameAfkSessions
};
