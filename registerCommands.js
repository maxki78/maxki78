import "dotenv/config";
import { REST, Routes } from "discord.js";
import { getSlashCommandData } from "../commands/slash/index.js";
import logger from "../utils/logger.js";

export async function register() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set");
  }
  const rest = new REST({ version: "10" }).setToken(token);
  const commandsData = getSlashCommandData();
  const body = commandsData.map((command) => command.toJSON());
  const guild = process.argv.includes("--guild");
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guild && !guildId) {
    throw new Error("DISCORD_GUILD_ID must be set when using --guild");
  }
  if (guild) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    logger.info({ guildId }, "Registered guild slash commands");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    logger.info("Registered global slash commands");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  register().catch((error) => {
    logger.error({ err: error }, "Failed to register commands");
    process.exit(1);
  });
}
