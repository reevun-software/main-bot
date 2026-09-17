// Minimal HTTP API so the web dashboard can read/write bot-owned data
// (config, members, warnings, tickets, afk sessions, bans) instead of that
// data living only in the bot's own database with no UI, or worse, the
// dashboard keeping a second copy of it that the bot never writes to.
// Reachable only over Railway's private network (main-bot.railway.internal
// is not resolvable from the public internet), plus a shared-secret header
// as defense in depth. No framework - this repo has stayed
// dependency-light on purpose, and the route count doesn't need one yet.
const http = require("node:http");
const {
  addBanForGuild,
  createDepartmentForGuild,
  deleteDepartmentForGuild,
  getAfkSessionsForApi,
  getAuditLogForGuild,
  getAutomodFilterConfig,
  getAutomodFilterConfigsForGuild,
  getBansForGuild,
  getDepartmentsForGuild,
  getGuildConfig,
  getGuildMembersForApi,
  getSecuritySettings,
  getTicketsForGuild,
  removeBanForGuild,
  updateAutomodFilterConfig,
  updateDepartmentForGuild,
  updateGuildConfig,
  updateSecuritySettings
} = require("./storage");

const PATCHABLE_CONFIG_FIELDS = new Set([
  "leadershipRoleIds",
  "rankRoleIds",
  "warnRoleIds",
  "verifiedMemberRoleId",
  "logChannelId",
  "applicationsChannelId",
  "applicationPanelChannelId",
  "supportPanelChannelId",
  "adminPanelChannelId",
  "departmentsEnabled",
  "warnPunishmentMode",
  "warnPunishmentRoleId",
  "defaultRoleIds",
  "alwaysAssignDefaultRoles",
  "restoreNicknameOnRejoin",
  "restoreOldRolesOnRejoin",
  "restorableRoleIds",
  "exemptRoleIds",
  "enableSlashCommands",
  "enableTextCommands",
  "systemMessageColor"
]);

const PATCHABLE_SECURITY_FIELDS = new Set([
  "moderatorRoleIds",
  "ignoreCommandCooldownForMods",
  "allowHigherModsToModerateLower",
  "filterLinks",
  "filterInvites",
  "filterScamLinks",
  "filterBadWords",
  "filterCapsLock",
  "filterMentionSpam",
  "muteMode",
  "muteRoleId",
  "muteBlocksReactions"
]);

const PATCHABLE_AUTOMOD_FIELDS = new Set([
  "deleteMessage",
  "punishment",
  "strategy",
  "list",
  "notifyUser",
  "ignoreAdminsAndMods",
  "ignoreSlashCommands",
  "targetRoleIds",
  "ignoredRoleIds",
  "targetChannelIds",
  "ignoredChannelIds"
]);

