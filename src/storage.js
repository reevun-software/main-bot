const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");

const state = {
  applications: {},
  guildConfigs: {}, // guildId -> per-guild config (replaces the old single config.json)
  guildSecuritySettings: {}, // guildId -> moderator/mute/automod-toggle config
  automodFilterConfigs: {}, // guildId -> filterType -> per-filter automod config
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

  // One-time (idempotent - safe to run on every boot) upgrade to the
  // multi-tenant schema. Runs here, inside Railway's private network,
  // because the machine deploying this code cannot reach
  // <service>.railway.internal directly to run it by hand.
  await require("../scripts/migrate-to-multi-tenant").main().catch((error) => {
    console.error("Multi-tenant schema migration failed:", error);
    throw error;
  });

  resetState();
  await loadState();
  console.log(tls?.cipher ? `Postgres storage connected with TLS (${tls.cipher}).` : "Postgres storage connected (private network, no TLS).");
}

function resetState() {
  state.applications = {};
  state.guildConfigs = {};
  state.guildSecuritySettings = {};
  state.automodFilterConfigs = {};
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
  const { rows: guildConfigRows } = await pool.query("SELECT * FROM guild_config");
  state.guildConfigs = {};
  for (const row of guildConfigRows) {
    state.guildConfigs[row.guild_id] = {
      leadershipRoleIds: row.leadership_role_ids ?? [],
      rankRoleIds: row.rank_role_ids ?? {},
      warnRoleIds: row.warn_role_ids ?? {},
      verifiedMemberRoleId: row.verified_member_role_id,
      logChannelId: row.log_channel_id,
      applicationsChannelId: row.applications_channel_id,
      applicationPanelChannelId: row.application_panel_channel_id,
      supportPanelChannelId: row.support_panel_channel_id,
      adminPanelChannelId: row.admin_panel_channel_id,
      departmentsEnabled: row.departments_enabled,
      warnPunishmentMode: row.warn_punishment_mode,
      warnPunishmentRoleId: row.warn_punishment_role_id,
      defaultRoleIds: row.default_role_ids ?? [],
      alwaysAssignDefaultRoles: row.always_assign_default_roles,
      restoreNicknameOnRejoin: row.restore_nickname_on_rejoin,
      restoreOldRolesOnRejoin: row.restore_old_roles_on_rejoin,
      restorableRoleIds: row.restorable_role_ids ?? [],
      exemptRoleIds: row.exempt_role_ids ?? [],
      enableSlashCommands: row.enable_slash_commands,
      enableTextCommands: row.enable_text_commands,
      systemMessageColor: row.system_message_color
    };
  }

  const { rows: securityRows } = await pool.query("SELECT * FROM guild_security_settings");
  state.guildSecuritySettings = {};
  for (const row of securityRows) {
    state.guildSecuritySettings[row.guild_id] = {
      moderatorRoleIds: row.moderator_role_ids ?? [],
      ignoreCommandCooldownForMods: row.ignore_command_cooldown_for_mods,
      allowHigherModsToModerateLower: row.allow_higher_mods_to_moderate_lower,
      filterLinks: row.filter_links,
      filterInvites: row.filter_invites,
      filterScamLinks: row.filter_scam_links,
      filterBadWords: row.filter_bad_words,
      filterCapsLock: row.filter_caps_lock,
      filterMentionSpam: row.filter_mention_spam,
      muteMode: row.mute_mode,
      muteRoleId: row.mute_role_id,
      muteBlocksReactions: row.mute_blocks_reactions
    };
  }

  const { rows: automodRows } = await pool.query("SELECT * FROM automod_filter_config");
  state.automodFilterConfigs = {};
  for (const row of automodRows) {
    state.automodFilterConfigs[row.guild_id] ??= {};
    state.automodFilterConfigs[row.guild_id][row.filter_type] = {
      deleteMessage: row.delete_message,
      punishment: row.punishment,
      strategy: row.strategy,
      list: row.list ?? [],
      notifyUser: row.notify_user,
      ignoreAdminsAndMods: row.ignore_admins_and_mods,
      ignoreSlashCommands: row.ignore_slash_commands,
      targetRoleIds: row.target_role_ids ?? [],
      ignoredRoleIds: row.ignored_role_ids ?? [],
      targetChannelIds: row.target_channel_ids ?? [],
      ignoredChannelIds: row.ignored_channel_ids ?? []
    };
  }

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
        guildId: row.guild_id,
        userId: row.user_id,
        uid: row.uid,
        status: row.status,
        characterInfo: [row.ic_name, row.character_level, row.character_static_id]
          .filter((part) => part !== null && part !== undefined && part !== "")
          .join(" / "),
        captRole: row.capt_role,
        oocAge: row.ooc_age,
        reason: row.details,
        charactersLink: row.characters_link,
        customAnswers: row.custom_answers?.length ? row.custom_answers : null,
        requestType: row.request_type,
        departmentName: row.department_name,
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
        guildId: row.guild_id,
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

const EMPTY_GUILD_CONFIG = {
  leadershipRoleIds: [],
  rankRoleIds: {},
  warnRoleIds: {},
  verifiedMemberRoleId: null,
  logChannelId: null,
  applicationsChannelId: null,
  applicationPanelChannelId: null,
  supportPanelChannelId: null,
  adminPanelChannelId: null,
  departmentsEnabled: true,
  warnPunishmentMode: "stripRoles",
  warnPunishmentRoleId: null,
  defaultRoleIds: [],
  alwaysAssignDefaultRoles: false,
  restoreNicknameOnRejoin: false,
  restoreOldRolesOnRejoin: false,
  restorableRoleIds: [],
  exemptRoleIds: [],
  enableSlashCommands: true,
  enableTextCommands: true,
  systemMessageColor: "#79040C"
};
// A guild with no row yet (bot just joined, dashboard not configured) gets
// an empty-but-shaped config rather than undefined, so callers can always
// read e.g. `.leadershipRoleIds` without a null check.
function getGuildConfig(guildId) { return state.guildConfigs[guildId] ?? EMPTY_GUILD_CONFIG; }

const EMPTY_SECURITY_SETTINGS = {
  moderatorRoleIds: [],
  ignoreCommandCooldownForMods: false,
  allowHigherModsToModerateLower: false,
  filterLinks: false,
  filterInvites: true,
  filterScamLinks: true,
  filterBadWords: false,
  filterCapsLock: false,
  filterMentionSpam: false,
  muteMode: "timeout",
  muteRoleId: null,
  muteBlocksReactions: false
};
function getSecuritySettings(guildId) { return state.guildSecuritySettings[guildId] ?? EMPTY_SECURITY_SETTINGS; }

const EMPTY_AUTOMOD_FILTER_CONFIG = {
  deleteMessage: true,
  punishment: "none",
  strategy: "blocklist",
  list: [],
  notifyUser: false,
  ignoreAdminsAndMods: false,
  ignoreSlashCommands: false,
  targetRoleIds: [],
  ignoredRoleIds: [],
  targetChannelIds: [],
  ignoredChannelIds: []
};
function getAutomodFilterConfig(guildId, filterType) {
  return state.automodFilterConfigs[guildId]?.[filterType] ?? EMPTY_AUTOMOD_FILTER_CONFIG;
}
// All configured filters for a guild, keyed by filter type - a filter with
// no saved row just isn't in this map, callers fall back to
// EMPTY_AUTOMOD_FILTER_CONFIG for it same as getAutomodFilterConfig does.
function getAutomodFilterConfigsForGuild(guildId) {
  return state.automodFilterConfigs[guildId] ?? {};
}

// Registers a guild the bot is in (called on boot for every guild already
// joined, and on guildCreate for one newly joined) - every other
// guild-scoped table FKs into this one, so it must exist before anything
// else is written for that guild.
function upsertGuild({ id, name, icon = null, ownerDiscordId = null }) {
  return queueWrite("upsert guild", () =>
    pool.query(
      `INSERT INTO guilds (id, name, icon, owner_discord_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, owner_discord_id = EXCLUDED.owner_discord_id`,
      [id, name, icon, ownerDiscordId]
    )
  );
}

// Column-name map so the API layer can accept camelCase field names
// (matching the web dashboard's own naming) without duplicating this
// mapping there too.
const GUILD_CONFIG_COLUMNS = {
  leadershipRoleIds: "leadership_role_ids",
  rankRoleIds: "rank_role_ids",
  warnRoleIds: "warn_role_ids",
  verifiedMemberRoleId: "verified_member_role_id",
  logChannelId: "log_channel_id",
  applicationsChannelId: "applications_channel_id",
  applicationPanelChannelId: "application_panel_channel_id",
  supportPanelChannelId: "support_panel_channel_id",
  adminPanelChannelId: "admin_panel_channel_id",
  departmentsEnabled: "departments_enabled",
  warnPunishmentMode: "warn_punishment_mode",
  warnPunishmentRoleId: "warn_punishment_role_id",
  defaultRoleIds: "default_role_ids",
  alwaysAssignDefaultRoles: "always_assign_default_roles",
  restoreNicknameOnRejoin: "restore_nickname_on_rejoin",
  restoreOldRolesOnRejoin: "restore_old_roles_on_rejoin",
  restorableRoleIds: "restorable_role_ids",
  exemptRoleIds: "exempt_role_ids",
  enableSlashCommands: "enable_slash_commands",
  enableTextCommands: "enable_text_commands",
  systemMessageColor: "system_message_color"
};

const SECURITY_SETTINGS_COLUMNS = {
  moderatorRoleIds: "moderator_role_ids",
  ignoreCommandCooldownForMods: "ignore_command_cooldown_for_mods",
  allowHigherModsToModerateLower: "allow_higher_mods_to_moderate_lower",
  filterLinks: "filter_links",
  filterInvites: "filter_invites",
  filterScamLinks: "filter_scam_links",
  filterBadWords: "filter_bad_words",
  filterCapsLock: "filter_caps_lock",
  filterMentionSpam: "filter_mention_spam",
  muteMode: "mute_mode",
  muteRoleId: "mute_role_id",
  muteBlocksReactions: "mute_blocks_reactions"
};

// Same partial-update shape as updateGuildConfig - merges into the cache
// immediately, queues the actual write.
function updateSecuritySettings(guildId, patch) {
  const current = getSecuritySettings(guildId);
  const merged = { ...current, ...patch };
  state.guildSecuritySettings[guildId] = merged;

  const setClauses = [];
  const params = [guildId];
  for (const [jsKey, column] of Object.entries(SECURITY_SETTINGS_COLUMNS)) {
    if (!(jsKey in patch)) continue;
    params.push(patch[jsKey]);
    setClauses.push(`${column} = $${params.length}`);
  }
  if (!setClauses.length) return Promise.resolve(merged);

  return queueWrite("update guild security settings", () =>
    pool.query(
      `INSERT INTO guild_security_settings (guild_id) VALUES ($1)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId]
    ).then(() =>
      pool.query(
        `UPDATE guild_security_settings SET ${setClauses.join(", ")}, updated_at = now() WHERE guild_id = $1`,
        params
      )
    )
  ).then(() => merged);
}

const AUTOMOD_FILTER_CONFIG_COLUMNS = {
  deleteMessage: "delete_message",
  punishment: "punishment",
  strategy: "strategy",
  list: "list",
  notifyUser: "notify_user",
  ignoreAdminsAndMods: "ignore_admins_and_mods",
  ignoreSlashCommands: "ignore_slash_commands",
  targetRoleIds: "target_role_ids",
  ignoredRoleIds: "ignored_role_ids",
  targetChannelIds: "target_channel_ids",
  ignoredChannelIds: "ignored_channel_ids"
};

function updateAutomodFilterConfig(guildId, filterType, patch) {
  const current = getAutomodFilterConfig(guildId, filterType);
  const merged = { ...current, ...patch };
  state.automodFilterConfigs[guildId] ??= {};
  state.automodFilterConfigs[guildId][filterType] = merged;

  const setClauses = [];
  const params = [guildId, filterType];
  for (const [jsKey, column] of Object.entries(AUTOMOD_FILTER_CONFIG_COLUMNS)) {
    if (!(jsKey in patch)) continue;
    params.push(patch[jsKey]);
    setClauses.push(`${column} = $${params.length}`);
  }
  if (!setClauses.length) return Promise.resolve(merged);

  return queueWrite("update automod filter config", () =>
    pool.query(
      `INSERT INTO automod_filter_config (guild_id, filter_type) VALUES ($1, $2)
       ON CONFLICT (guild_id, filter_type) DO NOTHING`,
      [guildId, filterType]
    ).then(() =>
      pool.query(
        `UPDATE automod_filter_config SET ${setClauses.join(", ")}, updated_at = now() WHERE guild_id = $1 AND filter_type = $2`,
        params
      )
    )
  ).then(() => merged);
}

// Leave-snapshot for rejoin restoration - not cached (read/written rarely,
// only around member add/remove), queried directly like the department
// functions below.
async function saveDepartedMemberSnapshot(guildId, discordId, { nickname, roleIds }) {
  await queueWrite("save departed member snapshot", () =>
    pool.query(
      `INSERT INTO guild_departed_members (guild_id, discord_id, nickname, role_ids, left_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (guild_id, discord_id) DO UPDATE SET nickname = EXCLUDED.nickname, role_ids = EXCLUDED.role_ids, left_at = now()`,
      [guildId, discordId, nickname ?? null, roleIds ?? []]
    )
  );
}

async function getDepartedMemberSnapshot(guildId, discordId) {
  const { rows } = await pool.query(
    `SELECT nickname, role_ids FROM guild_departed_members WHERE guild_id = $1 AND discord_id = $2`,
    [guildId, discordId]
  );
  if (!rows[0]) return null;
  return { nickname: rows[0].nickname, roleIds: rows[0].role_ids ?? [] };
}

async function clearDepartedMemberSnapshot(guildId, discordId) {
  await pool.query(`DELETE FROM guild_departed_members WHERE guild_id = $1 AND discord_id = $2`, [guildId, discordId]);
}

// A snapshot is only ever cleared by a rejoin (see clearDepartedMemberSnapshot
// above) - a member who never comes back leaves a permanent row otherwise.
// Called from a daily sweep in index.js.
async function pruneStaleDepartedMemberSnapshots(maxAgeMs) {
  await pool.query(
    `DELETE FROM guild_departed_members WHERE left_at < now() - ($1::text || ' milliseconds')::interval`,
    [maxAgeMs]
  );
}

// Partial update - only the keys present in `patch` are touched, so the
// dashboard can save one field (e.g. just the log channel) without
// clobbering everything else. Returns the merged config immediately
// (before the write is queued) so the caller/API response reflects it
// right away instead of waiting on the DB round trip.
function updateGuildConfig(guildId, patch) {
  const current = getGuildConfig(guildId);
  const merged = { ...current, ...patch };
  state.guildConfigs[guildId] = merged;

  const setClauses = [];
  const params = [guildId];
  for (const [jsKey, column] of Object.entries(GUILD_CONFIG_COLUMNS)) {
    if (!(jsKey in patch)) continue;
    params.push(
      ["rankRoleIds", "warnRoleIds"].includes(jsKey) ? JSON.stringify(patch[jsKey]) : patch[jsKey]
    );
    setClauses.push(`${column} = $${params.length}`);
  }
  if (!setClauses.length) return Promise.resolve(merged);

  return queueWrite("update guild config", () =>
    pool.query(
      `INSERT INTO guild_config (guild_id) VALUES ($1)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId]
    ).then(() =>
      pool.query(
        `UPDATE guild_config SET ${setClauses.join(", ")}, updated_at = now() WHERE guild_id = $1`,
        params
      )
    )
  ).then(() => merged);
}

// Reads for the web dashboard's API - these bypass the in-memory `state`
// cache (unlike most of this file) and query Postgres directly, since the
// dashboard wants this guild's current data on every request rather than
// whatever was loaded at last boot/reload.

async function getGuildMembersForApi(guildId) {
  const { rows } = await pool.query(
    `SELECT gm.discord_id, u.username, gm.current_rank, gm.active_warnings, gm.total_warnings
     FROM guild_members gm
     LEFT JOIN users u ON u.discord_id = gm.discord_id
     WHERE gm.guild_id = $1
     ORDER BY gm.current_rank DESC NULLS LAST, u.username`,
    [guildId]
  );
  return rows.map((row) => ({
    discordId: row.discord_id,
    username: row.username ?? row.discord_id,
    rank: row.current_rank,
    activeWarnings: row.active_warnings,
    totalWarnings: row.total_warnings
  }));
}

async function getAuditLogForGuild(guildId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, log_type, user_id, old_rank, new_rank, administrator_id, reason, warn_action, warning_reason, created_at
     FROM user_logs WHERE guild_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [guildId, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    logType: row.log_type,
    userId: row.user_id,
    oldRank: row.old_rank,
    newRank: row.new_rank,
    administratorId: row.administrator_id,
    reason: row.reason,
    warnAction: row.warn_action,
    warningReason: row.warning_reason,
    createdAt: isoDate(row.created_at)
  }));
}

