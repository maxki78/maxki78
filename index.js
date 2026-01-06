import "dotenv/config";
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
} from "discord.js";
import logger from "./utils/logger.js";
import { connectToDatabase, disconnectFromDatabase } from "./services/database.js";
import { createContext } from "./context/createContext.js";
import { loadSlashCommands } from "./commands/slash/index.js";
import { loadMessageCommands } from "./commands/message/index.js";
import { checkCommandStatus } from "./services/commandStatus.js";
import { tryApplyCooldown } from "./utils/cooldown.js";
import { formatCooldown } from "./utils/formatCooldown.js";
import { startServerDataPoller } from "./tasks/serverDataPoller.js";
import { startEmbedUpdater } from "./tasks/embedUpdater.js";
import { register } from "./scripts/registerCommands.js";

async function ensureOwnersHaveTeamRank(context, ownerIds) {
  if (!ownerIds?.size) return;
  const teamUsers = context.collections?.teamUsers;
  if (!teamUsers) return;

  const operations = [];
  for (const ownerId of ownerIds) {
    const update = {
      $setOnInsert: { _id: String(ownerId) },
      $set: { Rank: "Founder", Admin: true },
      $unset: { ReadOnly: "", DevOnly: "" },
    };
    operations.push(
      teamUsers.updateOne({ _id: String(ownerId) }, update, { upsert: true })
    );
  }

  try {
    await Promise.all(operations);
    logger.info(
      { ownerIds: Array.from(ownerIds) },
      "Synced bot owner team privileges"
    );
  } catch (error) {
    logger.warn({ err: error }, "Failed to sync bot owner team privileges");
  }
}

