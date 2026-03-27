import { Client } from 'discord.js-selfbot-v13';
import config from './config.js';
import logger from './logger.js';
import { forwardMessage, forwardEdit, forwardDelete } from './forwarder.js';

/**
 * discord self-bot — message forwarder
 *
 * monitors all messages in a specific server and forwards them
 * to a destination channel via webhook.
 */

const client = new Client({
  checkUpdate: false,
});

// session statistics
let stats = {
  forwarded: 0,
  edited: 0,
  deleted: 0,
  excluded: 0,
  errors: 0,
  startTime: null,
};

client.on('ready', () => {
  stats.startTime = Date.now();

  console.log('\n--- Discord Message Forwarder Started ---');
  console.log(`Account:  ${client.user.tag}`);
  console.log(`Server:   ${config.sourceGuildId}`);
  console.log(`Webhooks: ${config.defaultWebhookUrls.length}`);
  console.log(`Routes:   ${config.channelRoutes.size}`);
  console.log(`Excluded: ${config.excludedChannelIds.size}`);
  console.log('-----------------------------------------\n');

  if (config.excludedChannelIds.size > 0) {
    logger.info(`excluded channels: ${[...config.excludedChannelIds].join(', ')}`);
  }

  logger.success('listening for new messages...');
  console.log('');
});

client.on('messageCreate', async (message) => {
  try {
    // ignore messages from other servers
    if (!message.guild || message.guild.id !== config.sourceGuildId) {
      return;
    }

    // ignore own messages
    if (config.ignoreSelf && message.author.id === client.user.id) {
      return;
    }

    // prevent infinite loops from our own webhooks
    if (message.webhookId && config.webhookIds.has(message.webhookId)) {
      return;
    }

    // check if the channel is in the exclusion list
    if (config.excludedChannelIds.has(message.channel.id)) {
      stats.excluded++;
      return;
    }

    // ignore system messages
    if (message.system) {
      return;
    }

    // verify there is content to forward
    const hasContent = message.content && message.content.length > 0;
    const hasEmbeds = message.embeds.length > 0;
    const hasAttachments = message.attachments.size > 0;
    const hasStickers = message.stickers && message.stickers.size > 0;

    if (!hasContent && !hasEmbeds && !hasAttachments && !hasStickers) {
      return;
    }

    // forward the message
    await forwardMessage(message);
    stats.forwarded++;
  } catch (err) {
    stats.errors++;
    logger.error(`error handling message: ${err.message}`);
  }
});

// handle edited messages
// critical for surebet signals as odds might change
client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage.guild || newMessage.guild.id !== config.sourceGuildId) return;
    if (config.excludedChannelIds.has(newMessage.channel.id)) return;
    if (newMessage.webhookId && config.webhookIds.has(newMessage.webhookId)) return;
    if (newMessage.system) return;

    await forwardEdit(newMessage);
    stats.edited++;
  } catch (err) {
    stats.errors++;
    logger.error(`error handling edit: ${err.message}`);
  }
});

// handle deleted messages
// critical for surebet signals as deleted = signal no longer valid
client.on('messageDelete', async (message) => {
  try {
    // deleted messages can be partial (uncached), so use optional chaining
    if (message.guild?.id !== config.sourceGuildId) return;
    if (config.excludedChannelIds.has(message.channel?.id)) return;
    if (message.webhookId && config.webhookIds.has(message.webhookId)) return;

    await forwardDelete(message);
    stats.deleted++;
  } catch (err) {
    stats.errors++;
    logger.error(`error handling delete: ${err.message}`);
  }
});

// --- event wrappers ---
client.on('error', (err) => {
  logger.error(`client error: ${err.message}`);
});

client.on('warn', (msg) => {
  logger.warn(`client warning: ${msg}`);
});

client.on('disconnect', () => {
  logger.warn('disconnected from discord. automatic reconnection attempt...');
});

client.on('reconnecting', () => {
  logger.info('reconnecting...');
});

// graceful shutdown
function shutdown(signal) {
  console.log('');
  logger.info(`received ${signal}. shutting down...`);

  const uptime = stats.startTime
    ? Math.round((Date.now() - stats.startTime) / 1000 / 60)
    : 0;

  console.log('\n--- Session Statistics ---');
  console.log(`Uptime:    ${uptime} minutes`);
  console.log(`Forwarded: ${stats.forwarded}`);
  console.log(`Edited:    ${stats.edited}`);
  console.log(`Deleted:   ${stats.deleted}`);
  console.log(`Excluded:  ${stats.excluded}`);
  console.log(`Errors:    ${stats.errors}`);
  console.log('--------------------------\n');

  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// catch unhandled errors so PM2 can restart cleanly
process.on('unhandledRejection', (err) => {
  logger.error(`unhandled promise rejection: ${err?.message || err}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`uncaught exception: ${err.message}`);
  process.exit(1);
});

// startup
logger.info('starting self-bot...');
client
  .login(config.token)
  .catch((err) => {
    logger.error(`failed to login: ${err.message}`);
    logger.error('check that the token in .env is correct and valid.');
    process.exit(1);
  });