async function getAfkSessionsForApi(guildId) {
  return getActiveGameAfkSessions(guildId);
}

async function getTicketsForGuild(guildId, category) {
  const { rows } = await pool.query(
    category
      ? `SELECT * FROM tickets WHERE guild_id = $1 AND category = $2 ORDER BY created_at DESC`
      : `SELECT * FROM tickets WHERE guild_id = $1 ORDER BY created_at DESC`,
    category ? [guildId, category] : [guildId]
  );
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    ticketKey: row.ticket_key,
    uid: row.uid,
    userId: row.user_id,
    status: row.status,
    requestType: row.request_type,
    departmentName: row.department_name,
    icName: row.ic_name,
    characterLevel: row.character_level,
    characterStaticId: row.character_static_id,
    captRole: row.capt_role,
    oocAge: row.ooc_age,
    details: row.details,
    charactersLink: row.characters_link,
    customAnswers: row.custom_answers?.length ? row.custom_answers : null,
    claimedBy: row.claimed_by,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    closedAt: isoDate(row.closed_at)
  }));
}

async function getBansForGuild(guildId) {
  const { rows } = await pool.query(
    `SELECT id, discord_user_id, character_name, reason, issued_by, created_at
     FROM bans WHERE guild_id = $1 ORDER BY created_at DESC`,
    [guildId]
  );
  return rows.map((row) => ({
    id: row.id,
    discordUserId: row.discord_user_id,
    characterName: row.character_name,
    reason: row.reason,
    issuedBy: row.issued_by,
    createdAt: isoDate(row.created_at)
  }));
}

