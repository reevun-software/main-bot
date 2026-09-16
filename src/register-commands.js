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
    .setDescription("Проверить, что бот на связи, и посмотреть задержку.")
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
