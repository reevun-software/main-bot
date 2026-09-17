require("dotenv").config();

const crypto = require("node:crypto");
const { startApiAndHealthServer } = require("./api");
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  AuditLogEvent,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { globalCommands: slashCommandDefinitions } = require("./register-commands");
const {
  addMemberToDepartment,
  clearDepartedMemberSnapshot,
  closeStorage,
  deleteUserProfile,
  flushStorage,
  getActiveGameAfkSessions,
  getApplications,
  getAutomodFilterConfig,
  getDepartedMemberSnapshot,
  getDepartmentById,
  getDepartmentsForGuild,
  getGameAfkSession,
  getGuildConfig,
  getRankHistory,
  getSecuritySettings,
  getSupportTickets,
  getUserDb,
  getWarnings,
  initStorage,
  reloadStorage,
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
  updateDepartmentForGuild,
  upsertGuild
} = require("./storage");

const applicationEmojis = require("./application-emojis.json");

function applicationEmoji(name) {
  return applicationEmojis[name] ?? applicationEmojis.notice;
}

function applicationEmojiMention(name) {
  const emoji = applicationEmoji(name);
  return `<:${emoji.name}:${emoji.id}>`;
}

function loadingMessage(text) {
  return `${applicationEmojiMention("loading")} | ${text}`;
}

function successMessage(text) {
  return `${applicationEmojiMention("confirm")} | ${text}`;
}

function errorMessage(text) {
  return `${applicationEmojiMention("cancel")} | ${text}`;
}

function noticeMessage(text) {
  return `${applicationEmojiMention("notice")} | ${text}`;
}

function adminActionResult(title, completed = [], failed = []) {
  const sections = [];
  if (completed.length) {
    sections.push(`**${title}:**\n${completed.map((line) => `• ${line}`).join("\n")}`);
  }
  if (failed.length) {
    sections.push(`**Не выполнено:**\n${failed.map((line) => `• ${line}`).join("\n")}`);
  }
  const content = sections.join("\n\n") || "Изменения не применены.";
  return completed.length ? successMessage(content) : noticeMessage(content);
}

function modalCustomId(...parts) {
  return [...parts, crypto.randomBytes(5).toString("hex")].join(":");
}

const pendingConfirmations = new Map();
const activeAfkPanels = new Map();

function confirmationPayload(id, text) {
  return {
    content: text,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`action-confirm:${id}`)
        .setLabel("Подтвердить")
        .setEmoji(applicationEmoji("confirm"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`action-cancel:${id}`)
        .setLabel("Отменить")
        .setEmoji(applicationEmoji("cancel"))
        .setStyle(ButtonStyle.Secondary)
    )],
    flags: MessageFlags.Ephemeral
  };
}

function confirmationText(interaction) {
  if (interaction._confirmed) return null;
  if (interaction.isChatInputCommand()) {
    const command = interaction.commandName;
    if (command === "move" && isLeadership(interaction.member)) {
      return `Вы уверены, что хотите переместить всех участников из ${interaction.options.getChannel("from", true)} в ${interaction.options.getChannel("to", true)}?`;
    }
    return null;
  }
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id.startsWith("support:close:") && isSupportReviewer(interaction.member)) {
      const uid = id.slice("support:close:".length);
      const ticket = Object.values(getSupportTickets()).find((item) => item.uid === uid);
      // rank_change opens a confirmation modal, warn_removal asks a domain-specific
      // yes/no question instead — both replace the generic confirm step here.
      if (ticket?.requestType === "rank_change" || ticket?.requestType === "warn_removal") return null;
      return "Вы уверены, что хотите закрыть это обращение?";
    }
    if (id === "game_afk:return") return "Вы уверены, что хотите вернуться из AFK?";
    return null;
  }
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (id.startsWith("application:reject-reason:")) return "Вы уверены, что хотите отклонить эту заявку?";
  }
  return null;
}

function confirmedInteraction(original, button) {
  const normalize = (payload) => {
    const normalized = typeof payload === "string" ? { content: payload } : { ...payload };
    delete normalized.flags;
    if (!Object.hasOwn(normalized, "components")) normalized.components = [];
    return normalized;
  };
  return new Proxy(original, {
    get(target, property) {
      if (property === "_confirmed") return true;
      if (property === "reply") return (payload) => button.update(normalize(payload));
      if (property === "deferReply" || property === "deferUpdate") {
        return () => button.update({
          content: loadingMessage("Пожалуйста, подождите, действие выполняется..."),
          components: []
        });
      }
      if (property === "editReply") return (payload) => button.editReply(normalize(payload));
      if (property === "followUp") return (payload) => button.editReply(normalize(payload));
      if (property === "showModal") {
        return async (modal) => {
          await button.showModal(modal);
          await button.deleteReply().catch(() => null);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function requestActionConfirmation(interaction, text) {
  const now = Date.now();
  for (const [pendingId, pending] of pendingConfirmations) {
    if (pending.expiresAt < now) pendingConfirmations.delete(pendingId);
  }
  const id = crypto.randomBytes(8).toString("hex");
  pendingConfirmations.set(id, {
    interaction,
    ownerId: interaction.user.id,
    expiresAt: now + 5 * 60 * 1000
  });
  await interaction.reply(confirmationPayload(id, text));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  presence: {
    status: "online",
    activities: [{ name: "Custom Status", state: "reevun.app", type: ActivityType.Custom }]
  }
});

const APPLICATION_REJECTION_COOLDOWN_MS = 10 * 24 * 60 * 60 * 1000;
const SUPPORT_REQUEST_TYPES = {
  bonus: "Заявка на получение премии",
  vacation: "Заявка на отпуск",
  rank_change: "Заявка на изменение ранга",
  warn_removal: "Заявка на снятие варна",
  suggestion: "Предложение",
  other: "Другое"
};
const SUPPORT_TYPE_FIELDS = {
  bonus: [
    {
      id: "event_type",
      label: "Тип мероприятия",
      placeholder: "Напишите название мероприятия",
      style: TextInputStyle.Short,
      minLength: 2,
      maxLength: 200
    },
    {
      id: "event_datetime",
      label: "Дата и время проведения",
      placeholder: "ДД.ММ.ГГГГ, ЧЧ:ММ",
      style: TextInputStyle.Short,
      minLength: 2,
      maxLength: 100
    }
  ],
  vacation: [
    {
      id: "ic_ooc",
      label: "IC или OOC",
      placeholder: "Укажите: IC или OOC",
      style: TextInputStyle.Short,
      minLength: 2,
      maxLength: 10
    },
    {
      id: "dates",
      label: "Даты отпуска",
      placeholder: "ДД.ММ.ГГГГ – ДД.ММ.ГГГГ",
      style: TextInputStyle.Short,
      minLength: 2,
      maxLength: 100
    },
    {
      id: "reason",
      label: "Причина отпуска",
      placeholder: "Опишите причину отпуска",
      style: TextInputStyle.Paragraph,
      minLength: 2,
      maxLength: 1000
    }
  ],
  rank_change: [
    {
      id: "replay_link",
      label: "Ссылка на откат",
      placeholder: "5 минут игры, полное лобби, Сайга + тяжка",
      style: TextInputStyle.Short,
      minLength: 5,
      maxLength: 300,
      isLink: true
    },
    {
      id: "events_folder",
      label: "Папка со скриншотами (25 мероприятий)",
      placeholder: "Google Диск или Яндекс Диск",
      style: TextInputStyle.Short,
      minLength: 5,
      maxLength: 300,
      isLink: true
    }
  ],
  warn_removal: [
    {
      id: "condition",
      label: "Какое условие для снятия варна выполнено?",
      placeholder: "Например: 20 карабинов MK2 на склад семьи, или 25 мероприятий",
      style: TextInputStyle.Short,
      minLength: 2,
      maxLength: 200
    },
    {
      id: "condition_proof",
      label: "Ссылка на подтверждение условия",
      placeholder: "Google Диск или Яндекс Диск",
      style: TextInputStyle.Short,
      minLength: 5,
      maxLength: 300,
      isLink: true
    }
  ],
  suggestion: [
    {
      id: "details",
      label: "Ваше предложение",
      placeholder: "Опишите ваше предложение подробно",
      style: TextInputStyle.Paragraph,
      minLength: 2,
      maxLength: 4000
    }
  ],
  other: [
    {
      id: "details",
      label: "Детали заявки",
      placeholder: "Подробно опишите вашу заявку",
      style: TextInputStyle.Paragraph,
      minLength: 2,
      maxLength: 4000
    }
  ]
};
const GAME_AFK_SWEEP_INTERVAL_MS = 30 * 1000;
const STORAGE_RELOAD_INTERVAL_MS = 60 * 1000;
const GAME_AFK_MAX_HOURS = 4;
const botRankChanges = new Map();

function isLeadership(member) {
  if (!member?.roles?.cache || !member.guild) return false;
  const { leadershipRoleIds } = getGuildConfig(member.guild.id);
  return leadershipRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function isApplicationReviewer(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)) || isLeadership(member);
}

// moderator_role_ids (dashboard: Security page) extends who can run the
// warn/mute/kick-style moderation actions specifically - not rank
// management, recruitment, or application review, which stay leadership-only.
// ignoreCommandCooldownForMods and allowHigherModsToModerateLower have
// nothing to hook into yet: this bot has no per-user command cooldown and
// no role-hierarchy check on moderation actions at all, so both settings
// are accepted and stored but currently no-ops.
function isModerator(member) {
  if (isLeadership(member)) return true;
  if (!member?.roles?.cache || !member.guild) return false;
  const { moderatorRoleIds } = getSecuritySettings(member.guild.id);
  return moderatorRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function isSupportReviewer(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)) || isLeadership(member);
}

function applicantLockedOverwriteOptions() {
  const options = {
    ViewChannel: true,
    ReadMessageHistory: true
  };

  for (const name of Object.keys(PermissionFlagsBits)) {
    if (!["Administrator", "ViewChannel", "ReadMessageHistory"].includes(name)) {
      options[name] = false;
    }
  }

  return options;
}

function createTicketUid(prefix, ...collections) {
  const alphabet = "0123456789";
  const existingUids = new Set(
    collections.flatMap((items) =>
      Object.values(items).flatMap((item) => [item.uid, item.id].filter(Boolean))
    )
  );
  let uid = "";
  do {
    const code = Array.from(
      { length: 10 },
      () => alphabet[crypto.randomInt(0, alphabet.length)]
    ).join("");
    uid = `${prefix}-${code}`;
  } while (existingUids.has(uid));
  return uid;
}

function applicationButtons(application) {
  const isClosed = ["accepted", "rejected", "closed"].includes(application.status);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`application:accept:${application.uid}`)
        .setLabel("Принять")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId(`application:reject:${application.uid}`)
        .setLabel("Отклонить")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId(`application:transfer:${application.uid}`)
        .setLabel("Передать")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed)
    )
  ];
}

function supportTicketButtons(ticket) {
  const isClosed = ticket.status === "closed";
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`support:close:${ticket.uid}`)
        .setLabel("Закрыть")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId(`support:transfer:${ticket.uid}`)
        .setLabel("Передать")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed)
    )
  ];
}

function findApplicationByUid(uid) {
  return Object.entries(getApplications()).find(
    ([, application]) => application.uid === uid
  ) ?? null;
}

function getLatestApplicationForUser(userId, applications = getApplications()) {
  return Object.values(applications)
    .filter((application) => application.userId === userId)
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0))[0] ?? null;
}

function applicationStatusLabel(status) {
  const labels = {
    new: "Новая заявка",
    in_review: "На рассмотрении",
    accepted: "Принята",
    rejected: "Отклонена",
    closed: "Закрыто"
  };
  return labels[status] ?? "Неизвестно";
}

function discordTimestampFromMs(timestampMs, style = "R") {
  return `<t:${Math.floor(timestampMs / 1000)}:${style}>`;
}

function getUserRecord(userId) {
  const users = getUserDb();
  users[userId] ??= { dmNotifications: true };
  users[userId].dmNotifications ??= true;
  saveUserDb(users);
  return users[userId];
}

async function updateUserRecord(userId, updater) {
  const users = getUserDb();
  users[userId] ??= { dmNotifications: true };
  users[userId].dmNotifications ??= true;
  updater(users[userId]);
  await saveUserDb(users);
  return users[userId];
}

async function addUserAudit(userId, type, entry) {
  const record = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString() };
  if (type === "warn") {
    const warnings = getWarnings();
    warnings[userId] ??= { active: [], history: [] };
    warnings[userId].active ??= [];
    warnings[userId].history ??= [];
    warnings[userId].history.push(record);
    await saveWarnings(warnings);
    return;
  }

  const history = getRankHistory();
  history[userId] ??= [];
  history[userId].push(record);
  await saveRankHistory(history);
}

function profileButtons(ownerId, targetId, rank) {
  const notificationsEnabled = getUserRecord(targetId).dmNotifications;
  const buttons = [
    new ButtonBuilder().setCustomId(`profile:warn:${ownerId}:${targetId}:0`).setLabel("История варнов").setEmoji(applicationEmoji("warnings")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`profile:rank:${ownerId}:${targetId}:0`).setLabel("История рангов").setEmoji(applicationEmoji("rank_history")).setStyle(ButtonStyle.Secondary)
  ];
  if (ownerId === targetId) buttons.push(
    new ButtonBuilder()
      .setCustomId(`profile:notify:${ownerId}:${targetId}:0`)
      .setLabel(notificationsEnabled ? "Уведомления: вкл." : "Уведомления: выкл.")
      .setEmoji(applicationEmoji(notificationsEnabled ? "notifications_on" : "notifications_off"))
      .setStyle(notificationsEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
  );
  return new ActionRowBuilder().addComponents(buttons);
}

function profileHistoryEntries(targetId, type) {
  const source = type === "warn"
    ? (getWarnings()[targetId]?.history ?? [])
    : (getRankHistory()[targetId] ?? []);
  return source.map((entry) => ({
    createdAt: entry.createdAt,
    text: type === "warn"
      ? `${entry.action === "add" ? "Выдан" : "Снят"} варн\nАдминистратор: ${entry.adminId === "system" ? "Система" : `<@${entry.adminId}>`}\nПричина: ${entry.reason ?? "Не указана"}${entry.warnReason ? `\nВарн: ${entry.warnReason}` : ""}`
      : `Ранг: **${entry.oldRank ?? "нет"} → ${entry.newRank}**\nАдминистратор: ${entry.adminId === "system" ? "Система" : `<@${entry.adminId}>`}\nПричина: ${entry.reason ?? "Не указана"}`
  }));
}

function buildProfileHistory(type, targetId, ownerId, requestedPage) {
  const titles = { warn: "История варнов", rank: "История рангов" };
  const entries = profileHistoryEntries(targetId, type).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pages = Math.max(1, Math.ceil(entries.length / 10));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const lines = entries.slice(page * 10, page * 10 + 10).map((entry, index) => {
    const timestamp = Date.parse(entry.createdAt);
    const date = Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:F>` : "Дата неизвестна";
    return `**${page * 10 + index + 1}. ${date}**\n${entry.text}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x000000)
    .setTitle(titles[type])
    .setDescription(lines.join("\n\n") || "История пока пуста.")
    .setFooter({ text: `Страница ${page + 1}/${pages} • Записей: ${entries.length}` });
  const components = [];
  if (pages > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile:${type}:${ownerId}:${targetId}:${page - 1}`).setLabel("Назад").setEmoji(applicationEmoji("back")).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`profile:${type}:${ownerId}:${targetId}:${page + 1}`).setLabel("Вперёд").setEmoji(applicationEmoji("forward")).setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1)
  ));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile:home:${ownerId}:${targetId}:0`).setLabel("К профилю").setEmoji(applicationEmoji("profile")).setStyle(ButtonStyle.Secondary)
  ));
  return embedToComponentPayload(embed, components);
}

// rank_role_ids is {"<rank>": {roleIds: [...], label, nicknamePrefix}} - an
// arbitrary-length, self-describing ladder (any rank count, any labels),
// not a fixed 1-7 structure, since a different family's rank ladder can
// look nothing like this one's.
function rankDefinitionsFor(guildId) {
  return getGuildConfig(guildId).rankRoleIds;
}

