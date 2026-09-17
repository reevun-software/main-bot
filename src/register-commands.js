require("dotenv").config();

const { ChannelType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

// Every command is global now - the bot is meant to work in any guild it's
// added to, not just one hardcoded DISCORD_GUILD_ID. A global command's
// permission defaults (setDefaultMemberPermissions) still apply per-guild
// on Discord's side, so /move stays admin-only everywhere without a
// per-guild registration step.
const globalCommands = [
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Переместить всех участников из одного голосового канала в другой.")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((option) =>
      option
        .setName("from")
        .setDescription("Голосовой канал, из которого нужно переместить участников")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("to")
        .setDescription("Голосовой канал, в который нужно переместить участников")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Проверить, что бот на связи, и посмотреть задержку."),
  // Discord's own ModerateMembers default is a coarse guild-side gate - the
  // actual check (moderator_role_ids or leadership, see isModerator in
  // index.js) happens in the interaction handler, since Discord has no
  // concept of this bot's custom moderator-role list.
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Замьютить участника.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option.setName("member").setDescription("Участник, которого нужно замьютить").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Причина мьюта").setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Длительность в минутах (по умолчанию 60, максимум 40320 — 28 суток)")
        .setMinValue(1)
        .setMaxValue(40320)
    ),
  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Снять мьют с участника.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option.setName("member").setDescription("Участник, с которого нужно снять мьют").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Причина снятия мьюта").setRequired(true)
    )
].map((command) => command.toJSON());

async function main() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    throw new Error("Сначала заполните DISCORD_TOKEN и DISCORD_CLIENT_ID в .env.");
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
    body: globalCommands
  });

  // One-time cleanup: /move used to be registered as a guild-scoped command
  // for this one guild. Push an empty guild command set to clear that stale
  // registration now that it lives in globalCommands instead - otherwise
  // Discord would show it twice (once global, once guild-scoped) until
  // manually cleared. Only runs when DISCORD_GUILD_ID is still set; safe to
  // remove this block (and the env var) once confirmed clean.
  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: [] });
  }

  console.log(`Зарегистрировано глобальных slash-команд: ${globalCommands.length}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { globalCommands };