async function addBanForGuild(guildId, { discordUserId, characterName, reason, issuedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bans (guild_id, discord_user_id, character_name, reason, issued_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [guildId, discordUserId || null, characterName || null, reason, issuedBy]
  );
  return { id: rows[0].id, createdAt: isoDate(rows[0].created_at) };
}

async function removeBanForGuild(guildId, banId) {
  await pool.query(`DELETE FROM bans WHERE guild_id = $1 AND id = $2`, [guildId, banId]);
}

function departmentRowToApi(row) {
  return {
    id: row.id,
    name: row.name,
    memberDiscordIds: row.member_discord_ids ?? [],
    recruitmentOpen: row.recruitment_open,
    questions: row.questions ?? []
  };
}

async function getDepartmentsForGuild(guildId) {
  const { rows } = await pool.query(
    `SELECT id, name, member_discord_ids, recruitment_open, questions FROM guild_departments WHERE guild_id = $1 ORDER BY id`,
    [guildId]
  );
  return rows.map(departmentRowToApi);
}

async function getDepartmentById(guildId, departmentId) {
  const { rows } = await pool.query(
    `SELECT id, name, member_discord_ids, recruitment_open, questions FROM guild_departments WHERE guild_id = $1 AND id = $2`,
    [guildId, departmentId]
  );
  return rows[0] ? departmentRowToApi(rows[0]) : null;
}

async function createDepartmentForGuild(guildId, name) {
  const { rows } = await pool.query(
    `INSERT INTO guild_departments (guild_id, name) VALUES ($1, $2) RETURNING id, name, member_discord_ids, recruitment_open, questions`,
    [guildId, name]
  );
  return departmentRowToApi(rows[0]);
}

async function deleteDepartmentForGuild(guildId, departmentId) {
  await pool.query(`DELETE FROM guild_departments WHERE guild_id = $1 AND id = $2`, [guildId, departmentId]);
}

// Questions are capped at 4 here too (not just in the dashboard UI) since a
// 5th modal field is always the fixed IC-name/level/Static-ID one.
async function updateDepartmentForGuild(guildId, departmentId, { memberDiscordIds, recruitmentOpen, questions }) {
  const setClauses = [];
  const params = [guildId, departmentId];
  if (memberDiscordIds !== undefined) {
    params.push(memberDiscordIds);
    setClauses.push(`member_discord_ids = $${params.length}`);
  }
  if (recruitmentOpen !== undefined) {
    params.push(recruitmentOpen);
    setClauses.push(`recruitment_open = $${params.length}`);
  }
  if (questions !== undefined) {
    params.push(JSON.stringify(questions.slice(0, 4)));
    setClauses.push(`questions = $${params.length}::jsonb`);
  }
  if (!setClauses.length) return getDepartmentById(guildId, departmentId);
  const { rows } = await pool.query(
    `UPDATE guild_departments SET ${setClauses.join(", ")} WHERE guild_id = $1 AND id = $2
     RETURNING id, name, member_discord_ids, recruitment_open, questions`,
    params
  );
  return rows[0] ? departmentRowToApi(rows[0]) : null;
}

// Called when an application into a department is accepted - appends
// without needing the caller to read-modify-write the member list itself
// (and without racing a concurrent accept in the same department).
async function addMemberToDepartment(guildId, departmentId, discordUserId) {
  await pool.query(
    `UPDATE guild_departments
     SET member_discord_ids = array_append(member_discord_ids, $3)
     WHERE guild_id = $1 AND id = $2 AND NOT ($3 = ANY(member_discord_ids))`,
    [guildId, departmentId, discordUserId]
  );
}

function getApplications() { return state.applications; }
function getUserDb() { return state.users; }
function getRankHistory() { return state.ranks; }
function getSupportTickets() { return state.supportTickets; }

async function getActiveGameAfkSessions(guildId) {
  const { rows } = await pool.query(
    `SELECT user_id, reason, started_at, expires_at
     FROM afk_sessions
     WHERE guild_id = $1 AND expires_at > now()
     ORDER BY expires_at, started_at`,
    [guildId]
  );
  return rows.map((row) => ({
    userId: row.user_id,
    reason: row.reason,
    startedAt: isoDate(row.started_at),
    expiresAt: isoDate(row.expires_at)
  }));
}

async function getGameAfkSession(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT user_id, reason, started_at, expires_at
     FROM afk_sessions WHERE guild_id = $1 AND user_id = $2 LIMIT 1`,
    [guildId, String(userId)]
  );
  const row = rows[0];
  return row ? {
    userId: row.user_id,
    reason: row.reason,
    startedAt: isoDate(row.started_at),
    expiresAt: isoDate(row.expires_at)
  } : null;
}

async function saveGameAfkSession({ guildId, userId, reason, startedAt, expiresAt }) {
  await pool.query(
    `INSERT INTO afk_sessions (guild_id, user_id, reason, started_at, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       started_at = EXCLUDED.started_at,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [guildId, String(userId), reason, pgTimestamp(startedAt), pgTimestamp(expiresAt)]
  );
}

async function removeGameAfkSession(guildId, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT user_id, reason, started_at, expires_at
       FROM afk_sessions WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
      [guildId, String(userId)]
    );
    if (!rows.length) {
      await client.query("COMMIT");
      return null;
    }
    await client.query("DELETE FROM afk_sessions WHERE guild_id = $1 AND user_id = $2", [guildId, String(userId)]);
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

async function takeExpiredGameAfkSessions(guildId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT user_id, reason, started_at, expires_at
       FROM afk_sessions
       WHERE guild_id = $1 AND expires_at <= now()
       ORDER BY expires_at
       FOR UPDATE`,
      [guildId]
    );
    if (rows.length) {
      await client.query("DELETE FROM afk_sessions WHERE guild_id = $1 AND expires_at <= now()", [guildId]);
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
         (category, guild_id, ticket_key, uid, user_id, status, request_type, department_name, ic_name,
          character_level, character_static_id, capt_role, ooc_age, details, characters_link, custom_answers,
          claimed_by, decided_by, decision_reason,
          channel_id, message_id, announcement_channel_id, announcement_message_id,
          created_at, updated_at, closed_at)
         VALUES ('application', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
        [application.guildId ?? null, applicationKey, application.uid ?? null, application.userId,
          application.status ?? "new", application.requestType ?? "rp", application.departmentName ?? null,
          characterParts[0] || null,
          characterParts[1] || null, characterParts[2] || null, application.captRole ?? null,
          application.oocAge ?? null,
          application.reason ?? null,
          application.charactersLink ?? null,
          JSON.stringify(application.customAnswers ?? []),
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
         (category, guild_id, ticket_key, uid, user_id, status, request_type, details,
          claimed_by, decided_by, decision_reason, channel_id, message_id,
          created_at, updated_at, closed_at)
         VALUES ('support', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [ticket.guildId ?? null, ticket.id ?? ticketId, ticket.uid ?? null, ticket.userId,
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
  addBanForGuild,
  addMemberToDepartment,
  clearDepartedMemberSnapshot,
  closeStorage,
  createDepartmentForGuild,
  deleteDepartmentForGuild,
  deleteUserProfile,
  flushStorage,
  getActiveGameAfkSessions,
  getAfkSessionsForApi,
  getApplications,
  getAuditLogForGuild,
  getAutomodFilterConfig,
  getAutomodFilterConfigsForGuild,
  getBansForGuild,
  getDepartedMemberSnapshot,
  getDepartmentById,
  getDepartmentsForGuild,
  getGameAfkSession,
  getGuildConfig,
  getGuildMembersForApi,
  getRankHistory,
  getSecuritySettings,
  getSupportTickets,
  getTicketsForGuild,
  getUserDb,
  getWarnings,
  initStorage,
  pruneStaleDepartedMemberSnapshots,
  reloadStorage,
  removeBanForGuild,
  removeGameAfkSession,
  saveApplications,
  saveDepartedMemberSnapshot,
  saveGameAfkSession,
  saveRankHistory,
  saveSupportTickets,
  saveUserDb,
  saveWarnings,
  syncUserProfile,
  takeExpiredGameAfkSessions,
  updateAutomodFilterConfig,
  updateDepartmentForGuild,
  updateGuildConfig,
  updateSecuritySettings,
  upsertGuild
};