function rankOrderFor(guildId) {
  return Object.keys(rankDefinitionsFor(guildId)).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

function rankRoleIdsFor(guildId, rank) {
  return rankDefinitionsFor(guildId)[String(rank)]?.roleIds ?? [];
}

async function syncMemberRankRole(member, rank) {
  if (!member || !rank) return;
  const definitions = rankDefinitionsFor(member.guild.id);
  const configuredRoles = Object.values(definitions)
    .flatMap((def) => def.roleIds ?? [])
    .map((roleId) => member.guild.roles.cache.get(roleId))
    .filter(Boolean);
  const currentRankRoles = configuredRoles.filter((role) => member.roles.cache.has(role.id));
  // When a rank lists multiple roles, only the first one is ever
  // auto-assigned here. The rest are manual-only markers — an admin grants
  // them by hand and they still count toward that rank, but the bot never
  // adds them on its own. All of them are still removed automatically once
  // the member leaves that rank.
  const targetRoleIds = rankRoleIdsFor(member.guild.id, rank);
  const targetRoles = targetRoleIds
    .map((roleId) => member.guild.roles.cache.get(roleId))
    .filter(Boolean);
  if (!targetRoles.length) throw new Error(`Роль для ${rank} ранга не найдена на Discord-сервере.`);
  const primaryTargetRole = member.guild.roles.cache.get(targetRoleIds[0]);
  const unmanageableRole = [...new Set([...currentRankRoles, ...targetRoles])]
    .find((role) => !role.editable);
  if (unmanageableRole) {
    throw new Error(`Бот не может управлять ролью «${unmanageableRole.name}»: роль бота расположена ниже неё.`);
  }
  botRankChanges.set(member.id, Date.now() + 15_000);

  const targetRoleIdSet = new Set(targetRoles.map((role) => role.id));
  if (primaryTargetRole && !member.roles.cache.has(primaryTargetRole.id)) {
    await member.roles.add(primaryTargetRole);
  }
  for (const role of currentRankRoles) {
    if (!targetRoleIdSet.has(role.id)) await member.roles.remove(role.id);
  }
}

function getRankFromMemberRoles(member) {
  if (!member?.roles?.cache || !member.guild) return null;

  const ranks = Object.entries(rankDefinitionsFor(member.guild.id))
    .filter(([, def]) => (def.roleIds ?? []).some((id) => id && member.roles.cache.has(id)))
    .map(([rank]) => Number.parseInt(rank, 10))
    .filter(Number.isFinite);

  if (!ranks.length) return null;
  return Math.max(...ranks);
}

async function listGuildMembers(guild) {
  if (guild.members.cache.size >= guild.memberCount) {
    return [...guild.members.cache.values()];
  }
  const members = [];
  let after;
  let hasMore = true;

  while (hasMore) {
    const batch = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
    members.push(...batch.values());
    if (batch.size < 1000) {
      hasMore = false;
      continue;
    }

    const nextAfter = batch.lastKey();
    if (!nextAfter || nextAfter === after) {
      hasMore = false;
      continue;
    }
    after = nextAfter;
  }

  return members;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function resolveTicketTransferMember(guild, input) {
  const value = String(input ?? "").trim();
  const discordId = value.match(/\d{17,20}/)?.[0];
  if (discordId) {
    const member = await guild.members.fetch(discordId).catch(() => null);
    return member
      ? { member }
      : { error: "Участник с таким Discord ID не найден на сервере." };
  }

  const needle = normalizeSearchText(value);
  if (!needle) return { error: "Укажите Discord ID, упоминание или точный ник администратора." };

  const members = await listGuildMembers(guild);
  const matches = members.filter((member) => {
    if (member.user.bot) return false;
    return [
      member.displayName,
      member.user.username,
      member.user.globalName
    ].some((name) => normalizeSearchText(name) === needle);
  });

  if (!matches.length) return { error: "Администратор с таким ником не найден." };
  if (matches.length > 1) {
    return { error: "Найдено несколько участников с таким ником. Укажите Discord ID или упоминание." };
  }
  return { member: matches[0] };
}

function validateTicketTransferMember(member, ticket, scope) {
  if (!member || member.user.bot) return "Передать заявку этому участнику нельзя.";
  if (member.id === ticket.userId) return "Нельзя передать заявку её автору.";
  const allowed = scope === "application"
    ? isApplicationReviewer(member)
    : isSupportReviewer(member);
  if (!allowed) {
    return "Передать заявку можно только ответственной администрации.";
  }
  if (member.id === ticket.claimedBy) return "Эта заявка уже закреплена за указанным администратором.";
  return null;
}

function rankDisplayName(guildId, rank) {
  if (!rank) return "Не в фаме";
  return rankDefinitionsFor(guildId)[String(rank)]?.label ?? String(rank);
}

function rankNicknamePrefix(guildId, rank) {
  return rankDefinitionsFor(guildId)[String(rank)]?.nicknamePrefix ?? String(rank);
}

function formatFamilyNickname(guildId, rank, icName, staticId) {
  const normalizedName = String(icName ?? "").trim();
  const normalizedStaticId = String(staticId ?? "").trim();
  if (!rank || !normalizedName || !normalizedStaticId) return null;
  const prefix = `${rankNicknamePrefix(guildId, rank)} | `;
  const suffix = ` | ${normalizedStaticId}`;
  const availableNameLength = 32 - prefix.length - suffix.length;
  if (availableNameLength < 1) return null;
  return `${prefix}${normalizedName.slice(0, availableNameLength).trim()}${suffix}`;
}

function buildFamilyNickname(guildId, rank, characterInfo) {
  const [icName, , staticId] = String(characterInfo ?? "")
    .split("/")
    .map((part) => part.trim());
  return formatFamilyNickname(guildId, rank, icName, staticId);
}

function memberNicknameIdentity(member) {
  const nicknameParts = String(member?.nickname ?? "").split("|").map((part) => part.trim());
  if (nicknameParts.length >= 3) {
    const staticId = nicknameParts.at(-1);
    const icName = nicknameParts.slice(1, -1).join(" | ");
    if (icName && staticId) return { icName, staticId };
  }

  const application = Object.values(getApplications())
    .filter((entry) => entry.userId === member?.id && entry.status === "accepted")
    .sort((a, b) => Date.parse(b.closedAt ?? b.updatedAt ?? 0) - Date.parse(a.closedAt ?? a.updatedAt ?? 0))[0];
  const [icName, , staticId] = String(application?.characterInfo ?? "")
    .split("/")
    .map((part) => part.trim());
  return icName && staticId ? { icName, staticId } : null;
}

async function syncMemberRankNickname(member, rank) {
  const identity = memberNicknameIdentity(member);
  if (!identity) return null;
  const nickname = formatFamilyNickname(member.guild.id, rank, identity.icName, identity.staticId);
  if (!nickname) throw new Error("Не удалось сформировать никнейм участника.");
  if (member.nickname !== nickname) {
    await member.setNickname(nickname, `Синхронизация никнейма с ${rank} рангом`);
  }
  return nickname;
}

async function getRankFromUser(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  return getRankFromMemberRoles(member);
}

function getWarnCountFromMemberRoles(member) {
  if (!member?.roles?.cache || !member.guild) return 0;

  const warnRoleIds = getGuildConfig(member.guild.id).warnRoleIds;
  for (const warnCount of [2, 1]) {
    const roleId = warnRoleIds[warnCount];
    if (roleId && member.roles.cache.has(roleId)) return warnCount;
  }

  return 0;
}

function normalizeWarningsForRole(userId, warnCount, existingWarnings) {
  if (warnCount <= 0) return [];

  const current = Array.isArray(existingWarnings) ? existingWarnings.slice(0, warnCount) : [];
  while (current.length < warnCount) {
    current.push({
      reason: "Синхронизация по роли варна",
      issuedBy: client.user?.id ?? "system",
      issuedAt: new Date().toISOString(),
      synced: true
    });
  }

  return current;
}

async function syncWarningsFromMemberRoles(member) {
  if (!member) return 0;

  const warnCount = getWarnCountFromMemberRoles(member);
  const warnings = getWarnings();
  warnings[member.id] ??= { active: [], history: [] };
  warnings[member.id].active ??= [];
  warnings[member.id].history ??= [];
  warnings[member.id].active = normalizeWarningsForRole(member.id, warnCount, warnings[member.id].active);

  await saveWarnings(warnings);
  return warnCount;
}

async function syncGuildStateFromRoles(guild) {
  const members = await listGuildMembers(guild).catch(() => null);
  if (!members) return;

  const warnings = getWarnings();
  for (const member of members) {
    if (member.user.bot) continue;
    const warnCount = getWarnCountFromMemberRoles(member);
    warnings[member.id] ??= { active: [], history: [] };
    warnings[member.id].active ??= [];
    warnings[member.id].history ??= [];
    warnings[member.id].active = normalizeWarningsForRole(
      member.id,
      warnCount,
      warnings[member.id].active
    );
    await syncUserProfile(member.id, {
      username: member.user.username,
      currentRank: getRankFromMemberRoles(member)
    });
  }
  await saveWarnings(warnings);
  await flushStorage();
}

async function syncWarnRoles(member, warnCount) {
  if (!member) return;

  const warnRoleIds = getGuildConfig(member.guild.id).warnRoleIds;
  for (const roleId of Object.values(warnRoleIds)) {
    if (roleId && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);
    }
  }

  const roleId = warnRoleIds[warnCount];
  if (roleId) await member.roles.add(roleId);
}

// What happens on a member's 3rd active warn - configurable per guild
// (dashboard: Security page, "Роли варнов" block). Defaults to the
// original hardcoded behavior (strip every role).
async function applyThirdWarnPunishment(member, auditReason) {
  const { warnPunishmentMode, warnPunishmentRoleId } = getGuildConfig(member.guild.id);
  if (warnPunishmentMode === "kick") {
    await member.kick(auditReason);
  } else if (warnPunishmentMode === "ban") {
    await member.ban({ reason: auditReason });
  } else if (warnPunishmentMode === "assignRole" && warnPunishmentRoleId) {
    // Just adds the role - this mode was specced as "assign a role without
    // touching the member's other roles/access" (unlike stripRoles, which
    // deliberately wipes everything), so .set([...]) here would be wrong.
    await member.roles.add(warnPunishmentRoleId, auditReason);
  } else {
    await member.roles.set([], auditReason);
  }
}

// Shared warn-issuance core, used by both the admin panel's warn action and
// automod's "warn" punishment. Caller must already have called
// syncWarningsFromMemberRoles(member) so warnings[member.id] reflects their
// current role-based count. Throws if a warn can't be issued (already at
// 3, or Discord won't let the bot manage them at 2).
async function issueWarn(member, { reason, issuedBy }) {
  const warnings = getWarnings();
  warnings[member.id] ??= { active: [], history: [] };
  const current = warnings[member.id].active.length;
  if (current >= 3 || (current === 2 && !member.manageable)) {
    throw new Error("Варн выдать нельзя");
  }
  const issuedAt = new Date().toISOString();
  warnings[member.id].active.push({ reason, issuedBy, issuedAt });
  await saveWarnings(warnings);
  await addUserAudit(member.id, "warn", { action: "add", adminId: issuedBy === "system" ? null : issuedBy, reason, createdAt: issuedAt });
  const count = warnings[member.id].active.length;
  if (count < 3) await syncWarnRoles(member, count);
  await dmUser(member, {
    embeds: [new EmbedBuilder().setColor(0x000000).setTitle("Получен варн").addFields(
      { name: "Причина", value: reason },
      { name: "Всего варнов", value: `${count}/3` },
      { name: "Администратор", value: issuedBy === "system" ? "Автомодерация" : `<@${issuedBy}>` }
    )]
  });
  if (count >= 3) {
    await applyThirdWarnPunishment(member, `3/3 варнов. Причина: ${reason}`);
  }
  return count;
}

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord's own timeout cap

// Lazily denies the guild's mute role permission to add reactions the first
// time it's actually needed - matches ensureTicketReviewerParentAccess's
// "fix permissions on first use" pattern instead of requiring the family to
// configure this by hand.
async function ensureMuteRoleBlocksReactions(guild, muteRoleId) {
  const role = guild.roles.cache.get(muteRoleId);
  if (!role || !role.permissions.has(PermissionFlagsBits.AddReactions)) return;
  await role.setPermissions(role.permissions.remove(PermissionFlagsBits.AddReactions)).catch((error) => {
    console.error(`[${guild.id}] Не удалось запретить роли мьюта добавлять реакции:`, error);
  });
}

async function applyMute(member, { durationMs, reason }) {
  const { muteMode, muteRoleId, muteBlocksReactions } = getSecuritySettings(member.guild.id);
  if (muteMode === "role" || muteMode === "both") {
    if (!muteRoleId || !member.guild.roles.cache.has(muteRoleId)) {
      throw new Error("Роль мьюта не настроена или больше не существует на сервере.");
    }
    if (muteBlocksReactions) await ensureMuteRoleBlocksReactions(member.guild, muteRoleId);
    await member.roles.add(muteRoleId, reason);
  }
  if (muteMode === "timeout" || muteMode === "both") {
    await member.timeout(Math.min(durationMs, MAX_TIMEOUT_MS), reason);
  }
}

async function removeMute(member, reason) {
  const { muteMode, muteRoleId } = getSecuritySettings(member.guild.id);
  if ((muteMode === "role" || muteMode === "both") && muteRoleId && member.roles.cache.has(muteRoleId)) {
    await member.roles.remove(muteRoleId, reason);
  }
  if (member.communicationDisabledUntil && member.communicationDisabledUntil.getTime() > Date.now()) {
    await member.timeout(null, reason);
  }
}

const AUTOMOD_FILTER_KEYS = [
  "filterLinks", "filterInvites", "filterScamLinks", "filterBadWords", "filterCapsLock", "filterMentionSpam"
];
const INVITE_LINK_PATTERN = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/i;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

// Heuristic patterns for common scam/phishing link styles (fake nitro/steam
// gift pages) - not a maintained threat-intel feed, just enough to catch the
// obvious ones. ponytail: static list, revisit if scam patterns evolve.
const SCAM_LINK_PATTERNS = [
  /steam(?:community)?[.-].*\.(?:tk|ml|ga|cf|gq|xyz|top)\b/i,
  /discord(?:app)?-?nitro.*\.(?:tk|ml|ga|cf|gq|xyz|top|ru|info)\b/i,
  /free-?nitro/i,
  /dlscord\.|discorcl\.|discrod\./i
];

// Collapsing repeated `*` before expanding to `.*` blocks the classic
// catastrophic-backtracking shape (adjacent .* groups against a long
// non-matching candidate) - these patterns are admin-authored via the
// dashboard, not attacker input, but a bad one would otherwise hang the
// whole bot's event loop on every message. ponytail: length-capped, not a
// full ReDoS-safe glob engine - revisit if patterns get more elaborate.
function globToRegExp(pattern) {
  const collapsed = pattern.trim().slice(0, 200).replace(/\*+/g, "*");
  const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

// blocklist: violation if any candidate (URL/word found in the message)
// matches a list entry. allowlist: violation if something was found but
// none of it matches - i.e. only listed entries are permitted.
function listViolation(candidates, list, strategy) {
  if (!list.length) return strategy === "allowlist" ? candidates.length > 0 : false;
  const anyMatch = candidates.some((text) => list.some((pattern) => globToRegExp(pattern).test(text)));
  return strategy === "allowlist" ? !anyMatch && candidates.length > 0 : anyMatch;
}

function capsLockViolation(text) {
  const letters = text.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, "");
  if (letters.length < 10) return false; // too short to judge fairly
  const upper = letters.replace(/[^A-ZА-ЯЁ]/g, "");
  return upper.length / letters.length > 0.7;
}

function mentionSpamViolation(message) {
  const uniqueMentions = new Set([...message.mentions.users.keys(), ...message.mentions.roles.keys()]);
  return uniqueMentions.size > 5;
}

function inAutomodScope(member, channelId, config) {
  if (config.ignoreAdminsAndMods && isModerator(member)) return false;
  if (config.targetRoleIds.length && !config.targetRoleIds.some((id) => member.roles.cache.has(id))) return false;
  if (config.ignoredRoleIds.some((id) => member.roles.cache.has(id))) return false;
  if (config.targetChannelIds.length && !config.targetChannelIds.includes(channelId)) return false;
  if (config.ignoredChannelIds.includes(channelId)) return false;
  return true;
}

async function applyAutomodPunishment(message, filterType, config, description) {
  const member = message.member;
  const reason = `Автомодерация (${filterType}): ${description}`;

  if (config.deleteMessage) await message.delete().catch(() => null);

  if (config.notifyUser) {
    await dmUserEmbed(message.author, new EmbedBuilder()
      .setColor(0xeb5757)
      .setTitle("Сообщение нарушает правила сервера")
      .setDescription(`Ваше сообщение на сервере **${message.guild.name}** было ${config.deleteMessage ? "удалено" : "отмечено"} автомодерацией.\nПричина: ${description}`));
  }

  await sendLog(message.guild, new EmbedBuilder()
    .setColor(0xeb5757)
    .setTitle("Сработала автомодерация")
    .setDescription(`<@${message.author.id}> в <#${message.channel.id}>\n${description}`)
    .addFields({ name: "Наказание", value: config.punishment, inline: true }));

  if (config.punishment === "warn") {
    await syncWarningsFromMemberRoles(member);
    await issueWarn(member, { reason, issuedBy: "system" }).catch((error) => {
      console.error(`[${message.guild.id}] Не удалось выдать варн за автомодерацию:`, error);
    });
  } else if (config.punishment === "mute") {
    await applyMute(member, { durationMs: 60 * 60 * 1000, reason }).catch((error) => {
      console.error(`[${message.guild.id}] Не удалось замьютить за автомодерацию:`, error);
    });
  } else if (config.punishment === "kick") {
    await member.kick(reason).catch((error) => {
      console.error(`[${message.guild.id}] Не удалось кикнуть за автомодерацию:`, error);
    });
  } else if (config.punishment === "ban") {
    await member.ban({ reason }).catch((error) => {
      console.error(`[${message.guild.id}] Не удалось забанить за автомодерацию:`, error);
    });
  }
}

// Runs every enabled filter in order and stops at the first violation - one
// punishment per message, so a message tripping several filters at once
// doesn't stack a warn + mute + kick on top of each other.
async function runAutomod(message) {
  if (!message.member) return;
  const security = getSecuritySettings(message.guild.id);
  const content = message.content ?? "";

  for (const filterType of AUTOMOD_FILTER_KEYS) {
    if (!security[filterType]) continue;
    const config = getAutomodFilterConfig(message.guild.id, filterType);
    if (!inAutomodScope(message.member, message.channel.id, config)) continue;

    let description = null;
    if (filterType === "filterInvites") {
      if (INVITE_LINK_PATTERN.test(content)) description = "обнаружена ссылка-приглашение на другой сервер";
    } else if (filterType === "filterScamLinks") {
      const urls = content.match(URL_PATTERN) ?? [];
      if (urls.some((url) => SCAM_LINK_PATTERNS.some((pattern) => pattern.test(url)))) {
        description = "обнаружена похожая на мошенническую ссылка";
      }
    } else if (filterType === "filterLinks") {
      const urls = content.match(URL_PATTERN) ?? [];
      if (urls.length && listViolation(urls, config.list, config.strategy)) {
        description = "ссылка не разрешена настройками фильтра";
      }
    } else if (filterType === "filterBadWords") {
      const words = content.split(/\s+/).filter(Boolean);
      if (words.length && listViolation(words, config.list, config.strategy)) {
        description = "сообщение содержит нежелательное слово";
      }
    } else if (filterType === "filterCapsLock") {
      if (capsLockViolation(content)) description = "сообщение написано преимущественно КАПСОМ";
    } else if (filterType === "filterMentionSpam") {
      if (mentionSpamViolation(message)) description = "слишком много упоминаний в одном сообщении";
    }

    if (description) {
      await applyAutomodPunishment(message, filterType, config, description);
      return;
    }
  }
}

function applicationTitle(application) {
  return `Заявка на вступление | ${application.uid ?? "без UID"}`;
}

function supportTicketTitle(ticket) {
  return `${supportTypeTitle()} | ${ticket.uid ?? "без UID"}`;
}

function buildApplicationMessagePayload(application, user = null) {
  const closed = ["accepted", "rejected", "closed"].includes(application.status);
  const value = (input) => String(input || "Не указано").slice(0, 500);
  const answersText = application.customAnswers?.length
    ? application.customAnswers.map((answer) => `**${answer.label}:** ${value(answer.value)}`).join("\n")
    : `**OOC возраст:** ${value(application.oocAge)}\n` +
      `**Почему хочет вступить:** ${value(application.reason)}\n` +
      `**Ссылка на скриншот со списком персонажей:** ${value(application.charactersLink)}`;
  const container = new ContainerBuilder()
    .setAccentColor(0x000000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${applicationTitle(application)}\n` +
        `Статус: **${applicationStatusLabel(application.status)}**\n` +
        `Состав: **${application.departmentName ?? "Общая заявка"}**`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Кандидат:** ${user ? `${user.tag} · ` : ""}<@${application.userId}>\n` +
        `**Discord ID:** ${application.userId}\n` +
        `**IC имя / уровень / Static ID:** ${value(application.characterInfo)}\n` +
        answersText
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${getGuildConfig(application.guildId).leadershipRoleIds.map((roleId) => `<@&${roleId}>`).join(" · ")}`
      )
    );
  if (!closed) container.addActionRowComponents(...applicationButtons(application));
  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { roles: [...getGuildConfig(application.guildId).leadershipRoleIds] }
  };
}

function buildApplicationDmEmbed(application, title, description, color, fields = []) {
  return new EmbedBuilder()
    .setColor(0x000000)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    ;
}

function embedToComponentPayload(embed, actionRows = []) {
  return {
    content: null,
    embeds: [embed],
    components: actionRows,
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

// Shared between the panel itself (always visible there) and the "О
// системе" button's ephemeral reply (a quick-reference popup for anyone
// who dismissed the panel text already).
const APPLICATION_INFO_TEXT =
  "### Что важно знать перед подачей\n" +
  "• Заявки принимаются только для **Orlando / RU18**.\n" +
  "• Возраст — **от 16 лет**, возможны исключения.\n" +
  "• В среднем анкета рассматривается в течение **24 часов**.\n" +
  "• Если нужный состав недоступен — набор в него временно закрыт.\n\n" +
  "### После подачи заявки\n" +
  "• Заявка будет направлена администрации на рассмотрение.\n" +
  "• Следите за личными сообщениями и не закрывайте ЛС от сервера.\n" +
  "• Отвечайте в анкете развёрнуто — это ускорит рассмотрение.\n\n" +
  "### Повторная подача\n" +
  "После отклонения новую заявку можно подать через **10 дней**.";

// Department-driven: any department configured for this guild becomes an
// application section (name, open/closed, everything editable from the
// dashboard) - no more hardcoded Capt/RP. A guild with zero departments
// (new, or departments explicitly disabled) gets one generic "apply to
// the family" button instead of a section picker.
async function buildApplicationPanel(guildId) {
  const { departmentsEnabled } = getGuildConfig(guildId);
  const departments = departmentsEnabled ? await getDepartmentsForGuild(guildId) : [];
  const useDepartments = departments.length > 0;
  const openDepartments = departments.filter((d) => d.recruitmentOpen);

  const status = (open) =>
    `${applicationEmojiMention(open ? "unlock" : "lock")} | Набор ${open ? "открыт" : "закрыт"}`;

  let recruitmentStatus;
  let actionComponent = null;

  if (useDepartments) {
    recruitmentStatus = openDepartments.length === 0
      ? `### Статус набора\n${applicationEmojiMention("lock")} | Набор закрыт во все составы`
      : `### Статус набора\n${departments.map((d) => `**${d.name}:** ${status(d.recruitmentOpen)}`).join("\n")}`;
    if (openDepartments.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId("application:start")
        .setPlaceholder("Подать заявку");
      openDepartments.slice(0, 25).forEach((department, i) => {
        select.addOptions({
          label: `Заявка в ${department.name}`.slice(0, 100),
          description: "ORLANDO / RU18",
          emoji: applicationEmoji(`number_${i + 1}`),
          value: String(department.id)
        });
      });
      actionComponent = select;
    }
  } else {
    recruitmentStatus = `### Статус набора\n${applicationEmojiMention("unlock")} | Приём заявок открыт`;
    actionComponent = [
      new ButtonBuilder()
        .setCustomId("application:start:general")
        .setLabel("Подать заявку в семью")
        .setEmoji(applicationEmoji("number_1"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("application:info")
        .setLabel("О системе")
        .setStyle(ButtonStyle.Secondary)
    ];
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x000000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## Оформление заявки в Destroy\n" +
        "Выберите состав и заполните анкету для рассмотрения руководством."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        recruitmentStatus
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(APPLICATION_INFO_TEXT)
    );

  if (actionComponent) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )
      .addActionRowComponents(new ActionRowBuilder().addComponents(...[].concat(actionComponent)));
  }

  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.IsComponentsV2
  };
}

