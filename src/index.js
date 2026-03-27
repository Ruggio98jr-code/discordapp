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

// ─── session statistics ───────────────────────────────────
let stats = {
  forwarded: 0,
  edited: 0,
  deleted: 0,
  excluded: 0,
  errors: 0,
  startTime: null,
};

// ─── event: ready ─────────────────────────────────────────
client.on('ready', () => {
  stats.startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      DISCORD MESSAGE FORWARDER — ACTIVE          ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  account:  ${client.user.tag.padEnd(37)}║`);
  console.log(`║  server:   ${config.sourceGuildId.padEnd(37)}║`);
  console.log(`║  webhooks: ${String(config.defaultWebhookUrls.length).padEnd(37)}║`);
  console.log(`║  routes:   ${String(config.channelRoutes.size).padEnd(37)}║`);
  console.log(`║  excluded: ${String(config.excludedChannelIds.size).padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  if (config.excludedChannelIds.size > 0) {
    logger.info(`excluded channels: ${[...config.excludedChannelIds].join(', ')}`);
  }

  logger.success('listening for new messages...');
  console.log('');
});

// ─── event: new message ───────────────────────────────────
client.on('messageCreate', async (message) => {
  try {
    // 1. ignore messages from other servers
    if (!message.guild || message.guild.id !== config.sourceGuildId) {
      return;
    }

    // 2. ignore own messages (if configured)
    if (config.ignoreSelf && message.author.id === client.user.id) {
      return;
    }

    // 3. prevent infinite loops: ignore messages sent by our own webhooks
    if (message.webhookId && config.webhookIds.has(message.webhookId)) {
      return;
    }

    // 4. check if the channel is in the exclusion list
    if (config.excludedChannelIds.has(message.channel.id)) {
      stats.excluded++;
      return;
    }

    // 4. ignore system messages (join, boost, etc.)
    if (message.system) {
      return;
    }

    // 5. verify there is content to forward
    const hasContent = message.content && message.content.length > 0;
    const hasEmbeds = message.embeds.length > 0;
    const hasAttachments = message.attachments.size > 0;
    const hasStickers = message.stickers && message.stickers.size > 0;

    if (!hasContent && !hasEmbeds && !hasAttachments && !hasStickers) {
      return;
    }

    // 6. forward the message
    await forwardMessage(message);
    stats.forwarded++;
  } catch (err) {
    stats.errors++;
    logger.error(`error handling message: ${err.message}`);
  }
});

// ─── event: message edited ────────────────────────────────
// critical for surebet signals: odds can change after initial post
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

// ─── event: message deleted ───────────────────────────────
// critical for surebet signals: deleted = signal no longer valid
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

// ─── event: errors and warnings ───────────────────────────
client.on('error', (err) => {
  logger.error(`client error: ${err.message}`);
});

client.on('warn', (msg) => {
  logger.warn(`client warning: ${msg}`);
});

// ─── event: disconnect ───────────────────────────────────
client.on('disconnect', () => {
  logger.warn('disconnected from discord. automatic reconnection attempt...');
});

// ─── event: reconnecting ─────────────────────────────────
client.on('reconnecting', () => {
  logger.info('reconnecting...');
});

// ─── graceful shutdown ───────────────────────────────────
function shutdown(signal) {
  console.log('');
  logger.info(`received ${signal}. shutting down...`);

  const uptime = stats.startTime
    ? Math.round((Date.now() - stats.startTime) / 1000 / 60)
    : 0;

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║              SESSION STATISTICS                  ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  uptime:     ${String(uptime + ' minutes').padEnd(35)}║`);
  console.log(`║  forwarded:  ${String(stats.forwarded).padEnd(35)}║`);
  console.log(`║  edited:     ${String(stats.edited).padEnd(35)}║`);
  console.log(`║  deleted:    ${String(stats.deleted).padEnd(35)}║`);
  console.log(`║  excluded:   ${String(stats.excluded).padEnd(35)}║`);
  console.log(`║  errors:     ${String(stats.errors).padEnd(35)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── catch unhandled errors so PM2 can restart cleanly ───
process.on('unhandledRejection', (err) => {
  logger.error(`unhandled promise rejection: ${err?.message || err}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`uncaught exception: ${err.message}`);
  process.exit(1);
});

// ─── startup ─────────────────────────────────────────────
logger.info('starting self-bot...');
client
  .login(config.token)
  .catch((err) => {
    logger.error(`failed to login: ${err.message}`);
    logger.error('check that the token in .env is correct and valid.');
    process.exit(1);
  });
