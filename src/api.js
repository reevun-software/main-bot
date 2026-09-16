// Minimal HTTP API so the web dashboard can read/write per-guild bot
// config (roles, channels) instead of that data living only in the bot's
// own database with no UI. Reachable only over Railway's private network
// (main-bot.railway.internal is not resolvable from the public internet),
// plus a shared-secret header as defense in depth. No framework - a
// handful of routes doesn't need one, and this repo has stayed
// dependency-light on purpose.
const http = require("node:http");
const { getGuildConfig, updateGuildConfig } = require("./storage");

const PATCHABLE_FIELDS = new Set([
  "leadershipRoleIds",
  "rankRoleIds",
  "warnRoleIds",
  "verifiedMemberRoleId",
  "logChannelId",
  "applicationsChannelId",
  "applicationPanelChannelId",
  "supportPanelChannelId",
  "adminPanelChannelId"
]);

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

async function handleApiRequest(client, req, res, url) {
  if (!isAuthorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

  const guildMatch = url.pathname.match(/^\/api\/guilds\/(\d+)\/(config|roles|channels)$/);
  if (!guildMatch) return sendJson(res, 404, { error: "Not found" });
  const [, guildId, resource] = guildMatch;

  if (resource === "config") {
    if (req.method === "GET") {
      return sendJson(res, 200, getGuildConfig(guildId));
    }
    if (req.method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const patch = {};
      for (const key of Object.keys(body)) {
        if (PATCHABLE_FIELDS.has(key)) patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: "No recognized fields in body" });
      const updated = await updateGuildConfig(guildId, patch);
      return sendJson(res, 200, updated);
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return sendJson(res, 404, { error: "Bot is not in that guild" });

  if (resource === "roles") {
    return sendJson(res, 200, [...guild.roles.cache.values()].map(roleSummary));
  }
  if (resource === "channels") {
    return sendJson(res, 200, [...guild.channels.cache.values()].filter((c) => c.isTextBased() && !c.isThread()).map(channelSummary));
  }
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