function supportTypeTitle() {
  return "Обращение";
}

function supportRequestTypeLabel(type) {
  if (!type) return "Не указано";
  return SUPPORT_REQUEST_TYPES[type] ?? "Неизвестный тип";
}

function buildSupportPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x000000)
    .setTitle("Личный кабинет")
    .setDescription(
      "Единый раздел для личных функций участника семьи. Здесь можно посмотреть текущий ранг, варны и историю профиля, создать обращение к администрации или открыть AFK-систему.\n\n" +
      "**Профиль** — профиль и история действий.\n" +
      "**Обращения** — направить администрации вопрос или заявку.\n" +
      "**AFK-система** — временно отметить отсутствие в игре и посмотреть активные отчёты."
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("support:profile")
      .setLabel("Профиль")
      .setEmoji(applicationEmoji("profile"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("support:create")
      .setLabel("Обращения")
      .setEmoji(applicationEmoji("create_ticket"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("support:afk")
      .setLabel("AFK-система")
      .setEmoji(applicationEmoji("afk_leave"))
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

function buildAdminPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x000000)
    .setTitle("Административная панель")
    .setDescription(
      "Единый рабочий интерфейс руководства семьи. Выберите нужный раздел и действие — бот откроет форму и покажет результат только вам. Массовые действия поддерживают до 10 Discord ID или упоминаний за один раз.\n\n" +
      "**Профиль** — открыть профиль любого участника и посмотреть историю.\n" +
      "**Варны** — выдать или снять предупреждение.\n" +
      "**Ранги** — повысить или понизить участника.\n" +
      "**Составы** — открыть или закрыть набор в один из отделов семьи."
    );
  const firstRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:profile").setLabel("Профиль").setEmoji(applicationEmoji("profile")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:warn").setLabel("Варны").setEmoji(applicationEmoji("warnings")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:rank").setLabel("Ранги").setEmoji(applicationEmoji("rank_history")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:recruitment").setLabel("Составы").setEmoji(applicationEmoji("recruitment")).setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [firstRow] };
}

function buildAdminSection(section) {
  const embed = new EmbedBuilder().setColor(0x000000);
  if (section === "warn") {
    embed
      .setTitle("Система варнов")
      .setDescription("Выберите действие кнопкой ниже. Можно указать до 10 участников через пробел или с новой строки. При третьем активном варне с участника снимаются все роли на Discord-сервере.")
      .addFields({
        name: "Доступные наказания для снятия варна",
        value: [
          "• Купить и разгрузить на склад семьи 1250 бинтов.",
          "• Купить и разгрузить на склад семьи 50 лёгких бронежилетов.",
          "• Купить и разгрузить на склад семьи 20 специальных карабинов MK2.",
          "• Купить и разгрузить на склад семьи 20 специальных карабинов MK1.",
          "• Купить и разгрузить на склад семьи 20 тяжёлых винтовок.",
          "• Купить и разгрузить на склад семьи 15 тяжёлых дробовиков.",
          "• Купить и разгрузить на склад семьи 425 аптечек.",
          "• Купить и разгрузить на склад семьи 30 эпинефринов.",
          "• Пополнить баланс семьи на 100 000$.",
          "• Посетить 25 РП мероприятий."
        ].join("\n")
      });
    return { embed, row: new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_action:warn:add").setLabel("Добавить варн").setEmoji(applicationEmoji("add")).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_action:warn:remove").setLabel("Снять варн").setEmoji(applicationEmoji("remove")).setStyle(ButtonStyle.Secondary)
    ) };
  }
  if (section === "rank") return { embed: embed.setTitle("Система рангов").setDescription("Повышение или понижение изменяет каждого выбранного участника на следующую доступную ступень. Изменение роли, профиль и история синхронизируются автоматически."), row: new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_action:rank:add").setLabel("Повысить").setEmoji(applicationEmoji("add")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_action:rank:remove").setLabel("Понизить").setEmoji(applicationEmoji("remove")).setStyle(ButtonStyle.Secondary)
  ) };
  return null;
}

function buildAdminMembersModal(system, action) {
  const history = action === "history" || system === "profile";
  const modal = new ModalBuilder().setCustomId(modalCustomId("admin_modal", system, action)).setTitle(history ? "Выбор участника" : "Управление участниками");
  const members = new TextInputBuilder().setCustomId("members").setLabel(history ? "Discord ID" : "Discord ID (до 10)").setStyle(history ? TextInputStyle.Short : TextInputStyle.Paragraph).setRequired(true).setMaxLength(history ? 32 : 400);
  modal.addComponents(new ActionRowBuilder().addComponents(members));
  if (history) return modal;
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Причина").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(2).setMaxLength(500)));
  return modal;
}

async function resolveAdminMembers(guild, input, limit = 10) {
  const ids = [...new Set(String(input).match(/\d{17,20}/g) ?? [])].slice(0, limit);
  const members = await Promise.all(ids.map((id) => (
    guild.members.cache.get(id) ?? guild.members.fetch(id).catch(() => null)
  )));
  return members.filter(Boolean);
}