async function bootstrap() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN environment variable is required");
  }

  try {
    logger.info("Registering slash commands...");
    await register();
    logger.info("Slash commands registered successfully");
  } catch (error) {
    logger.error({ err: error }, "Failed to register slash commands");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.GuildMember, Partials.Channel, Partials.Message],
    shards: process.env.SHARD_COUNT ? Number(process.env.SHARD_COUNT) : "auto",
  });

  const database = await connectToDatabase();
  const context = await createContext(client, database);

  const slashCommands = loadSlashCommands(context);
  const messageCommands = loadMessageCommands(context);

  client.commands = new Collection();
  for (const [name, command] of slashCommands) {
    client.commands.set(name, command);
  }

  const noopAsync = async () => {};
  let stopServerDataTask = noopAsync;
  let embedUpdater = { stop: noopAsync };

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(
      {
        username: readyClient.user.tag,
        id: readyClient.user.id,
        shardCount: readyClient.shard?.count ?? 1,
      },
      "Bot ready"
    );

    try {
      await readyClient.user.setPresence({
        activities: [
        {
          name: "🖥️ Monitored by EH-Stats",
          type: 4,
        },
        ],
        status: "online",
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to update bot presence");
    }

    try {
      const application = await readyClient.application?.fetch();
      const ownerIds = context.ownerIds ?? new Set();
      ownerIds.clear();

      const owner = application?.owner;
      if (owner) {
        if ("ownerId" in owner && owner.ownerId) {
          const ownerMember = owner.members?.get(owner.ownerId);
          const id = ownerMember?.user?.id;
          if (id) ownerIds.add(String(id));
        } else if ("id" in owner && owner.id) {
          ownerIds.add(String(owner.id));
        }
      }

      if (ownerIds.size === 0 && readyClient.user?.id) {
        ownerIds.add(String(readyClient.user.id));
      }

      context.ownerIds = ownerIds;
      logger.info({ ownerIds: Array.from(ownerIds) }, "Resolved bot owner account (single-owner mode)");

      await ensureOwnersHaveTeamRank(context, ownerIds);
    } catch (error) {
      logger.warn({ err: error }, "Failed to resolve bot owner accounts");
      if (readyClient.user?.id) {
        const ownerIds = context.ownerIds ?? new Set();
        ownerIds.add(String(readyClient.user.id));
        context.ownerIds = ownerIds;
        await ensureOwnersHaveTeamRank(context, ownerIds);
      }
    }

    try {
      stopServerDataTask = startServerDataPoller(context) ?? noopAsync;
      embedUpdater = startEmbedUpdater(context) ?? { stop: noopAsync };
    } catch (error) {
      logger.error({ err: error }, "Failed to start background tasks");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (context.teamModule?.guards?.checkInteraction) {
      try {
        const blocked = await context.teamModule.guards.checkInteraction(interaction);
        if (blocked) return;
      } catch (error) {
        logger.error(
          { err: error, type: interaction.type },
          "Failed during interaction blacklist guard"
        );
      }
    }

    if (!interaction.isChatInputCommand()) return;

    const command = slashCommands.get(interaction.commandName);
    if (!command) {
      logger.warn(
        { commandName: interaction.commandName },
        "Received unknown slash command"
      );
      return;
    }

    try {
      if (command.cooldown) {
        const remaining = tryApplyCooldown(
          context.cooldowns.slash,
          command.data.name,
          interaction.user.id,
          command.cooldown
        );
        if (remaining > 0) {
          const formatted = await formatCooldown(remaining, context.translations, interaction.guildId);
          await interaction.reply({
            content: formatted,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      const blocked = await checkCommandStatus(interaction, command.data.name, context);
      if (blocked) return;

      await command.execute(interaction, context);
    } catch (error) {
      logger.error(
        { err: error, command: interaction.commandName },
        "Slash command failed"
      );
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "❌ An unexpected error occurred while executing this command.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.followUp({
            content: "❌ An unexpected error occurred while executing this command.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyError) {
        if (replyError?.code !== 10062) {
          logger.error({ err: replyError }, "Failed to send error response for interaction");
        }
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.inGuild()) return;

    const botId = client.user.id;
    const mentionPrefix = new RegExp(`^<@!?${botId}>\\s*!`, "i");
    const defaultPrefix = "!";

    let content = message.content.trim();
    let usedPrefix = null;

    if (mentionPrefix.test(content)) {
      usedPrefix = content.match(mentionPrefix)[0];
      content = content.slice(usedPrefix.length).trim();
    } else if (content.startsWith(defaultPrefix)) {
      usedPrefix = defaultPrefix;
      content = content.slice(defaultPrefix.length).trim();
    } else {
      return;
    }

    if (!content.length) return;

    const args = content.split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const command = messageCommands.get(commandName);
    if (!command) return;

    if (context.teamModule?.guards?.checkMessage) {
      const allowedMessage = await context.teamModule.guards.checkMessage(message);
      if (!allowedMessage) return;
    }

    if (context.teamModule?.guards?.ensureAccess) {
      const allowed = await context.teamModule.guards.ensureAccess(message);
      if (!allowed) return;
    }

    try {
      if (command.cooldown) {
        const remaining = tryApplyCooldown(
          context.cooldowns.message,
          command.name,
          message.author.id,
          command.cooldown
        );
        if (remaining > 0) {
          const formatted = await formatCooldown(remaining, context.translations, message.guildId);
          if (formatted) {
            await message.reply(formatted);
          }
          return;
        }
      }

      await command.execute(message, args, context);
    } catch (error) {
      logger.error({ err: error, command: commandName }, "Message command failed");
      await message.reply(
        "❌ Es ist ein unerwarteter Fehler beim Ausführen des Befehls aufgetreten."
      );
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    if (context.teamModule?.guards?.handleGuildJoin) {
      try {
        await context.teamModule.guards.handleGuildJoin(guild);
      } catch (error) {
        logger.error({ err: error, guildId: guild.id }, "Failed handling guild join guard");
      }
    }
  });

  const withTimeout = (promise, ms, label) => {
    return Promise.race([
      Promise.resolve().then(() => promise),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  };

  let shuttingDown = false;
  let forceExitTimer = null;

  const shutdown = async (signal = "manual") => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Shutting down bot...");

    const totalTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15000);
    forceExitTimer = setTimeout(() => {
      logger.error({ totalTimeoutMs }, "Force exiting after shutdown timeout");
      process.exit(1);
    }, totalTimeoutMs + 1000);

    try {
      await withTimeout(stopServerDataTask(), Math.min(8000, totalTimeoutMs), "stopServerDataTask").catch(
        (err) => logger.warn({ err }, "Timed out stopping server data poller")
      );

      await withTimeout(embedUpdater.stop(), Math.min(8000, totalTimeoutMs), "embedUpdater.stop").catch(
        (err) => logger.warn({ err }, "Timed out stopping embed updater")
      );

      try {
        client?.destroy();
      } catch (err) {
        logger.warn({ err }, "Client destroy failed");
      }

      await withTimeout(disconnectFromDatabase(), Math.min(8000, totalTimeoutMs), "disconnectFromDatabase").catch(
        (err) => logger.warn({ err }, "Timed out disconnecting database")
      );

      logger.info("Shutdown complete");
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "Error during shutdown");
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
    shutdown("unhandledRejection");
  });

  await client.login(token);
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Failed to bootstrap bot");
  process.exit(1);
});