// These flow into === comparisons in the bot's own mute/automod logic - an
// unrecognized value there doesn't crash, it just silently no-ops (e.g. a
// mute_mode of "banana" mutes nobody), which is worse than rejecting it here
// at the boundary between this API and whatever calls it.
const MUTE_MODES = new Set(["role", "timeout", "both"]);
const AUTOMOD_PUNISHMENTS = new Set(["none", "warn", "mute", "kick", "ban"]);
const AUTOMOD_STRATEGIES = new Set(["blocklist", "allowlist"]);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function isAuthorized(req) {
  const secret = process.env.BOT_API_SECRET;
  if (!secret) return false; // fail closed - no secret configured means no API access, not open access
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${secret}`;
}

function roleSummary(role) {
  return { id: role.id, name: role.name, color: role.color, position: role.position, managed: role.managed };
}

function channelSummary(channel) {
  return { id: channel.id, name: channel.name, type: channel.type };
}

async function handleConfig(client, req, res, guildId) {
  if (req.method === "GET") return sendJson(res, 200, getGuildConfig(guildId));
  if (req.method === "PUT") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const patch = {};
    for (const key of Object.keys(body)) {
      if (PATCHABLE_CONFIG_FIELDS.has(key)) patch[key] = body[key];
    }
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: "No recognized fields in body" });
    return sendJson(res, 200, await updateGuildConfig(guildId, patch));
  }
  return sendJson(res, 405, { error: "Method not allowed" });
}

async function handleBans(req, res, guildId) {
  if (req.method === "GET") return sendJson(res, 200, await getBansForGuild(guildId));
  if (req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    if (!body.reason || (!body.discordUserId && !body.characterName) || !body.issuedBy) {
      return sendJson(res, 400, { error: "reason, issuedBy, and one of discordUserId/characterName are required" });
    }
    return sendJson(res, 201, await addBanForGuild(guildId, body));
  }
  return sendJson(res, 405, { error: "Method not allowed" });
}

async function handleDepartments(req, res, guildId, departmentId) {
  if (departmentId) {
    if (req.method === "PATCH") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const patch = {};
      if (Array.isArray(body.memberDiscordIds)) patch.memberDiscordIds = body.memberDiscordIds;
      if (typeof body.recruitmentOpen === "boolean") patch.recruitmentOpen = body.recruitmentOpen;
      if (Array.isArray(body.questions)) {
        patch.questions = body.questions
          .filter((q) => q && typeof q.label === "string" && q.label.trim())
          .slice(0, 4)
          .map((q) => ({
            id: String(q.id ?? Math.random().toString(36).slice(2)),
            label: q.label.slice(0, 45),
            style: q.style === "paragraph" ? "paragraph" : "short",
            required: q.required !== false
          }));
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: "No recognized fields in body" });
      const updated = await updateDepartmentForGuild(guildId, departmentId, patch);
      if (!updated) return sendJson(res, 404, { error: "Department not found" });
      return sendJson(res, 200, updated);
    }
    if (req.method === "DELETE") {
      await deleteDepartmentForGuild(guildId, departmentId);
      res.writeHead(204).end();
      return;
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (req.method === "GET") return sendJson(res, 200, await getDepartmentsForGuild(guildId));
  if (req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const name = String(body.name ?? "").trim();
    if (!name) return sendJson(res, 400, { error: "name is required" });
    return sendJson(res, 201, await createDepartmentForGuild(guildId, name));
  }
  return sendJson(res, 405, { error: "Method not allowed" });
}

async function handleSecurity(req, res, guildId) {
  if (req.method === "GET") return sendJson(res, 200, getSecuritySettings(guildId));
  if (req.method === "PUT") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const patch = {};
    for (const key of Object.keys(body)) {
      if (!PATCHABLE_SECURITY_FIELDS.has(key)) continue;
      if (key === "muteMode" && !MUTE_MODES.has(body[key])) continue;
      patch[key] = body[key];
    }
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: "No recognized fields in body" });
    return sendJson(res, 200, await updateSecuritySettings(guildId, patch));
  }
  return sendJson(res, 405, { error: "Method not allowed" });
}

async function handleAutomod(req, res, guildId, filterType) {
  if (filterType) {
    if (req.method === "GET") return sendJson(res, 200, getAutomodFilterConfig(guildId, filterType));
    if (req.method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const patch = {};
      for (const key of Object.keys(body)) {
        if (!PATCHABLE_AUTOMOD_FIELDS.has(key)) continue;
        if (key === "punishment" && !AUTOMOD_PUNISHMENTS.has(body[key])) continue;
        if (key === "strategy" && !AUTOMOD_STRATEGIES.has(body[key])) continue;
        patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: "No recognized fields in body" });
      return sendJson(res, 200, await updateAutomodFilterConfig(guildId, filterType, patch));
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  return sendJson(res, 200, getAutomodFilterConfigsForGuild(guildId));
}

async function handleApiRequest(client, req, res, url) {
  if (!isAuthorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

  const segments = url.pathname.split("/").filter(Boolean); // ["api", "guilds", ":id", resource, ...rest]

  // Not guild-scoped: which guilds is the bot actually in right now. The
  // dashboard's "is the bot installed here" check used to read the web
  // app's own guilds table, which nothing ever wrote to - this is the live
  // answer, straight from Discord.js's own cache, always current.
  if (segments[0] === "api" && segments[1] === "bot-guilds" && segments.length === 2) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    return sendJson(res, 200, [...client.guilds.cache.values()].map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      ownerDiscordId: guild.ownerId
    })));
  }

  if (segments[0] !== "api" || segments[1] !== "guilds" || !/^\d+$/.test(segments[2] ?? "")) {
    return sendJson(res, 404, { error: "Not found" });
  }
  const guildId = segments[2];
  const resource = segments[3];
  const rest = segments.slice(4);

  if (resource === "config") return handleConfig(client, req, res, guildId);
  if (resource === "bans" && rest.length === 0) return handleBans(req, res, guildId);
  if (resource === "bans" && rest.length === 1 && req.method === "DELETE") {
    await removeBanForGuild(guildId, rest[0]);
    res.writeHead(204).end();
    return;
  }
  if (resource === "departments" && rest.length <= 1) return handleDepartments(req, res, guildId, rest[0]);
  if (resource === "security") return handleSecurity(req, res, guildId);
  if (resource === "automod" && rest.length <= 1) return handleAutomod(req, res, guildId, rest[0]);

  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });

  if (resource === "members") return sendJson(res, 200, await getGuildMembersForApi(guildId));
  if (resource === "audit-log") return sendJson(res, 200, await getAuditLogForGuild(guildId, Number(url.searchParams.get("limit")) || 50));
  if (resource === "afk-sessions") return sendJson(res, 200, await getAfkSessionsForApi(guildId));
  if (resource === "tickets") return sendJson(res, 200, await getTicketsForGuild(guildId, url.searchParams.get("category") || undefined));

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return sendJson(res, 404, { error: "Bot is not in that guild" });

  if (resource === "roles") return sendJson(res, 200, [...guild.roles.cache.values()].map(roleSummary));
  if (resource === "channels") {
    return sendJson(res, 200, [...guild.channels.cache.values()].filter((c) => c.isTextBased() && !c.isThread()).map(channelSummary));
  }

  return sendJson(res, 404, { error: "Not found" });
}

function startApiAndHealthServer(client) {
  const port = Number(process.env.PORT) || 3000;
  http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      const ok = client.isReady();
      res.writeHead(ok ? 200 : 503).end(ok ? "OK" : "NOT READY");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      handleApiRequest(client, req, res, url).catch((error) => {
        console.error("API request failed:", error);
        sendJson(res, 500, { error: "Internal error" });
      });
      return;
    }
    res.writeHead(404).end();
  }).listen(port, () => console.log(`Health check + API listening on :${port}`));
}

module.exports = { startApiAndHealthServer };