async function buildAdminRecruitmentPayload(guildId) {
  const departments = await getDepartmentsForGuild(guildId);
  if (!departments.length) {
    return {
      embeds: [new EmbedBuilder().setColor(0x000000).setTitle("Управление составами").setDescription("В этой семье пока нет ни одного отдела - настройте их в панели управления на сайте, затем сюда вернитесь, чтобы открывать и закрывать набор.")],
      components: [],
      flags: MessageFlags.Ephemeral
    };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId("admin_recruitment_select")
    .setPlaceholder("Выберите состав")
    .addOptions(
      departments.slice(0, 25).map((department) => ({
        label: department.name.slice(0, 100),
        value: String(department.id),
        description: `Сейчас набор ${department.recruitmentOpen ? "открыт" : "закрыт"}`
      }))
    );
  return {
    embeds: [new EmbedBuilder().setColor(0x000000).setTitle("Управление составами").setDescription("Выберите состав. После выбора бот покажет текущее действие и запросит подтверждение.")],
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral
  };
}

function gameAfkTimestamp(value, style = "R") {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? `<t:${Math.floor(milliseconds / 1000)}:${style}>`
    : "время не определено";
}

const AFK_LOOKUP_TIMEOUT = Symbol("afk-lookup-timeout");

async function getGameAfkSessionQuick(guildId, userId, timeoutMs = 750) {
  let timer;
  try {
    return await Promise.race([
      getGameAfkSession(guildId, userId).catch(() => AFK_LOOKUP_TIMEOUT),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(AFK_LOOKUP_TIMEOUT), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildGameAfkPanel(sessions = []) {
  const activeList = sessions.length
    ? sessions.map((session) =>
      `• <@${session.userId}> — вернётся ${gameAfkTimestamp(session.expiresAt)} (${gameAfkTimestamp(session.expiresAt, "t")})`
    ).join("\n")
    : "Никто сейчас не в AFK.";

  const embed = new EmbedBuilder()
    .setColor(0x000000)
    .setTitle("AFK-система")
    .setDescription(
      "Используйте AFK-систему, если вы **остаётесь в игре**, но временно отходите от компьютера. Нажмите **«Уйти в AFK»**, укажите причину и время отсутствия. В панели будет видно только время возвращения, а причина сохранится в логах администрации.\n\n" +
      "Если вернулись раньше — нажмите **«Вернуться из AFK»**. По окончании времени бот автоматически уберёт вас из списка и отправит уведомление в ЛС."
    )
    .addFields({ name: "Сейчас в AFK", value: activeList });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("game_afk:start")
      .setLabel("Уйти в AFK")
      .setEmoji(applicationEmoji("afk_leave"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("game_afk:return")
      .setLabel("Вернуться из AFK")
      .setEmoji(applicationEmoji("afk_return"))
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: null,
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

function buildGameAfkModal() {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("game_afk", "start-submit"))
    .setTitle("Уйти в AFK");
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Причина")
    .setPlaceholder("Кратко укажите, почему вы отходите")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(500)
    .setRequired(true);
  const duration = new TextInputBuilder()
    .setCustomId("duration")
    .setLabel("Длительность в часах (максимум 4)")
    .setPlaceholder("Например: 1 или 0,5")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(4)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder().addComponents(reason),
    new ActionRowBuilder().addComponents(duration)
  );
  return modal;
}

function isValidLinkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// departmentId is null for the generic (no-department) apply flow - the
// modal's customId carries "general" in that slot instead of a real id, so
// the submit handler downstream can tell the two apart.
// The IC-name/level/Static-ID field is always present and fixed - it's not
// really a "question", it's the data buildFamilyNickname needs to set the
// member's nickname on acceptance (see extractCharacterIdentity). That
// leaves at most 4 of Discord's 5-field modal cap for a department's own
// custom questions; a department with none configured gets the original
// default 3 (screenshot link, OOC age, reason).
function buildApplicationModal(departmentId, departmentName, questions = []) {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("family_application", departmentId ?? "general"))
    .setTitle(`Заявка в ${departmentName}`.slice(0, 45));

  const character = new TextInputBuilder()
    .setCustomId("character")
    .setLabel("IC имя / уровень персонажа / Static ID")
    .setPlaceholder("Например: John_Smith / 50 / 12345")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const rows = [new ActionRowBuilder().addComponents(character)];
  const customQuestions = Array.isArray(questions) ? questions.slice(0, 4) : [];

  if (customQuestions.length > 0) {
    customQuestions.forEach((question, index) => {
      const input = new TextInputBuilder()
        .setCustomId(`q${index}`)
        .setLabel(String(question.label).slice(0, 45))
        .setStyle(question.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(question.required !== false);
      rows.push(new ActionRowBuilder().addComponents(input));
    });
  } else {
    const oocAge = new TextInputBuilder()
      .setCustomId("ooc_age")
      .setLabel("OOC возраст")
      .setPlaceholder("Укажите ваш реальный возраст")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reason = new TextInputBuilder()
      .setCustomId("reason")
      .setLabel("Почему хотите вступить?")
      .setPlaceholder("Расскажите, почему выбрали фаму и чем будете полезны")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const charactersLink = new TextInputBuilder()
      .setCustomId("characters_link")
      .setLabel("Ссылка на скриншот со списком персонажей")
      .setPlaceholder("Например: сервис Yapix, Imgur и тому подобные")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    rows.push(
      new ActionRowBuilder().addComponents(charactersLink),
      new ActionRowBuilder().addComponents(oocAge),
      new ActionRowBuilder().addComponents(reason)
    );
  }

  modal.addComponents(...rows);
  return modal;
}

function buildApplicationRejectionModal(uid) {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("application", "reject-reason", uid))
    .setTitle("Отклонить заявку");
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Причина отклонения")
    .setPlaceholder("Укажите причину, по которой заявка отклонена")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return modal;
}

function isSupportTypeAvailable(type, member) {
  if (type === "rank_change") {
    const rank = getRankFromMemberRoles(member);
    return rank === 1 || rank === 2;
  }
  if (type === "warn_removal") {
    return getWarnCountFromMemberRoles(member) > 0;
  }
  return true;
}

const SUPPORT_TYPE_OPTION_EMOJIS = [
  applicationEmoji("number_1"),
  applicationEmoji("number_2"),
  applicationEmoji("number_3"),
  applicationEmoji("number_4"),
  applicationEmoji("number_5"),
  applicationEmoji("number_6")
];

function buildSupportTypeSelectPayload(nonce, member) {
  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId(`support:type_select:${nonce}`)
    .setPlaceholder("Выберите тип заявки")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.entries(SUPPORT_REQUEST_TYPES)
        .filter(([value]) => isSupportTypeAvailable(value, member))
        .map(([value, label], index) => ({ label, value, emoji: SUPPORT_TYPE_OPTION_EMOJIS[index] }))
    );
  const container = new ContainerBuilder()
    .setAccentColor(0x000000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${applicationEmojiMention("create_ticket")} | Создать обращение`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addActionRowComponents(new ActionRowBuilder().addComponents(typeSelect));
  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  };
}

function buildSupportDetailsModal(nonce, type) {
  const modal = new ModalBuilder()
    .setCustomId(`support:create-submit:${nonce}:${type}`)
    .setTitle(supportRequestTypeLabel(type).slice(0, 45));
  const fields = SUPPORT_TYPE_FIELDS[type] ?? SUPPORT_TYPE_FIELDS.other;
  modal.addComponents(
    fields.map((field) => {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label)
        .setPlaceholder(field.placeholder)
        .setStyle(field.style)
        .setRequired(true)
        .setMinLength(field.minLength)
        .setMaxLength(field.maxLength);
      return new ActionRowBuilder().addComponents(input);
    })
  );
  return modal;
}

function yesNoSelect(customId, yesLabel, noLabel) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Выберите ответ")
    .setRequired(true)
    .addOptions(
      { label: yesLabel, value: "yes" },
      { label: noLabel, value: "no" }
    );
}

function buildRankChangeCloseModal(uid) {
  const modal = new ModalBuilder()
    .setCustomId(`support:rank-change-close:${uid}`)
    .setTitle("Изменение ранга");
  modal.addComponents(
    new LabelBuilder()
      .setLabel("Сменил фамилию на Destroy?")
      .setStringSelectMenuComponent(yesNoSelect("surname_changed", "Да, сменил", "Нет, не сменил")),
    new LabelBuilder()
      .setLabel("Находится в планшете?")
      .setStringSelectMenuComponent(yesNoSelect("in_planshet", "Да, находится", "Нет, не находится")),
    new LabelBuilder()
      .setLabel("Посетил 25 РП мероприятий?")
      .setStringSelectMenuComponent(yesNoSelect("attended_events", "Да, посетил", "Нет, не посетил"))
  );
  return modal;
}

function buildWarnRemovalCloseModal(uid) {
  const modal = new ModalBuilder()
    .setCustomId(`support:warn-close:${uid}`)
    .setTitle("Снятие варна");
  modal.addComponents(
    new LabelBuilder()
      .setLabel("Участник выполнил условия снятия варна?")
      .setStringSelectMenuComponent(yesNoSelect("condition_met", "Да, выполнил", "Нет, не выполнил"))
  );
  return modal;
}

function buildTicketTransferModal(scope, uid) {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("ticket", "transfer-target", scope, uid))
    .setTitle("Передать заявку");
  const target = new TextInputBuilder()
    .setCustomId("target")
    .setLabel("Кому передать")
    .setPlaceholder("Discord ID, упоминание или точный ник")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(target));
  return modal;
}

async function setApplicantCanWrite(channel, userId, canWrite) {
  // Discord threads do not support per-user permission overwrites. Membership
  // controls visibility; once a ticket is claimed, only its three participants
  // remain in the private thread.
  if (channel.isThread()) return;

  if (!canWrite) {
    await channel.permissionOverwrites.edit(userId, applicantLockedOverwriteOptions());
    return;
  }

  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    AttachFiles: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    SendMessagesInThreads: true,
    UseApplicationCommands: true,
    ReadMessageHistory: true
  });
}

async function closeApplicationThread(channel, reason) {
  if (!channel?.isThread()) return false;
  try {
    await channel.edit({ archived: true, locked: true }, reason);
    return true;
  } catch (error) {
    console.error(`Failed to close application thread ${channel.id}:`, error);
  }

  try {
    if (!channel.archived) await channel.setArchived(true, reason);
    if (!channel.locked) await channel.setLocked(true, reason);
    return true;
  } catch (error) {
    console.error(`Failed to close application thread ${channel.id} using fallback:`, error);
    return false;
  }
}

async function addTicketThreadMembers(thread, userIds) {
  await Promise.allSettled(
    [...new Set(userIds.filter(Boolean))].map(async (userId) => {
      const member = await thread.guild.members.fetch(userId).catch(() => null);
      if (!member || thread.members.cache.has(userId)) return;
      await thread.members.add(userId).catch((error) => {
        if (error.code !== 50001 && error.code !== 10007) {
          console.error(`Failed to add ${userId} to ticket thread ${thread.id}:`, error);
        }
      });
    })
  );
}

async function keepOnlyTicketParticipants(thread, userIds) {
  if (!thread?.isThread()) return;
  const keep = new Set(userIds.filter(Boolean));
  keep.add(thread.client.user.id);
  const members = await thread.members.fetch().catch((error) => {
    console.error(`Failed to fetch members of ticket thread ${thread.id}:`, error);
    return null;
  });

  if (members) {
    await Promise.allSettled(
      members
        .filter((member) => !keep.has(member.id))
        .map((member) =>
          thread.members.remove(member.id).catch((error) => {
            console.error(`Failed to remove ${member.id} from ticket thread ${thread.id}:`, error);
          })
        )
    );
  }

  await addTicketThreadMembers(thread, [...keep]);
}

async function ensureTicketReviewerParentAccess(parent, reviewerRoleIds) {
  // A role id here can go stale (role deleted/renamed on Discord since it
  // was configured) - resolving against the guild's live role cache first
  // means one bad id just gets skipped instead of throwing "Supplied
  // parameter is not a User nor a Role" and failing every other role in
  // the same Promise.all along with it.
  const validRoleIds = reviewerRoleIds.filter((roleId) => parent.guild.roles.cache.has(roleId));
  const staleRoleIds = reviewerRoleIds.filter((roleId) => !validRoleIds.includes(roleId));
  if (staleRoleIds.length) {
    console.error(`[${parent.guild.id}] Пропущены несуществующие роли руководства: ${staleRoleIds.join(", ")}`);
  }
  await Promise.all(validRoleIds.map(async (roleId) => {
    const permissions = parent.permissionsFor(roleId);
    if (
      permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions?.has(PermissionFlagsBits.ManageThreads)
    ) return;
    await parent.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
      ManageThreads: true
    });
  }));
}

async function createPrivateTicketThread(interaction, name, reviewerRoleIds = getGuildConfig(interaction.guildId).leadershipRoleIds) {
  const parent = interaction.channel;
  if (!parent?.isTextBased() || !parent.threads) {
    throw new Error("Панель заявок должна находиться в обычном текстовом канале с поддержкой веток.");
  }

  await ensureTicketReviewerParentAccess(parent, reviewerRoleIds);

  const thread = await parent.threads.create({
    name,
    type: ChannelType.PrivateThread,
    // The creator must be allowed to populate the private thread. Invitations
    // are disabled again immediately after the applicant has been added.
    invitable: true,
    autoArchiveDuration: 10080,
    reason: `Приватная заявка от ${interaction.user.tag} (${interaction.user.id})`
  });
  return thread;
}

async function createApplicationChannel(interaction, uid) {
  return createPrivateTicketThread(interaction, uid);
}

async function refreshApplicationPanel(guild) {
  const channel = await guild.channels.fetch(getGuildConfig(guild.id).applicationPanelChannelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const panels = messages?.filter((message) => {
    if (message.author.id !== guild.client.user.id) return false;
    const serialized = JSON.stringify(message.components);
    return serialized.includes("application:start") ||
      serialized.toLowerCase().includes("оформление заявки в destroy");
  });
  const current = panels?.first() ?? null;
  const duplicates = panels?.filter((message) => message.id !== current?.id) ?? [];
  await Promise.allSettled(duplicates.map((message) => message.delete()));
  const panelPayload = await buildApplicationPanel(guild.id);
  if (current) {
    const updated = await current.edit(panelPayload).catch(() => null);
    if (updated) return updated;
    await current.delete().catch(() => null);
  }
  return channel.send(panelPayload);
}

async function refreshStaticPanel(guild, channelId, componentId, payloadBuilder) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const current = messages?.find((message) =>
    message.author.id === guild.client.user.id &&
    (JSON.stringify(message.components).includes(componentId) ||
      JSON.stringify(message.embeds).includes(componentId))
  );
  if (current) {
    const updated = await current.edit(payloadBuilder()).catch(() => null);
    if (updated) return updated;
    await current.delete().catch(() => null);
  }
  return channel.send(payloadBuilder());
}

async function processExpiredGameAfkSessions(guild) {
  const expired = await takeExpiredGameAfkSessions(guild.id);
  if (!expired.length) return;

  for (const session of expired) {
    const user = await guild.client.users.fetch(session.userId).catch(() => null);
    if (user) {
      await user.send({
        embeds: [new EmbedBuilder()
          .setColor(0x000000)
          .setTitle("Время AFK завершилось")
          .setDescription("Указанное вами время AFK истекло. Вы автоматически удалены из списка AFK.")],
        allowedMentions: { parse: [], users: [], roles: [] }
      }).catch(() => null);
    }
    await sendLog(guild, new EmbedBuilder()
      .setColor(0xf2c94c)
      .setTitle("AFK завершён автоматически")
      .setDescription(`<@${session.userId}> автоматически удалён из списка AFK.`)
      .addFields(
        { name: "Причина", value: String(session.reason).slice(0, 1024) },
        { name: "Начало", value: gameAfkTimestamp(session.startedAt, "F"), inline: true },
        { name: "Завершение", value: gameAfkTimestamp(session.expiresAt, "F"), inline: true }
      ));
  }
}

function buildSupportTicketMessagePayload(ticket, user) {
  const statusLabels = {
    new: "Новая",
    in_review: "На рассмотрении",
    closed: "Закрыто"
  };
  const closed = ticket.status === "closed";
  const reviewerMention = ticket.status === "new"
    ? ` | ${getGuildConfig(ticket.guildId).leadershipRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")}`
    : "";
  const container = new ContainerBuilder()
    .setAccentColor(0x000000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${supportTicketTitle(ticket)}\n` +
        `Статус: **${statusLabels[ticket.status] ?? "Неизвестно"}**${reviewerMention}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Заявитель:** ${user ? `${user.tag} · ` : ""}<@${ticket.userId}>\n` +
        `**Тип заявки:** ${supportRequestTypeLabel(ticket.requestType)}\n\n` +
        `**Детали:**\n${String(ticket.details ?? "Не указаны").slice(0, 3000)}`
      )
    );
  if (!closed) {
    container.addActionRowComponents(...supportTicketButtons(ticket));
  }
  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { roles: [...getGuildConfig(ticket.guildId).leadershipRoleIds] }
  };
}

async function createSupportTicketChannel(interaction, ticket) {
  return createPrivateTicketThread(
    interaction,
    ticket.uid
  );
}

async function finalizeSupportTicketClose(interaction, ticketKey, ticket, tickets, sideEffectNote = "") {
  ticket.status = "closed";
  ticket.claimedBy ??= interaction.user.id;
  ticket.closedBy = interaction.user.id;
  ticket.closedAt = new Date().toISOString();
  ticket.updatedAt = ticket.closedAt;
  tickets[ticketKey] = ticket;
  await saveSupportTickets(tickets);

  const user = await interaction.client.users.fetch(ticket.userId).catch(() => null);
  const ticketMessage = ticket.messageId
    ? await interaction.channel.messages.fetch(ticket.messageId).catch(() => null)
    : null;
  if (ticketMessage) await ticketMessage.edit(buildSupportTicketMessagePayload(ticket, user)).catch(() => null);
  await dmUserEmbed(
    user,
    new EmbedBuilder()
      .setColor(0x000000)
      .setTitle(`Обращение ${ticket.uid} закрыто`)
      .setDescription(
        `Ваше обращение закрыл <@${interaction.user.id}>.` +
        (sideEffectNote ? `\n${sideEffectNote}` : "")
      )
  );
  await sendLog(
    interaction.guild,
    new EmbedBuilder()
      .setColor(0x000000)
      .setTitle(`Обращение закрыто | ${ticket.uid}`)
      .setDescription(
        `<@${interaction.user.id}> закрыл обращение <@${ticket.userId}>.\nВетка: ${interaction.channel}` +
        (sideEffectNote ? `\n${sideEffectNote}` : "")
      )
  );
  await interaction.channel.send(
    successMessage(`Обращение **${ticket.uid}** закрыл <@${interaction.user.id}>.`)
  );
  if (interaction.channel.isThread()) {
    await interaction.channel.setLocked(true, "Обращение закрыто");
    await interaction.channel.setArchived(true, "Обращение закрыто");
  }
}

async function createGeneralSupportTicket(interaction, requestType, details) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const tickets = getSupportTickets();
  const activeTicket = Object.values(tickets).find(
    (ticket) => ticket.userId === interaction.user.id &&
      ["new", "in_review"].includes(ticket.status)
  );
  if (activeTicket) {
    const existingChannel = activeTicket.channelId
      ? await interaction.guild.channels.fetch(activeTicket.channelId).catch(() => null)
      : null;
    await interaction.editReply({
      content: existingChannel
        ? noticeMessage(`У вас уже есть активное обращение: ${existingChannel}.`)
        : noticeMessage("У вас уже есть активное обращение. Дождитесь ответа администрации.")
    });
    return;
  }

  await interaction.editReply({
    content: loadingMessage("Пожалуйста, подождите, ваше обращение создаётся...")
  });
  const uid = createTicketUid("S", tickets, getApplications());
  const ticketId = `${interaction.user.id}-${Date.now()}`;
  const ticket = {
    id: ticketId,
    guildId: interaction.guildId,
    uid,
    userId: interaction.user.id,
    status: "new",
    requestType,
    details,
    channelId: null,
    messageId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const channel = await createSupportTicketChannel(interaction, ticket);
  ticket.channelId = channel.id;
  tickets[ticketId] = ticket;
  await saveSupportTickets(tickets);

  const message = await channel.send(buildSupportTicketMessagePayload(ticket, interaction.user));
  ticket.messageId = message.id;
  tickets[ticketId] = ticket;
  await saveSupportTickets(tickets);

  await addTicketThreadMembers(channel, [interaction.user.id]);
  await channel.setInvitable(false, "Все участники обращения добавлены").catch(() => null);
  await interaction.editReply({ content: successMessage(`Обращение создано! ${channel}`) });
  await dmUserEmbed(
    interaction.user,
    buildApplicationDmEmbed(
      ticket,
      "Обращение создано",
      `Обращение создано и направлено администрации. Ожидайте ответа.\n\nОткрыть обращение: ${channel}`,
      0x56ccf2
    )
  );
  await sendLog(
    interaction.guild,
    new EmbedBuilder()
      .setColor(0x000000)
      .setTitle(`Новое обращение | ${uid}`)
      .setDescription(
        `<@${interaction.user.id}> создал обращение.\n` +
        `Тип: **${supportRequestTypeLabel(requestType)}**\nВетка: ${channel}`
      )
  );
}

async function dmUser(user, payload) {
  if (!user) return;
  if (!getUserRecord(user.id).dmNotifications) return;
  return user.send(payload).catch(() => null);
}

async function dmUserEmbed(user, embed) {
  await dmUser(user, {
    embeds: [embed],
    allowedMentions: { parse: [], users: [], roles: [] }
  });
}

async function deleteApplicationAnnouncement(guild, application) {
  if (!application?.announcementChannelId || !application?.announcementMessageId) return true;

  const channel = await guild.channels.fetch(application.announcementChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const message = await channel.messages.fetch(application.announcementMessageId).catch(() => null);
  if (!message) return true;
  return message.delete().then(() => true).catch((error) => {
    console.error(`Failed to delete application announcement ${application.announcementMessageId}:`, error);
    return false;
  });
}

async function deleteApplicationChannels(guild, application) {
  if (!application) return;
  await deleteApplicationAnnouncement(guild, application);

  const ticketThread = application.channelId
    ? await guild.channels.fetch(application.channelId).catch(() => null)
    : null;
  if (ticketThread?.isThread()) {
    await ticketThread.delete("Пользователь покинул Discord-сервер").catch(() => null);
    return;
  }

  if (ticketThread) await ticketThread.delete("Очистка закрытой заявки").catch(() => null);
}

async function deleteSupportTicketChannels(guild, ticket) {
  if (!ticket) return;

  const ticketThread = ticket.channelId
    ? await guild.channels.fetch(ticket.channelId).catch(() => null)
    : null;
  if (ticketThread?.isThread()) {
    await ticketThread.delete("Пользователь покинул Discord-сервер").catch(() => null);
    return;
  }

  if (ticketThread) await ticketThread.delete("Служебная заявка закрыта").catch(() => null);
}

async function synchronizeStoredTicketThreads(guild) {
  const applications = getApplications();
  let applicationsChanged = false;
  for (const application of Object.values(applications)) {
    const isClosed = ["closed", "accepted", "rejected"].includes(application.status);
    if (isClosed && (application.announcementChannelId || application.announcementMessageId)) {
      const removed = await deleteApplicationAnnouncement(guild, application);
      if (removed) {
        application.announcementChannelId = null;
        application.announcementMessageId = null;
        applicationsChanged = true;
      }
    }
    if (!application.channelId) continue;
    const channel = await guild.channels.fetch(application.channelId).catch(() => null);
    if (!channel?.isThread()) continue;

    if (!channel.archived && application.uid && channel.name !== application.uid) {
      await channel.setName(application.uid, "Единый формат номера заявки").catch(() => null);
    }
    if (application.messageId) {
      const message = await channel.messages.fetch(application.messageId).catch(() => null);
      if (message) {
        const user = await guild.client.users.fetch(application.userId).catch(() => null);
        await message.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
      }
    }
    if (isClosed && (!channel.archived || !channel.locked)) {
      await closeApplicationThread(channel, "Заявка уже закрыта");
    }
  }
  if (applicationsChanged) await saveApplications(applications);

  for (const ticket of Object.values(getSupportTickets())) {
    if (!ticket.channelId) continue;
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel?.isThread()) continue;
    if (ticket.messageId) {
      const message = await channel.messages.fetch(ticket.messageId).catch(() => null);
      const user = await guild.client.users.fetch(ticket.userId).catch(() => null);
      if (message) {
        await message.edit(buildSupportTicketMessagePayload(ticket, user)).catch(() => null);
      }
    }
    if (ticket.status === "closed" && (!channel.archived || !channel.locked)) {
      await closeApplicationThread(channel, "Обращение уже обработано");
    }
  }
}

async function sendLog(guild, embed) {
  const { logChannelId } = getGuildConfig(guild.id);
  if (!logChannelId) return;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [], users: [], roles: [] }
    });
  }
}

function memberEmbed(user, rank, warnCount, member = null) {
  const embed = new EmbedBuilder()
    .setColor(0x000000)
    .setTitle(`Профиль: ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: "Discord", value: `<@${user.id}>`, inline: true },
      { name: "Ранг", value: rankDisplayName(member?.guild?.id, rank), inline: true },
      { name: "Варны", value: String(warnCount), inline: true }
    );
  return embed;
}

async function registerSlashCommands() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    console.error("Не удалось авто-зарегистрировать slash-команды: не заданы DISCORD_TOKEN или DISCORD_CLIENT_ID.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
    body: slashCommandDefinitions
  });
  console.log(`Slash-команды зарегистрированы автоматически: ${slashCommandDefinitions.length} глобальных.`);
}

// Runs the per-guild boot sequence (panels, role sync, ticket thread sync)
// for one guild - called once per guild the bot is actually in, instead of
// once for a single hardcoded DISCORD_GUILD_ID.
async function initializeGuild(guild) {
  await processExpiredGameAfkSessions(guild).catch((error) => {
    console.error(`[${guild.id}] Не удалось обработать просроченные AFK-сессии при старте:`, error);
  });

  const { leadershipRoleIds, applicationPanelChannelId, supportPanelChannelId, adminPanelChannelId } = getGuildConfig(guild.id);
  const applicationParent = applicationPanelChannelId
    ? await guild.channels.fetch(applicationPanelChannelId).catch(() => null)
    : null;
  if (applicationParent?.isTextBased()) {
    await ensureTicketReviewerParentAccess(applicationParent, leadershipRoleIds).catch((error) => {
      console.error(`[${guild.id}] Не удалось выдать доступ к панели заявок:`, error);
    });
    await refreshApplicationPanel(guild).catch((error) => {
      console.error(`[${guild.id}] Не удалось обновить панель заявок:`, error);
    });
  } else if (applicationPanelChannelId) {
    console.error(`[${guild.id}] Канал панели заявок (${applicationPanelChannelId}) недоступен: проверьте права бота и ID канала.`);
  }

  if (supportPanelChannelId) {
    await refreshStaticPanel(guild, supportPanelChannelId, "support:create", buildSupportPanel).catch((error) => {
      console.error(`[${guild.id}] Не удалось обновить панель поддержки:`, error);
    });
  }
  if (adminPanelChannelId) {
    await refreshStaticPanel(guild, adminPanelChannelId, "admin:warn", buildAdminPanel).catch((error) => {
      console.error(`[${guild.id}] Не удалось обновить админ-панель:`, error);
    });
  }

  await syncGuildStateFromRoles(guild).catch((error) => {
    console.error(`[${guild.id}] Не удалось синхронизировать состояние по ролям:`, error);
  });
  await synchronizeStoredTicketThreads(guild).catch((error) => {
    console.error(`[${guild.id}] Не удалось синхронизировать ветки обращений:`, error);
  });
}

async function handleClientReady(readyClient) {
  console.log(`Бот запущен как ${readyClient.user.tag}`);
  await registerSlashCommands().catch((error) => {
    console.error("Не удалось авто-зарегистрировать slash-команды:", error);
  });
  for (const guild of readyClient.guilds.cache.values()) {
    await upsertGuild({ id: guild.id, name: guild.name, icon: guild.icon, ownerDiscordId: guild.ownerId }).catch((error) => {
      console.error(`[${guild.id}] Не удалось зарегистрировать гильдию:`, error);
    });
    await initializeGuild(guild).catch((error) => {
      console.error(`[${guild.id}] Ошибка инициализации гильдии при старте:`, error);
    });
  }
  const gameAfkSweep = setInterval(() => {
    for (const guild of readyClient.guilds.cache.values()) {
      processExpiredGameAfkSessions(guild).catch((error) => {
        console.error(`[${guild.id}] Failed to process expired AFK sessions:`, error);
      });
    }
  }, GAME_AFK_SWEEP_INTERVAL_MS);
  gameAfkSweep.unref?.();

  // Periodically (rather than before every single interaction) pick up data changed
  // directly in the database, so manual edits still apply without a restart but without
  // adding a blocking PostgreSQL round-trip in front of every button/command's 3-second ack window.
  const storageReloadSweep = setInterval(() => {
    reloadStorage().catch((error) => {
      console.error("Background storage reload failed:", error);
    });
  }, STORAGE_RELOAD_INTERVAL_MS);
  storageReloadSweep.unref?.();
}

client.once(Events.ClientReady, (readyClient) => {
  handleClientReady(readyClient).catch((error) => {
    console.error("Bot initialization after login failed:", error);
  });
});

// A guild the bot is added to after boot never goes through
// handleClientReady's loop - this is that same registration + panel setup,
// run once for just the new guild.
client.on(Events.GuildCreate, (guild) => {
  upsertGuild({ id: guild.id, name: guild.name, icon: guild.icon, ownerDiscordId: guild.ownerId })
    .then(() => reloadStorage())
    .then(() => initializeGuild(guild))
    .catch((error) => {
      console.error(`[${guild.id}] Не удалось инициализировать новую гильдию:`, error);
    });
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

async function claimTicketFromActivity(channel, reviewer) {
  if (!channel?.isThread() || reviewer.bot) return false;
  const reviewerMember = channel.guild.members.cache.get(reviewer.id) ??
    await channel.guild.members.fetch(reviewer.id).catch(() => null);
  const applications = getApplications();
  const applicationEntry = Object.entries(applications).find(
    ([, application]) => application.channelId === channel.id && application.status === "new"
  );

  if (applicationEntry) {
    if (!isApplicationReviewer(reviewerMember)) return false;
    const [applicationKey, application] = applicationEntry;
    application.status = "in_review";
    application.claimedBy = reviewer.id;
    application.updatedAt = new Date().toISOString();
    applications[applicationKey] = application;
    await saveApplications(applications);

    const user = channel.client.users.cache.get(application.userId) ??
      await channel.client.users.fetch(application.userId).catch(() => null);
    const ticketMessage = application.messageId
      ? await channel.messages.fetch(application.messageId).catch(() => null)
      : null;

    if (ticketMessage) {
      await ticketMessage.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
    }

    if (channel.name !== application.uid) {
      await channel.setName(application.uid, "Единый формат номера заявки").catch(() => null);
    }
    await channel.send(noticeMessage(`Администратор <@${reviewer.id}> приступил к рассмотрению заявки **${application.uid}**.`));
    await sendLog(
      channel.guild,
      new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle(`Заявка взята в работу | ${application.uid}`)
        .setDescription(`<@${reviewer.id}> взял заявку <@${application.userId}>.`)
    );
    await dmUserEmbed(
      user,
      buildApplicationDmEmbed(
        application,
        "Заявка взята в работу",
        `Администратор <@${reviewer.id}> приступил к рассмотрению вашей заявки.\n\nОткрыть заявку: ${channel}`,
        0x2f80ed
      )
    );
    await keepOnlyTicketParticipants(channel, [
      application.userId,
      reviewer.id,
      channel.client.user.id
    ]);
    return true;
  }

  const tickets = getSupportTickets();
  const ticketEntry = Object.entries(tickets).find(
    ([, ticket]) => ticket.channelId === channel.id && ticket.status === "new"
  );
  if (!ticketEntry) return false;
  if (!isSupportReviewer(reviewerMember)) return false;

  const [ticketId, ticket] = ticketEntry;
  ticket.status = "in_review";
  ticket.claimedBy = reviewer.id;
  ticket.updatedAt = new Date().toISOString();
  tickets[ticketId] = ticket;
  await saveSupportTickets(tickets);

  const user = channel.client.users.cache.get(ticket.userId) ??
    await channel.client.users.fetch(ticket.userId).catch(() => null);
  const ticketMessage = ticket.messageId
    ? await channel.messages.fetch(ticket.messageId).catch(() => null)
    : null;

  if (ticketMessage) {
    await ticketMessage.edit(buildSupportTicketMessagePayload(ticket, user)).catch(() => null);
  }

  await channel.send(noticeMessage(`Администратор <@${reviewer.id}> приступил к рассмотрению обращения **${ticket.uid}**.`));
  await sendLog(
    channel.guild,
    new EmbedBuilder()
      .setColor(0x000000)
      .setTitle(`Обращение взято в работу | ${ticket.uid}`)
      .setDescription(`<@${reviewer.id}> взял обращение <@${ticket.userId}>.`)
  );
  await dmUserEmbed(
    user,
    new EmbedBuilder()
      .setColor(0x000000)
      .setTitle(`Обращение ${ticket.uid} взято в работу`)
      .setDescription(`Администратор <@${reviewer.id}> приступил к рассмотрению вашего обращения.\n\nОткрыть обращение: ${channel}`)
  );
  await keepOnlyTicketParticipants(channel, [
    ticket.userId,
    reviewer.id,
    channel.client.user.id
  ]);
  await setApplicantCanWrite(channel, ticket.userId, true);
  return true;
}

async function handleMessageCreate(message) {
  if (!message.guild || message.author.bot) return;

  if (message.channel.isThread()) {
    await reloadStorage();
    await claimTicketFromActivity(message.channel, message.author);
  }

  await runAutomod(message).catch((error) => {
    console.error(`[${message.guild.id}] Automod processing failed:`, error);
  });
}

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((error) => {
    console.error("Message processing failed:", error);
  });
});

async function handleMessageReactionAdd(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
  const channel = reaction.message.channel;
  if (!channel?.isThread()) return;
  await reloadStorage();
  await claimTicketFromActivity(channel, user);
}

client.on(Events.MessageReactionAdd, (reaction, user) => {
  handleMessageReactionAdd(reaction, user).catch((error) => {
    console.error("Reaction processing failed:", error);
  });
});

async function purgeDepartedUser(guild, userId) {
  await reloadStorage();
  const applications = getApplications();
  const supportTickets = getSupportTickets();

  for (const application of Object.values(applications).filter((item) => item.userId === userId)) {
    await deleteApplicationChannels(guild, application);
  }

  for (const ticket of Object.values(supportTickets).filter((item) => item.userId === userId)) {
    await deleteSupportTicketChannels(guild, ticket);
  }

  await deleteUserProfile(userId);
}

async function handleGuildMemberRemove(member) {
  const { restoreNicknameOnRejoin, restoreOldRolesOnRejoin, exemptRoleIds } = getGuildConfig(member.guild.id);
  if (restoreNicknameOnRejoin || restoreOldRolesOnRejoin) {
    const roleIds = [...member.roles.cache.keys()].filter(
      (id) => id !== member.guild.id && !exemptRoleIds.includes(id)
    );
    await saveDepartedMemberSnapshot(member.guild.id, member.id, { nickname: member.nickname, roleIds }).catch((error) => {
      console.error(`[${member.guild.id}] Не удалось сохранить снимок участника ${member.id} для восстановления при перезаходе:`, error);
    });
  }
  await purgeDepartedUser(member.guild, member.id);
}

client.on(Events.GuildMemberRemove, (member) => {
  handleGuildMemberRemove(member).catch((error) => {
    console.error("Guild member removal processing failed:", error);
  });
});

client.on(Events.GuildBanAdd, (ban) => {
  purgeDepartedUser(ban.guild, ban.user.id).catch((error) => {
    console.error("Guild ban user cleanup failed:", error);
  });
});

async function handleGuildMemberAdd(member) {
  await reloadStorage();
  if (member.user.bot) return;
  await syncUserProfile(member.id, {
    username: member.user.username,
    currentRank: getRankFromMemberRoles(member)
  });
  await syncWarningsFromMemberRoles(member);
  await flushStorage();

  const {
    defaultRoleIds, alwaysAssignDefaultRoles,
    restoreNicknameOnRejoin, restoreOldRolesOnRejoin, restorableRoleIds
  } = getGuildConfig(member.guild.id);

  const snapshot = await getDepartedMemberSnapshot(member.guild.id, member.id).catch(() => null);
  const isRejoin = Boolean(snapshot);

  // "Всегда назначать начальные роли, даже перезашедшим участникам" - off by
  // default means default roles only go to genuinely new joins, not rejoins.
  if (defaultRoleIds.length && (alwaysAssignDefaultRoles || !isRejoin)) {
    const rolesToAdd = defaultRoleIds.filter((id) => member.guild.roles.cache.has(id));
    if (rolesToAdd.length) {
      await member.roles.add(rolesToAdd, "Начальные роли при вступлении").catch((error) => {
        console.error(`[${member.guild.id}] Не удалось выдать начальные роли участнику ${member.id}:`, error);
      });
    }
  }

  if (isRejoin) {
    if (restoreNicknameOnRejoin && snapshot.nickname) {
      await member.setNickname(snapshot.nickname, "Восстановление ника при перезаходе").catch((error) => {
        console.error(`[${member.guild.id}] Не удалось восстановить ник участнику ${member.id}:`, error);
      });
    }
    if (restoreOldRolesOnRejoin && restorableRoleIds.length) {
      const rolesToRestore = snapshot.roleIds.filter(
        (id) => restorableRoleIds.includes(id) && member.guild.roles.cache.has(id)
      );
      if (rolesToRestore.length) {
        await member.roles.add(rolesToRestore, "Восстановление ролей при перезаходе").catch((error) => {
          console.error(`[${member.guild.id}] Не удалось восстановить роли участнику ${member.id}:`, error);
        });
      }
    }
    await clearDepartedMemberSnapshot(member.guild.id, member.id).catch(() => null);
  }
}

client.on(Events.GuildMemberAdd, (member) => {
  handleGuildMemberAdd(member).catch((error) => {
    console.error("Guild member addition processing failed:", error);
  });
});

async function handleGuildMemberUpdate(oldMember, newMember) {
  const oldRank = getRankFromMemberRoles(oldMember);
  const newRank = getRankFromMemberRoles(newMember);
  if (oldRank === newRank) return;
  if ((botRankChanges.get(newMember.id) ?? 0) > Date.now()) return;
  await reloadStorage();

  const auditLogs = await newMember.guild.fetchAuditLogs({
    type: AuditLogEvent.MemberRoleUpdate,
    limit: 6
  }).catch(() => null);
  const auditEntry = auditLogs?.entries.find((entry) =>
    entry.target?.id === newMember.id && Date.now() - entry.createdTimestamp < 15_000
  );
  if (auditEntry?.executor?.id === newMember.client.user.id) return;

  const syncedNickname = await syncMemberRankNickname(newMember, newRank).catch((error) => {
    console.error(`Failed to synchronize nickname for ${newMember.id}:`, error);
    return null;
  });
  await addUserAudit(newMember.id, "rank", {
    oldRank,
    newRank,
    adminId: auditEntry?.executor?.id ?? "system",
    reason: "Ранг изменён вручную через роли Discord"
  });
  await sendLog(
    newMember.guild,
    new EmbedBuilder()
      .setColor(0xf2c94c)
      .setTitle("Ранг изменён через роли Discord")
      .setDescription(`<@${newMember.id}>: **${oldRank ?? "нет"} → ${newRank ?? "нет"}**.`)
      .addFields({
        name: "Администратор",
        value: auditEntry?.executor?.id ? `<@${auditEntry.executor.id}>` : "Не удалось определить",
        inline: true
      }, {
        name: "Никнейм",
        value: syncedNickname ?? "Не изменён: IC-имя или Static ID не найдены"
      })
  );
}

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  handleGuildMemberUpdate(oldMember, newMember).catch((error) => {
    console.error("Guild member update processing failed:", error);
  });
});

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.guildId && !getGuildConfig(interaction.guildId).enableSlashCommands) {
    await interaction.reply({ content: noticeMessage("Команды бота отключены на этом сервере."), flags: MessageFlags.Ephemeral }).catch(() => null);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("action-cancel:")) {
    const id = interaction.customId.slice("action-cancel:".length);
    const pending = pendingConfirmations.get(id);
    if (!pending || pending.ownerId !== interaction.user.id) {
      await interaction.deferUpdate().catch(() => null);
      return;
    }
    pendingConfirmations.delete(id);
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => null);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("action-confirm:")) {
    const id = interaction.customId.slice("action-confirm:".length);
    const pending = pendingConfirmations.get(id);
    if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAt < Date.now()) {
      pendingConfirmations.delete(id);
      await interaction.update({ content: noticeMessage("Время подтверждения истекло."), components: [] }).catch(() => null);
      return;
    }
    pendingConfirmations.delete(id);
    try {
      await handleInteraction(confirmedInteraction(pending.interaction, interaction));
    } catch (error) {
      console.error("Confirmed interaction processing failed:", error);
      await interaction.editReply({
        content: errorMessage("Не удалось выполнить действие из-за внутренней ошибки. Попробуйте ещё раз."),
        components: []
      }).catch(() => null);
    }
    return;
  }
  if (interaction.isButton() && interaction.customId === "game_afk:return" && !interaction._confirmed) {
    const current = await getGameAfkSessionQuick(interaction.guildId, interaction.user.id);
    if (current !== AFK_LOOKUP_TIMEOUT && (!current || Date.parse(current.expiresAt) <= Date.now())) {
      if (current) {
        void removeGameAfkSession(interaction.guildId, interaction.user.id);
      }
      await interaction.reply({
        content: noticeMessage("Вы сейчас не находитесь в AFK."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  const confirmation = confirmationText(interaction);
  if (confirmation) {
    await requestActionConfirmation(interaction, confirmation);
    return;
  }

  if (interaction.isButton() && interaction.customId === "game_afk:start") {
    const current = await getGameAfkSessionQuick(interaction.guildId, interaction.user.id);
    if (current !== AFK_LOOKUP_TIMEOUT && current && Date.parse(current.expiresAt) > Date.now()) {
      await interaction.reply({
        content: noticeMessage(`Вы уже находитесь в AFK и вернётесь ${gameAfkTimestamp(current.expiresAt)}.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (current && current !== AFK_LOOKUP_TIMEOUT) void removeGameAfkSession(interaction.guildId, interaction.user.id);
    await interaction.showModal(buildGameAfkModal());
    return;
  }

  if (interaction.isButton() && interaction.customId === "game_afk:return") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const session = await removeGameAfkSession(interaction.guildId, interaction.user.id);
    if (!session) {
      await interaction.editReply({ content: noticeMessage("Вы сейчас не находитесь в AFK.") });
      return;
    }
    const activeSessions = await getActiveGameAfkSessions(interaction.guildId);
    await interaction.editReply(buildGameAfkPanel(activeSessions));
    await sendLog(interaction.guild, new EmbedBuilder()
      .setColor(0x27ae60)
      .setTitle("Пользователь вернулся из AFK")
      .setDescription(`<@${interaction.user.id}> самостоятельно вернулся из AFK.`)
      .addFields(
        { name: "Причина", value: String(session.reason).slice(0, 1024) },
        { name: "Начало", value: gameAfkTimestamp(session.startedAt, "F"), inline: true },
        { name: "Планировалось до", value: gameAfkTimestamp(session.expiresAt, "F"), inline: true }
      ));
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("game_afk:start-submit:")) {
    await interaction.deferUpdate();
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const hours = Number(interaction.fields.getTextInputValue("duration").trim().replace(",", "."));
    if (!Number.isFinite(hours) || hours <= 0 || hours > GAME_AFK_MAX_HOURS) {
      await interaction.editReply({
        content: errorMessage("Укажите длительность больше 0 и не более 4 часов, например: 1 или 0,5.")
      });
      return;
    }
    const current = await getGameAfkSession(interaction.guildId, interaction.user.id);
    if (current && Date.parse(current.expiresAt) > Date.now()) {
      await interaction.editReply({
        content: noticeMessage(`Вы уже находитесь в AFK и вернётесь ${gameAfkTimestamp(current.expiresAt)}.`)
      });
      return;
    }
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + hours * 60 * 60 * 1000);
    await saveGameAfkSession({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      reason,
      startedAt,
      expiresAt
    });
    const activeSessions = await getActiveGameAfkSessions(interaction.guildId);
    await interaction.editReply(buildGameAfkPanel(activeSessions));
    await sendLog(interaction.guild, new EmbedBuilder()
      .setColor(0x2f80ed)
      .setTitle("Пользователь ушёл в AFK")
      .setDescription(`<@${interaction.user.id}> ушёл в AFK до ${gameAfkTimestamp(expiresAt.toISOString(), "F")}.`)
      .addFields(
        { name: "Причина", value: reason.slice(0, 1024) },
        { name: "Длительность", value: `${hours} ч.`, inline: true }
      ));
    return;
  }

  if (interaction.isChatInputCommand()) {
    const commandName = interaction.commandName;

    if (commandName === "ping") {
      const roundTrip = Date.now() - interaction.createdTimestamp;
      const wsPing = Math.round(interaction.client.ws.ping);
      await interaction.reply({
        content: successMessage(
          `Понг! Задержка ответа: **${roundTrip} мс**, WebSocket: **${wsPing >= 0 ? wsPing : "—"} мс**.`
        ),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (commandName === "move" && !isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Эту команду может использовать только руководство фамы."), flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === "move") {
      const source = interaction.options.getChannel("from", true);
      const destination = interaction.options.getChannel("to", true);

      if (source.type !== ChannelType.GuildVoice || destination.type !== ChannelType.GuildVoice) {
        await interaction.reply({
          content: errorMessage("Нужно выбрать два обычных голосовых канала."),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (source.id === destination.id) {
        await interaction.reply({
          content: errorMessage("Исходный и целевой каналы должны отличаться."),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const botMember = interaction.guild.members.me;
      if (
        !botMember?.permissionsIn(source).has(PermissionFlagsBits.MoveMembers) ||
        !botMember.permissionsIn(destination).has(PermissionFlagsBits.Connect)
      ) {
        await interaction.reply({
          content: errorMessage("У бота недостаточно прав для перемещения участников между этими каналами."),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({
        content: loadingMessage("Пожалуйста, подождите, участники перемещаются...")
      });
      const members = [...source.members.values()];
      let moved = 0;
      const failed = [];

      for (const member of members) {
        try {
          await member.voice.setChannel(
            destination,
            `/move: ${interaction.user.tag} (${interaction.user.id})`
          );
          moved += 1;
        } catch {
          failed.push(member.id);
        }
      }

      const result = [
        `Перемещено из ${source} в ${destination}: **${moved}/${members.length}**.`
      ];
      if (failed.length) {
        result.push(`Не удалось переместить: ${failed.map((id) => `<@${id}>`).join(", ")}.`);
      }
      await sendLog(
        interaction.guild,
        new EmbedBuilder()
          .setColor(0x2f80ed)
          .setTitle("Перемещение голосового канала")
          .setDescription(`<@${interaction.user.id}> переместил участников из ${source} в ${destination}.`)
          .addFields(
            { name: "Результат", value: `${moved}/${members.length}`, inline: true },
            { name: "Не перемещены", value: failed.length ? failed.map((id) => `<@${id}>`).join(", ").slice(0, 1024) : "Нет" }
          )
      );
      await interaction.editReply({ content: successMessage(result.join("\n")) });
      return;
    }

    if (commandName === "mute" || commandName === "unmute") {
      if (!isModerator(interaction.member)) {
        await interaction.reply({
          content: noticeMessage("Эту команду может использовать только руководство или модераторы семьи."),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      const target = interaction.options.getMember("member");
      const reason = interaction.options.getString("reason", true);
      if (!target) {
        await interaction.reply({ content: errorMessage("Участник не найден на сервере."), flags: MessageFlags.Ephemeral });
        return;
      }
      if (!target.manageable) {
        await interaction.reply({
          content: errorMessage("У бота недостаточно прав, чтобы управлять этим участником."),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (commandName === "mute") {
        const minutes = interaction.options.getInteger("minutes") ?? 60;
        try {
          await applyMute(target, { durationMs: minutes * 60 * 1000, reason: `${reason} (выдал: ${interaction.user.tag})` });
        } catch (error) {
          await interaction.editReply({ content: errorMessage(error.message) });
          return;
        }
        await dmUserEmbed(target.user, new EmbedBuilder()
          .setColor(0x000000)
          .setTitle("Вы замьючены")
          .addFields(
            { name: "Причина", value: reason },
            { name: "Длительность", value: `${minutes} мин.`, inline: true },
            { name: "Администратор", value: `<@${interaction.user.id}>` }
          ));
        await sendLog(interaction.guild, new EmbedBuilder()
          .setColor(0xeb5757)
          .setTitle("Участник замьючен")
          .setDescription(`<@${interaction.user.id}> замьютил <@${target.id}> на ${minutes} мин.`)
          .addFields({ name: "Причина", value: reason }));
        await interaction.editReply({ content: successMessage(`<@${target.id}> замьючен на **${minutes} мин.**`) });
        return;
      }

      try {
        await removeMute(target, `${reason} (снял: ${interaction.user.tag})`);
      } catch (error) {
        await interaction.editReply({ content: errorMessage(error.message) });
        return;
      }
      await dmUserEmbed(target.user, new EmbedBuilder()
        .setColor(0x000000)
        .setTitle("С вас снят мьют")
        .addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` }));
      await sendLog(interaction.guild, new EmbedBuilder()
        .setColor(0x27ae60)
        .setTitle("С участника снят мьют")
        .setDescription(`<@${interaction.user.id}> снял мьют с <@${target.id}>.`)
        .addFields({ name: "Причина", value: reason }));
      await interaction.editReply({ content: successMessage(`С <@${target.id}> снят мьют.`) });
      return;
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith("profile:")) {
    const [, action, ownerId, targetId, rawPage] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: noticeMessage("Эти кнопки принадлежат автору команды."), flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();

    if (["warn", "rank"].includes(action)) {
      const page = Number.parseInt(rawPage, 10);
      await interaction.editReply(buildProfileHistory(action, targetId, ownerId, Number.isFinite(page) ? page : 0));
      return;
    }

    if (action === "notify") {
      if (ownerId !== targetId) {
        await interaction.editReply(embedToComponentPayload(
          new EmbedBuilder().setDescription(noticeMessage("Настройку уведомлений может менять только владелец профиля."))
        ));
        return;
      }
      const updatedRecord = await updateUserRecord(targetId, (record) => {
        record.dmNotifications = !record.dmNotifications;
      });
      await sendLog(
        interaction.guild,
        new EmbedBuilder()
          .setColor(updatedRecord.dmNotifications ? 0x27ae60 : 0xeb5757)
          .setTitle("Личные уведомления изменены")
          .setDescription(`<@${targetId}> **${updatedRecord.dmNotifications ? "включил" : "выключил"}** уведомления бота.`)
      );
    }

    const target = await interaction.client.users.fetch(targetId).catch(() => interaction.user);
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const rank = getRankFromMemberRoles(member);
    const warnCount = await syncWarningsFromMemberRoles(member);
    await interaction.editReply(embedToComponentPayload(
      memberEmbed(target, rank, warnCount, member),
      [profileButtons(ownerId, targetId, rank)]
    ));
    return;
  }

  if (interaction.isButton() && interaction.customId === "support:create") {
    const nonce = crypto.randomBytes(6).toString("hex");
    await interaction.reply(buildSupportTypeSelectPayload(nonce, interaction.member));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("support:type_select:")) {
    const nonce = interaction.customId.slice("support:type_select:".length);
    const type = interaction.values[0];
    if (!isSupportTypeAvailable(type, interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Этот тип заявки вам сейчас недоступен."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildSupportDetailsModal(nonce, type));
    return;
  }

  if (interaction.isButton() && interaction.customId === "support:profile") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const rank = getRankFromMemberRoles(member);
    const warnCount = await syncWarningsFromMemberRoles(member);
    await interaction.editReply(embedToComponentPayload(
      memberEmbed(interaction.user, rank, warnCount, member),
      [profileButtons(interaction.user.id, interaction.user.id, rank)]
    ));
    return;
  }

  if (interaction.isButton() && interaction.customId === "support:afk") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const previousPanel = activeAfkPanels.get(interaction.user.id);
    activeAfkPanels.set(interaction.user.id, interaction);
    if (previousPanel && previousPanel !== interaction) {
      await previousPanel.deleteReply().catch(() => null);
    }
    const sessions = await getActiveGameAfkSessions(interaction.guildId);
    if (activeAfkPanels.get(interaction.user.id) !== interaction) {
      await interaction.deleteReply().catch(() => null);
      return;
    }
    await interaction.editReply(buildGameAfkPanel(sessions));
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("admin:")) {
    const section = interaction.customId.slice("admin:".length);
    const sectionAllowed = section === "warn" ? isModerator(interaction.member) : isLeadership(interaction.member);
    if (!sectionAllowed) {
      await interaction.reply({ content: noticeMessage("Административная панель доступна только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (section === "profile") {
      await interaction.showModal(buildAdminMembersModal("profile", "view"));
      return;
    }
    if (section === "recruitment") {
      await interaction.reply(await buildAdminRecruitmentPayload(interaction.guildId));
      return;
    }
    if (!["warn", "rank"].includes(section)) {
      await interaction.reply({ content: errorMessage("Раздел административной панели не найден."), flags: MessageFlags.Ephemeral });
      return;
    }
    const panel = buildAdminSection(section);
    await interaction.reply({ embeds: [panel.embed], components: [panel.row], flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("admin_action:")) {
    const [, system, action] = interaction.customId.split(":");
    const actionAllowed = system === "warn" ? isModerator(interaction.member) : isLeadership(interaction.member);
    if (!actionAllowed) {
      await interaction.reply({ content: noticeMessage("Это действие доступно только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!["warn", "rank"].includes(system) || !["add", "remove"].includes(action)) {
      await interaction.reply({ content: errorMessage("Действие административной панели не найдено."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(buildAdminMembersModal(system, action));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "admin_recruitment_select") {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Это действие доступно только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    const departmentId = interaction.values[0];
    const department = await getDepartmentById(interaction.guildId, departmentId);
    if (!department) {
      await interaction.update({ content: errorMessage("Отдел не найден - возможно, его уже удалили."), embeds: [], components: [] });
      return;
    }
    const nextOpen = !department.recruitmentOpen;
    await interaction.update({
      content: `Вы уверены, что хотите **${nextOpen ? "открыть" : "закрыть"}** набор в ${department.name}?`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`recruitment:confirm:${departmentId}:${nextOpen ? 1 : 0}`).setLabel("Подтвердить").setEmoji(applicationEmoji("confirm")).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("recruitment:cancel").setLabel("Отменить").setEmoji(applicationEmoji("cancel")).setStyle(ButtonStyle.Secondary)
      )]
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("admin_modal:")) {
    const [, system, action] = interaction.customId.split(":");
    const modalAllowed = system === "warn" ? isModerator(interaction.member) : isLeadership(interaction.member);
    if (!modalAllowed) {
      await interaction.reply({ content: noticeMessage("Это действие доступно только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await resolveAdminMembers(interaction.guild, interaction.fields.getTextInputValue("members"), action === "history" || system === "profile" ? 1 : 10);
    if (!members.length) {
      await interaction.editReply({ content: errorMessage("Не удалось найти участников по указанным Discord ID.") });
      return;
    }
    const target = members[0];
    if (system === "profile") {
      const rank = getRankFromMemberRoles(target);
      const warnCount = await syncWarningsFromMemberRoles(target);
      await interaction.editReply(embedToComponentPayload(memberEmbed(target.user, rank, warnCount, target), [profileButtons(interaction.user.id, target.id, rank)]));
      return;
    }
    if (action === "history") {
      await interaction.editReply(buildProfileHistory(system, target.id, interaction.user.id, 0));
      return;
    }

    const reason = interaction.fields.getTextInputValue("reason").trim();
    await interaction.editReply({ content: loadingMessage("Пожалуйста, подождите, изменения применяются...") });

    if (system === "rank") {
      const rankOrder = rankOrderFor(interaction.guildId);
      const completed = [];
      const failed = [];
      const logLines = [];
      for (const member of members) {
        const oldRank = getRankFromMemberRoles(member);
        const currentIndex = rankOrder.indexOf(oldRank);
        const nextIndex = action === "add" ? currentIndex + 1 : currentIndex - 1;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= rankOrder.length) {
          failed.push(`<@${member.id}> — ранг изменить нельзя`);
          continue;
        }
        const newRank = rankOrder[nextIndex];
        try {
          await syncMemberRankRole(member, newRank);
          const syncedNickname = await syncMemberRankNickname(member, newRank);
          await addUserAudit(member.id, "rank", { oldRank, newRank, adminId: interaction.user.id, reason });
          await dmUser(member, { embeds: [new EmbedBuilder().setColor(0x000000).setTitle("Ваш ранг изменён").setDescription(`**${rankDisplayName(interaction.guildId, oldRank)} → ${rankDisplayName(interaction.guildId, newRank)}**`).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` })] });
          completed.push(`<@${member.id}> — **${rankDisplayName(interaction.guildId, oldRank)} → ${rankDisplayName(interaction.guildId, newRank)}**${syncedNickname ? `, никнейм: **${syncedNickname}**` : ", никнейм не изменён: IC-имя или Static ID не найдены"}`);
          logLines.push(`<@${member.id}> — **${oldRank} → ${newRank}**`);
        } catch (error) {
          failed.push(`<@${member.id}> — ${error.message}`);
        }
      }
      if (logLines.length) await sendLog(interaction.guild, new EmbedBuilder().setColor(0xf2c94c).setTitle(action === "add" ? "Участники повышены" : "Участники понижены").setDescription(logLines.join("\n")).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` }));
      await interaction.editReply({
        content: adminActionResult(
          action === "add" ? "Ранг повышен у следующих участников" : "Ранг понижен у следующих участников",
          completed,
          failed
        )
      });
      return;
    }

    if (system === "warn") {
      const completed = [];
      const failed = [];
      const logLines = [];
      for (const member of members) {
        await syncWarningsFromMemberRoles(member);
        const warnings = getWarnings();
        warnings[member.id] ??= { active: [], history: [] };
        if (action === "add") {
          try {
            const count = await issueWarn(member, { reason, issuedBy: interaction.user.id });
            completed.push(`<@${member.id}> — выдан варн **${count}/3**`);
            logLines.push(`<@${member.id}> — **${count}/3**`);
          } catch {
            failed.push(`<@${member.id}> — варн выдать нельзя`);
          }
        } else {
          const removed = warnings[member.id].active.pop();
          await saveWarnings(warnings);
          if (removed) await addUserAudit(member.id, "warn", { action: "remove", adminId: interaction.user.id, reason, warnReason: removed.reason });
          await syncWarnRoles(member, warnings[member.id].active.length);
          if (removed) completed.push(`<@${member.id}> — варн снят, осталось **${warnings[member.id].active.length}/3**`);
          else failed.push(`<@${member.id}> — активных варнов нет`);
          if (removed) logLines.push(`<@${member.id}> — осталось **${warnings[member.id].active.length}/3**`);
        }
      }
      if (logLines.length) await sendLog(interaction.guild, new EmbedBuilder().setColor(action === "add" ? 0xeb5757 : 0x27ae60).setTitle(action === "add" ? "Варны выданы" : "Варны сняты").setDescription(logLines.join("\n")).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` }));
      await interaction.editReply({
        content: adminActionResult(
          action === "add" ? "Варны выданы следующим участникам" : "Варны сняты у следующих участников",
          completed,
          failed
        )
      });
      return;
    }
  }

  if (interaction.isButton() && interaction.customId === "recruitment:cancel") {
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => null);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("recruitment:confirm:")) {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Эту настройку может менять только руководство фамы."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const [, , departmentId, rawOpen] = interaction.customId.split(":");
    if (!["0", "1"].includes(rawOpen)) {
      await interaction.update({ content: errorMessage("Некорректные параметры изменения набора."), components: [] });
      return;
    }
    const department = await getDepartmentById(interaction.guildId, departmentId);
    if (!department) {
      await interaction.update({ content: errorMessage("Отдел не найден - возможно, его уже удалили."), components: [] });
      return;
    }
    await interaction.deferUpdate();
    const open = rawOpen === "1";
    await updateDepartmentForGuild(interaction.guildId, departmentId, { recruitmentOpen: open });
    await refreshApplicationPanel(interaction.guild);

    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(open ? 0x27ae60 : 0xeb5757)
        .setTitle(`Набор ${open ? "открыт" : "закрыт"}`)
        .setDescription(`<@${interaction.user.id}> изменил статус набора в **${department.name}**.`)
    );
    await interaction.editReply({
      content: successMessage(`Набор в ${department.name} **${open ? "открыт" : "закрыт"}**!`),
      components: []
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("support:close:")) {
    if (!isSupportReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может обрабатывать обращения."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("support:close:".length);
    const tickets = getSupportTickets();
    const entry = Object.entries(tickets).find(
      ([, ticket]) => ticket.uid === uid && ticket.channelId === interaction.channelId
    );
    if (!entry) {
      await interaction.reply({ content: errorMessage("Обращение не найдено."), flags: MessageFlags.Ephemeral });
      return;
    }
    const [ticketKey, ticket] = entry;
    if (ticket.status === "closed") {
      await interaction.reply({ content: noticeMessage("Обращение уже закрыто."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Это обращение ведёт <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (ticket.requestType === "rank_change") {
      const member = interaction.guild.members.cache.get(ticket.userId)
        ?? await interaction.guild.members.fetch(ticket.userId).catch(() => null);
      if (!member) {
        await interaction.reply({ content: errorMessage("Участник не найден на сервере."), flags: MessageFlags.Ephemeral });
        return;
      }
      const oldRank = getRankFromMemberRoles(member);
      if (oldRank !== 1 && oldRank !== 2) {
        await interaction.reply({
          content: errorMessage(`Изменение ранга недоступно: текущий ранг участника — ${oldRank ?? "не в фаме"}.`),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await interaction.showModal(buildRankChangeCloseModal(uid));
      return;
    }

    if (ticket.requestType === "warn_removal") {
      await interaction.showModal(buildWarnRemovalCloseModal(uid));
      return;
    }

    await interaction.deferUpdate();
    await finalizeSupportTicketClose(interaction, ticketKey, ticket, tickets);
    await interaction.editReply({
      content: successMessage(`Обращение **${ticket.uid}** закрыто!`)
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("support:warn-close:")) {
    if (!isSupportReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может обрабатывать обращения."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("support:warn-close:".length);
    const tickets = getSupportTickets();
    const entry = Object.entries(tickets).find(
      ([, ticket]) => ticket.uid === uid && ticket.channelId === interaction.channelId
    );
    if (!entry) {
      await interaction.reply({ content: errorMessage("Обращение не найдено."), flags: MessageFlags.Ephemeral });
      return;
    }
    const [ticketKey, ticket] = entry;
    if (ticket.status === "closed") {
      await interaction.reply({ content: noticeMessage("Обращение уже закрыто."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Это обращение ведёт <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const conditionMet = interaction.fields.getStringSelectValues("condition_met")[0] === "yes";

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let sideEffectNote;
    if (conditionMet) {
      const member = interaction.guild.members.cache.get(ticket.userId)
        ?? await interaction.guild.members.fetch(ticket.userId).catch(() => null);
      if (!member) {
        await interaction.editReply({ content: errorMessage("Участник не найден на сервере.") });
        return;
      }
      await syncWarningsFromMemberRoles(member);
      const warnings = getWarnings();
      warnings[member.id] ??= { active: [], history: [] };
      const removed = warnings[member.id].active.pop();
      if (!removed) {
        await interaction.editReply({ content: errorMessage("У участника нет активных предупреждений.") });
        return;
      }
      await saveWarnings(warnings);
      await addUserAudit(member.id, "warn", {
        action: "remove",
        adminId: interaction.user.id,
        reason: `Заявка на снятие варна ${ticket.uid}`,
        warnReason: removed.reason
      });
      await syncWarnRoles(member, warnings[member.id].active.length);
      sideEffectNote = `Предупреждение снято, осталось **${warnings[member.id].active.length}/3**.`;
    } else {
      sideEffectNote = "Предупреждение не снято — выполнение условия не подтверждено.";
    }

    await finalizeSupportTicketClose(interaction, ticketKey, ticket, tickets, sideEffectNote);
    await interaction.editReply({
      content: successMessage(`Обращение **${ticket.uid}** закрыто!`)
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("support:rank-change-close:")) {
    if (!isSupportReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может обрабатывать обращения."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("support:rank-change-close:".length);
    const tickets = getSupportTickets();
    const entry = Object.entries(tickets).find(
      ([, ticket]) => ticket.uid === uid && ticket.channelId === interaction.channelId
    );
    if (!entry) {
      await interaction.reply({ content: errorMessage("Обращение не найдено."), flags: MessageFlags.Ephemeral });
      return;
    }
    const [ticketKey, ticket] = entry;
    if (ticket.status === "closed") {
      await interaction.reply({ content: noticeMessage("Обращение уже закрыто."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Это обращение ведёт <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const isYes = (fieldId) => interaction.fields.getStringSelectValues(fieldId)[0] === "yes";
    const checklist = [
      { label: "сменил фамилию в нике", confirmed: isYes("surname_changed") },
      { label: "находится в планшете", confirmed: isYes("in_planshet") },
      { label: "посетил 25 РП мероприятий", confirmed: isYes("attended_events") }
    ];

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const member = interaction.guild.members.cache.get(ticket.userId)
      ?? await interaction.guild.members.fetch(ticket.userId).catch(() => null);
    if (!member) {
      await interaction.editReply({ content: errorMessage("Участник не найден на сервере.") });
      return;
    }

    let sideEffectNote;
    if (checklist.every((item) => item.confirmed)) {
      const oldRank = getRankFromMemberRoles(member);
      if (oldRank !== 1 && oldRank !== 2) {
        await interaction.editReply({
          content: errorMessage(`Изменение ранга недоступно: текущий ранг участника — ${oldRank ?? "не в фаме"}.`)
        });
        return;
      }
      const newRank = oldRank + 1;
      try {
        await syncMemberRankRole(member, newRank);
        await syncMemberRankNickname(member, newRank);
        await addUserAudit(member.id, "rank", {
          oldRank,
          newRank,
          adminId: interaction.user.id,
          reason: `Заявка на изменение ранга ${ticket.uid}`
        });
        sideEffectNote = `Ранг изменён: **${oldRank} → ${newRank}**.`;
      } catch (error) {
        await interaction.editReply({ content: errorMessage(`Не удалось изменить ранг: ${error.message}`) });
        return;
      }
    } else {
      const failed = checklist.filter((item) => !item.confirmed).map((item) => item.label);
      sideEffectNote = `Ранг не изменён — не подтверждено: ${failed.join(", ")}.`;
    }

    await finalizeSupportTicketClose(interaction, ticketKey, ticket, tickets, sideEffectNote);
    await interaction.editReply({
      content: successMessage(`Обращение **${ticket.uid}** закрыто!`)
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("support:transfer:")) {
    if (!isSupportReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может передавать обращения."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("support:transfer:".length);
    const ticket = Object.values(getSupportTickets()).find(
      (item) => item.uid === uid && item.channelId === interaction.channelId
    );
    if (!ticket || ticket.status === "closed") {
      await interaction.reply({ content: noticeMessage("Обращение не найдено или уже закрыто."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!ticket.claimedBy) {
      await interaction.reply({
        content: noticeMessage("Сначала возьмите обращение сообщением или реакцией."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Передать обращение может только <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildTicketTransferModal("support", uid));
    return;
  }

  if (interaction.isButton() && interaction.customId === "application:info") {
    await interaction.reply({ content: APPLICATION_INFO_TEXT, flags: MessageFlags.Ephemeral });
    return;
  }

  if (
    (interaction.isStringSelectMenu() && interaction.customId === "application:start") ||
    (interaction.isButton() && interaction.customId === "application:start:general")
  ) {
    const resetApplicationPanel = () =>
      buildApplicationPanel(interaction.guildId)
        .then((payload) => interaction.message.edit(payload))
        .catch((error) => {
          console.error("Failed to reset application section selector:", error);
        });

    let departmentId = null;
    let departmentName = "семью";
    let department = null;
    if (interaction.isStringSelectMenu()) {
      departmentId = interaction.values[0];
      department = await getDepartmentById(interaction.guildId, departmentId);
      if (!department?.recruitmentOpen) {
        await interaction.reply({
          content: noticeMessage("Этот состав сейчас закрыт для набора."),
          flags: MessageFlags.Ephemeral
        });
        void resetApplicationPanel();
        return;
      }
      departmentName = department.name;
    }

    const rank = getRankFromMemberRoles(interaction.member);
    if (rank) {
      await interaction.reply({
        content: noticeMessage("Подать заявку на вступление можно только участникам без роли в семье."),
        flags: MessageFlags.Ephemeral
      });
      void resetApplicationPanel();
      return;
    }

    const applications = getApplications();
    const existingApplication = getLatestApplicationForUser(interaction.user.id, applications);
    if (existingApplication && !["accepted", "rejected", "closed"].includes(existingApplication.status)) {
      await interaction.reply({
        content: noticeMessage("У вас уже есть активная заявка на вступление."),
        flags: MessageFlags.Ephemeral
      });
      void resetApplicationPanel();
      return;
    }

    if (existingApplication?.status === "rejected") {
      const rejectedApplicationClosedAt = Date.parse(existingApplication.closedAt ?? "");
      const retryAt = rejectedApplicationClosedAt + APPLICATION_REJECTION_COOLDOWN_MS;
      if (Number.isFinite(rejectedApplicationClosedAt) && Date.now() < retryAt) {
        await interaction.reply({
          content: noticeMessage(`После отклонения заявки новую можно подать ${discordTimestampFromMs(retryAt)}.`),
          flags: MessageFlags.Ephemeral
        });
        void resetApplicationPanel();
        return;
      }
    }

    await interaction.showModal(buildApplicationModal(departmentId, departmentName, department?.questions));
    if (interaction.isStringSelectMenu()) void resetApplicationPanel();
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("application:accept:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может принимать заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const uid = interaction.customId.slice("application:accept:".length);
    const rank = 2;
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: errorMessage("Заявка не найдена или не относится к этой ветке."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const [applicationKey, application] = applicationEntry;
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (application.claimedBy && application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Эту заявку ведёт <@${application.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferUpdate();
    const applications = getApplications();
    const member = interaction.guild.members.cache.get(application.userId)
      ?? await interaction.guild.members.fetch(application.userId).catch(() => null);
    if (!member) {
      await interaction.followUp({
        content: errorMessage("Кандидат больше не находится на Discord-сервере."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const familyNickname = buildFamilyNickname(interaction.guildId, rank, application.characterInfo);
    if (!familyNickname) {
      await interaction.followUp({
        content: errorMessage("Не удалось принять заявку: не получилось сформировать никнейм из данных заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    try {
      await member.setNickname(familyNickname, `Принята заявка ${application.uid}`);
    } catch (error) {
      await interaction.followUp({
        content: errorMessage(`Не удалось принять заявку: не получилось изменить никнейм кандидату. ${error.message}`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    try {
      const { verifiedMemberRoleId } = getGuildConfig(member.guild.id);
      if (verifiedMemberRoleId) {
        await member.roles.add(verifiedMemberRoleId, `Принята заявка в ${application.departmentName ?? "семью"}`);
      }
      const oldRank = getRankFromMemberRoles(member);
      await syncMemberRankRole(member, rank);
      await addUserAudit(member.id, "rank", {
        oldRank,
        newRank: rank,
        adminId: interaction.user.id,
        reason: "Принята заявка на вступление"
      });
      // requestType is the department id for a real department, or the
      // "general" sentinel for the no-department flow - only append to a
      // real department's roster.
      if (application.requestType !== "general") {
        await addMemberToDepartment(interaction.guildId, application.requestType, member.id);
      }
    } catch (error) {
      await interaction.followUp({
        content: errorMessage(`Не удалось принять заявку: не получилось выдать роли кандидату. ${error.message}`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    application.status = "accepted";
    application.claimedBy ??= interaction.user.id;
    application.closedBy = interaction.user.id;
    application.closedAt = new Date().toISOString();
    application.updatedAt = application.closedAt;
    application.decisionReason = null;
    applications[applicationKey] = application;
    const announcementRemoved = await deleteApplicationAnnouncement(interaction.guild, application);
    if (announcementRemoved) {
      application.announcementChannelId = null;
      application.announcementMessageId = null;
    }
    await saveApplications(applications);

    const user = await interaction.client.users.fetch(application.userId).catch(() => null);
    if (application.messageId) {
      const applicationMessage = await interaction.channel.messages.fetch(application.messageId).catch(() => null);
      if (applicationMessage) {
        await applicationMessage.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
      }
    }
    await dmUserEmbed(
      user,
      buildApplicationDmEmbed(
        application,
        `Заявка ${application.uid} принята`,
        `Ваша заявка принята <@${interaction.user.id}>. Добро пожаловать!`,
        0x27ae60
      )
    );
    const acceptedLog = new EmbedBuilder()
        .setColor(0x27ae60)
        .setTitle(`Заявка принята | ${application.uid}`)
        .setDescription(
          `<@${interaction.user.id}> принял заявку <@${application.userId}>.\nВетка: ${interaction.channel}\nРанг: **${rank}**`
        )
        .addFields({ name: "Никнейм", value: familyNickname });
    await sendLog(interaction.guild, acceptedLog);
    await interaction.channel.send(
      successMessage(`Заявку **${application.uid}** принял <@${interaction.user.id}>. Никнейм изменён на **${familyNickname}**.`)
    );
    if (!await closeApplicationThread(interaction.channel, "Заявка принята")) {
      throw new Error("Заявка принята, но ветку не удалось закрыть");
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("application:reject:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может отклонять заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("application:reject:".length);
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: errorMessage("Заявка не найдена или не относится к этой ветке."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const application = applicationEntry[1];
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (application.claimedBy && application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Эту заявку ведёт <@${application.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildApplicationRejectionModal(uid));
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("application:transfer:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может передавать заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("application:transfer:".length);
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: errorMessage("Заявка не найдена или не относится к этой ветке."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const application = applicationEntry[1];
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!application.claimedBy) {
      await interaction.reply({
        content: noticeMessage("Сначала возьмите заявку сообщением или реакцией."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Передать заявку может только <@${application.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildTicketTransferModal("application", uid));
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("support:create-submit:")) {
    const [, , , requestType] = interaction.customId.split(":");
    const fields = SUPPORT_TYPE_FIELDS[requestType];
    if (!Object.hasOwn(SUPPORT_REQUEST_TYPES, requestType) || !fields) {
      await interaction.reply({
        content: errorMessage("Не удалось проверить форму. Выберите тип заявки заново."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (!isSupportTypeAvailable(requestType, interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Этот тип заявки вам сейчас недоступен."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const values = fields.map((field) => ({
      label: field.label,
      value: interaction.fields.getTextInputValue(field.id).trim(),
      isLink: field.isLink
    }));
    if (values.some(({ value }) => value.length < 2)) {
      await interaction.reply({
        content: errorMessage("Не удалось проверить форму. Подробно заполните все поля заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (values.some(({ value, isLink }) => isLink && !isValidLinkUrl(value))) {
      await interaction.reply({
        content: errorMessage("Не удалось проверить форму. В полях со ссылкой укажите корректную ссылку (начинается с http:// или https://)."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const details = values.map(({ label, value }) => `${label}: ${value}`).join("\n");
    await createGeneralSupportTicket(interaction, requestType, details);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket:transfer-target:")) {
    const [, , scope, uid] = interaction.customId.split(":");
    if (!["application", "support"].includes(scope) || !uid) {
      await interaction.reply({
        content: errorMessage("Некорректная форма передачи заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const isApplication = scope === "application";
    const canTransfer = isApplication
      ? isApplicationReviewer(interaction.member)
      : isSupportReviewer(interaction.member);
    if (!canTransfer) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может передавать заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const records = isApplication ? getApplications() : getSupportTickets();
    const entry = Object.entries(records).find(
      ([, ticket]) => ticket.uid === uid && ticket.channelId === interaction.channelId
    );
    if (!entry) {
      await interaction.reply({
        content: errorMessage("Заявка не найдена или не относится к этой ветке."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const [ticketKey, ticket] = entry;
    if (["accepted", "rejected", "closed"].includes(ticket.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!ticket.claimedBy) {
      await interaction.reply({
        content: noticeMessage("Сначала возьмите заявку сообщением или реакцией."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Передать заявку может только <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, заявка передаётся...")
    });
    const targetInput = interaction.fields.getTextInputValue("target");
    const resolved = await resolveTicketTransferMember(interaction.guild, targetInput);
    if (resolved.error) {
      await interaction.editReply({ content: errorMessage(resolved.error) });
      return;
    }

    const targetMember = resolved.member;
    const validationError = validateTicketTransferMember(targetMember, ticket, scope);
    if (validationError) {
      await interaction.editReply({ content: errorMessage(validationError) });
      return;
    }

    const previousAdminId = ticket.claimedBy;
    ticket.claimedBy = targetMember.id;
    ticket.status = "in_review";
    ticket.updatedAt = new Date().toISOString();
    records[ticketKey] = ticket;
    if (isApplication) await saveApplications(records);
    else await saveSupportTickets(records);

    await keepOnlyTicketParticipants(interaction.channel, [
      ticket.userId,
      targetMember.id,
      interaction.client.user.id
    ]);
    await setApplicantCanWrite(interaction.channel, ticket.userId, true);

    const applicant = await interaction.client.users.fetch(ticket.userId).catch(() => null);
    const entityName = isApplication ? "Заявка" : "Обращение";
    const transferVerb = isApplication ? "передана" : "передано";
    await interaction.channel.send(
      successMessage(`${entityName} **${ticket.uid}** ${transferVerb} <@${previousAdminId}> → <@${targetMember.id}>.`)
    );
    await sendLog(
      interaction.guild,
    new EmbedBuilder()
      .setColor(0x000000)
        .setTitle(`${isApplication ? "Заявка передана" : "Обращение передано"} | ${ticket.uid}`)
        .setDescription(`<@${interaction.user.id}> передал ${isApplication ? "заявку" : "обращение"}.`)
        .addFields(
          { name: "От кого", value: `<@${previousAdminId}>`, inline: true },
          { name: "Кому", value: `<@${targetMember.id}>`, inline: true },
          { name: "Заявитель", value: `<@${ticket.userId}>`, inline: true }
        )
    );
    await dmUserEmbed(
      applicant,
      new EmbedBuilder()
        .setColor(0x000000)
        .setTitle(`${entityName} ${ticket.uid} ${transferVerb}`)
        .setDescription(
          `${isApplication ? "Ваша заявка передана администратору" : "Ваше обращение передано администратору"} <@${targetMember.id}>.\n\n${isApplication ? "Открыть заявку" : "Открыть обращение"}: ${interaction.channel}`
        )
    );
    await interaction.editReply({
      content: successMessage(`${entityName} **${ticket.uid}** ${transferVerb} <@${targetMember.id}>!`)
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("application:reject-reason:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может отклонять заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const uid = interaction.customId.split(":")[2];
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: errorMessage("Заявка не найдена или не относится к этой ветке."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const [applicationKey, application] = applicationEntry;
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (application.claimedBy && application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Эту заявку ведёт <@${application.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, заявка отклоняется...")
    });
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const applications = getApplications();
    application.status = "rejected";
    application.claimedBy ??= interaction.user.id;
    application.closedBy = interaction.user.id;
    application.closedAt = new Date().toISOString();
    application.updatedAt = application.closedAt;
    application.decisionReason = reason;
    applications[applicationKey] = application;
    const announcementRemoved = await deleteApplicationAnnouncement(interaction.guild, application);
    if (announcementRemoved) {
      application.announcementChannelId = null;
      application.announcementMessageId = null;
    }
    await saveApplications(applications);

    const user = await interaction.client.users.fetch(application.userId).catch(() => null);
    if (application.messageId) {
      const message = await interaction.channel.messages.fetch(application.messageId).catch(() => null);
      if (message) {
        await message.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
      }
    }
    await dmUserEmbed(
        user,
        buildApplicationDmEmbed(
          application,
          `Заявка ${application.uid} отклонена`,
          "Заявку на вступление можно будет подать повторно через 10 дней.",
          0xeb5757
        )
      );
    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(0xeb5757)
        .setTitle(`Заявка отклонена | ${application.uid}`)
        .setDescription(
          `<@${interaction.user.id}> отклонил заявку <@${application.userId}>.\nПричина: **${reason}**\nВетка: ${interaction.channel}`
        )
    );
    await interaction.channel.send(
      successMessage(`Заявку **${application.uid}** отклонил <@${interaction.user.id}>.`)
    );
    if (!await closeApplicationThread(interaction.channel, "Заявка отклонена")) {
      throw new Error("Заявка отклонена, но ветку не удалось закрыть");
    }
    await interaction.editReply({ content: successMessage(`Заявка **${application.uid}** отклонена!`) });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("family_application:")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const departmentIdRaw = interaction.customId.split(":")[1];
    const isGeneral = !departmentIdRaw || departmentIdRaw === "general";
    let departmentName = "семью";
    let department = null;
    if (!isGeneral) {
      department = await getDepartmentById(interaction.guildId, departmentIdRaw);
      if (!department) {
        await interaction.editReply({ content: errorMessage("Не удалось определить выбранный состав.") });
        return;
      }
      if (!department.recruitmentOpen) {
        await interaction.editReply({
          content: noticeMessage(`Набор в ${department.name} уже закрыт.`)
        });
        return;
      }
      departmentName = department.name;
    }

    const rank = await getRankFromUser(interaction.guild, interaction.user.id);
    if (rank) {
      await interaction.editReply({
        content: noticeMessage("Подать заявку на вступление можно только участникам без роли в семье.")
      });
      return;
    }

    const applications = getApplications();
    const existingApplication = getLatestApplicationForUser(interaction.user.id, applications);
    if (existingApplication && !["accepted", "rejected", "closed"].includes(existingApplication.status)) {
      await interaction.editReply({ content: noticeMessage("У вас уже есть активная заявка на вступление.") });
      return;
    }
    if (existingApplication?.status === "rejected") {
      const rejectedAt = Date.parse(existingApplication.closedAt ?? "");
      const retryAt = rejectedAt + APPLICATION_REJECTION_COOLDOWN_MS;
      if (Number.isFinite(rejectedAt) && Date.now() < retryAt) {
        await interaction.editReply({
          content: noticeMessage(`После отклонения заявки новую можно подать ${discordTimestampFromMs(retryAt)}.`)
        });
        return;
      }
    }

    const characterInfo = interaction.fields.getTextInputValue("character");
    const characterParts = characterInfo.split("/").map((part) => part.trim());
    const validCharacterInfo = characterParts.length === 3 &&
      characterParts.every(Boolean) &&
      /^\d+$/.test(characterParts[1]) &&
      /^\d+$/.test(characterParts[2]);
    if (!validCharacterInfo) {
      await interaction.editReply({
        content: errorMessage("Укажите данные в формате: IC имя / уровень персонажа / Static ID.")
      });
      return;
    }
    const customQuestions = Array.isArray(department?.questions) ? department.questions.slice(0, 4) : [];
    let oocAge = null;
    let reason = null;
    let charactersLink = null;
    let customAnswers = null;
    if (customQuestions.length > 0) {
      customAnswers = customQuestions.map((question, index) => ({
        label: question.label,
        value: interaction.fields.getTextInputValue(`q${index}`)
      }));
    } else {
      oocAge = interaction.fields.getTextInputValue("ooc_age");
      reason = interaction.fields.getTextInputValue("reason");
      charactersLink = interaction.fields.getTextInputValue("characters_link").trim();
      if (!isValidLinkUrl(charactersLink)) {
        await interaction.editReply({
          content: errorMessage("Укажите корректную ссылку на скриншот (начинается с http:// или https://).")
        });
        return;
      }
    }

    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, ваша заявка создаётся...")
    });

    const uid = createTicketUid("A", applications, getSupportTickets());
    const applicationKey = `${interaction.user.id}-${Date.now()}`;
    const channel = await createApplicationChannel(interaction, uid);
    const application = {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      uid,
      channelId: channel.id,
      messageId: null,
      status: "new",
      requestType: isGeneral ? "general" : departmentIdRaw,
      departmentName,
      characterInfo,
      oocAge,
      reason,
      charactersLink,
      customAnswers,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    applications[applicationKey] = application;
    await saveApplications(applications);

    const message = await channel.send(buildApplicationMessagePayload(application, interaction.user));
    applications[applicationKey].messageId = message.id;
    await saveApplications(applications);

    await addTicketThreadMembers(channel, [interaction.user.id]);
    await interaction.editReply({ content: successMessage(`Заявка создана! ${channel}`) });
    await dmUserEmbed(
      interaction.user,
      buildApplicationDmEmbed(
        application,
        "Заявка создана",
        `Ваша заявка в **${interaction.guild.name}** создана и направлена администрации. Ожидайте начала рассмотрения.`,
        0x56ccf2,
        [
          { name: "Статус", value: applicationStatusLabel(application.status), inline: true }
        ]
      )
    );
    await channel.setInvitable(false, "Все участники заявки добавлены").catch((error) => {
      console.error(`Failed to disable invitations for ticket thread ${channel.id}:`, error);
    });

    const applicationsChannelId = getGuildConfig(interaction.guildId).applicationsChannelId;
    const applicationsChannel = applicationsChannelId
      ? await interaction.guild.channels.fetch(applicationsChannelId).catch(() => null)
      : null;
    if (applicationsChannel?.isTextBased() && applicationsChannel.id !== channel.id) {
      const announcement = await applicationsChannel.send(
        noticeMessage(`Новая заявка в **${application.departmentName}** **${uid}**: ${channel}`)
      );
      const latestApplications = getApplications();
      if (latestApplications[applicationKey]?.channelId === channel.id) {
        latestApplications[applicationKey].announcementChannelId = applicationsChannel.id;
        latestApplications[applicationKey].announcementMessageId = announcement.id;
        await saveApplications(latestApplications);
      }
    }

    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(0x56ccf2)
        .setTitle(`Заявка на вступление | ${uid}`)
        .setDescription(`<@${interaction.user.id}> создал заявку в ${interaction.guild.name}.`)
        .addFields(
          { name: "UID", value: uid, inline: true },
          { name: "Состав", value: application.departmentName, inline: true },
          { name: "IC имя / уровень / Static ID", value: String(application.characterInfo).slice(0, 1024) },
          application.customAnswers?.length
            ? { name: application.customAnswers[0].label, value: String(application.customAnswers[0].value).slice(0, 1024), inline: true }
            : { name: "OOC возраст", value: String(application.oocAge).slice(0, 1024), inline: true }
        )
    );

  }

}

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(async (error) => {
    console.error("Interaction processing failed:", error);
    if (!interaction.isRepliable()) return;

    const content = errorMessage("Не удалось выполнить действие из-за внутренней ошибки. Попробуйте ещё раз.");
    if (interaction.deferred) {
      if (interaction.message?.flags?.has(MessageFlags.IsComponentsV2)) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }
      await interaction.editReply({ content }).catch(() => null);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
  });
});

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  throw new Error("Сначала укажите DISCORD_TOKEN в .env.");
}

async function startBot() {
  await initStorage();
  startApiAndHealthServer(client);
  await client.login(DISCORD_TOKEN);
}

async function shutdown(signal) {
  console.log(`Received ${signal}, closing PostgreSQL storage.`);
  await closeStorage().catch((error) => console.error("Failed to close PostgreSQL storage:", error));
  client.destroy();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

startBot().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exitCode = 1;
});
