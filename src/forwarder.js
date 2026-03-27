import config from './config.js';
import logger from './logger.js';

/**
 * handles instant forwarding of discord messages via multiple webhooks.
 *
 * supports per-channel routing: specific source channels can be routed
 * to specific destination webhooks. unrouted channels use the default pool.
 *
 * uses round-robin across webhooks to handle high throughput.
 */

const MAX_CONTENT_LENGTH = 2000;
const MAX_RETRIES = 3;

// ─── webhook pools ────────────────────────────────────────
// each pool has its own round-robin index and rate limit tracking

const pools = new Map();

function getPool(webhookUrls) {
  // use the joined urls as a cache key
  const key = webhookUrls.join(',');
  if (!pools.has(key)) {
    pools.set(key, {
      urls: webhookUrls,
      status: webhookUrls.map(() => ({ availableAt: 0 })),
      rrIndex: 0,
    });
  }
  return pools.get(key);
}

/**
 * picks the next available webhook from a pool using round-robin.
 */
function pickWebhook(pool) {
  const now = Date.now();
  const total = pool.urls.length;

  // try round-robin first
  for (let i = 0; i < total; i++) {
    const idx = (pool.rrIndex + i) % total;
    if (pool.status[idx].availableAt <= now) {
      pool.rrIndex = (idx + 1) % total;
      return { url: pool.urls[idx], idx };
    }
  }

  // all rate-limited — pick the one that frees up soonest
  let earliest = 0;
  for (let i = 1; i < total; i++) {
    if (pool.status[i].availableAt < pool.status[earliest].availableAt) {
      earliest = i;
    }
  }
  return { url: pool.urls[earliest], idx: earliest, waitMs: pool.status[earliest].availableAt - now };
}

/**
 * resolves which webhook pool to use for a given channel id.
 * returns the channel-specific pool if routed, otherwise the default pool.
 */
function resolvePool(channelId) {
  // check for channel-specific route
  if (config.channelRoutes.has(channelId)) {
    return getPool(config.channelRoutes.get(channelId));
  }
  // fall back to default webhooks
  if (config.defaultWebhookUrls.length > 0) {
    return getPool(config.defaultWebhookUrls);
  }
  return null;
}

/**
 * forwards a message instantly. fire-and-forget, no queue.
 * @param {import('discord.js-selfbot-v13').Message} message
 */
export async function forwardMessage(message) {
  const pool = resolvePool(message.channel.id);

  if (!pool) {
    logger.warn(`no webhook configured for channel #${message.channel.name || message.channel.id}, skipping`);
    return;
  }

  try {
    const payload = buildPayload(message);
    const payloads = splitPayloadIfNeeded(payload);

    for (const p of payloads) {
      if (!p.content && (!p.embeds || p.embeds.length === 0)) continue;
      await sendToPool(pool, p);
    }

    logger.forwarded({
      author: message.author.tag,
      channel: message.channel.name || 'unknown',
      preview: message.content || '[embed/attachment]',
    });
  } catch (err) {
    logger.error(`failed to forward message (${message.id}): ${err.message}`);
  }
}

/**
 * forwards an edited message with an [UPDATED] tag.
 * critical for surebet signals where odds can change.
 * @param {import('discord.js-selfbot-v13').Message} message - the new version of the message
 */
export async function forwardEdit(message) {
  const pool = resolvePool(message.channel.id);
  if (!pool) return;

  try {
    const payload = buildPayload(message, '\u26a0\ufe0f UPDATED');
    const payloads = splitPayloadIfNeeded(payload);

    for (const p of payloads) {
      if (!p.content && (!p.embeds || p.embeds.length === 0)) continue;
      await sendToPool(pool, p);
    }

    logger.info(`forwarded edit from ${message.author?.tag || 'unknown'} in #${message.channel.name || 'unknown'}`);
  } catch (err) {
    logger.error(`failed to forward edit (${message.id}): ${err.message}`);
  }
}

/**
 * forwards a deletion notice.
 * critical for surebet signals: deleted = signal no longer valid.
 * @param {import('discord.js-selfbot-v13').Message} message - the deleted message (may be partial)
 */
export async function forwardDelete(message) {
  const pool = resolvePool(message.channel.id);
  if (!pool) return;

  try {
    const channelName = message.channel.name || 'unknown';
    const content = message.content
      ? `\u274c **SIGNAL DELETED** in **#${channelName}**\n> ${message.content.slice(0, 500)}`
      : `\u274c **SIGNAL DELETED** in **#${channelName}** (content unavailable)`;

    const payload = {
      username: message.author?.displayName || message.author?.username || 'deleted',
      avatar_url: message.author?.displayAvatarURL?.({ size: 256 }) || undefined,
      content,
    };

    if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) {
      return; // prevent 400 Bad Request on empty payloads
    }

    await sendToPool(pool, payload);
    logger.info(`forwarded delete from #${channelName}`);
  } catch (err) {
    logger.error(`failed to forward delete (${message.id}): ${err.message}`);
  }
}

/**
 * sends a payload using a webhook pool with automatic failover
 */
async function sendToPool(pool, payload, attempt = 1) {
  const picked = pickWebhook(pool);

  // if all webhooks are rate-limited, wait for the earliest one
  if (picked.waitMs && picked.waitMs > 0) {
    logger.warn(`all webhooks busy, waiting ${picked.waitMs}ms`);
    await sleep(picked.waitMs);
  }

  try {
    await sendWebhook(pool, picked.url, picked.idx, payload);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      // small delay before retry to avoid hammering
      await sleep(500);
      return sendToPool(pool, payload, attempt + 1);
    }
    throw err;
  }
}

/**
 * sends a payload to a specific webhook
 */
async function sendWebhook(pool, url, idx, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    // network error (dns, timeout, connection refused, etc.)
    logger.error(`network error on webhook ${idx + 1}: ${networkErr.message}`);
    throw networkErr;
  }

  // rate limited — mark this webhook as unavailable and throw to trigger failover
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const retryAfter = (body.retry_after || 2) * 1000;
    pool.status[idx].availableAt = Date.now() + retryAfter;
    logger.warn(`webhook ${idx + 1}/${pool.urls.length} rate limited for ${Math.round(retryAfter)}ms`);
    throw new Error(`rate limited on webhook ${idx + 1}`);
  }

  // webhook was deleted or url is wrong
  if (response.status === 404 || response.status === 401) {
    logger.error(`webhook ${idx + 1} returned ${response.status} — webhook deleted or URL invalid`);
    // mark it as unavailable for a long time so other webhooks are preferred
    pool.status[idx].availableAt = Date.now() + 60000;
    throw new Error(`webhook ${idx + 1} is invalid (${response.status})`);
  }

  // 400 bad request — discord rejected our payload (e.g. content too long, malformed embed)
  if (response.status === 400) {
    const errorBody = await response.text().catch(() => 'no body');
    logger.error(`discord rejected payload on webhook ${idx + 1} (400 Bad Request): ${errorBody}`);
    throw new Error(`payload rejected by discord: ${errorBody.slice(0, 100)}`);
  }

  if (response.status >= 500) {
    throw new Error(`server error ${response.status} on webhook ${idx + 1}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`webhook error ${response.status}: ${body}`);
  }
}

/**
 * builds the webhook payload from a discord message
 */
function buildPayload(message, tag = '') {
  let username = message.author?.displayName || message.author?.username || 'unknown';
  // discord webhooks strictly limit username to 80 chars max
  if (username.length > 80) username = username.slice(0, 77) + '...';

  const payload = {
    username,
    avatar_url: message.author?.displayAvatarURL?.({ size: 256 }) || undefined,
  };

  const channelName = message.channel.name || 'unknown';
  const prefix = tag ? `${tag} ` : '';
  const header = `${prefix}**#${channelName}**\n`;

  if (message.content) {
    payload.content = header + message.content;
  } else {
    // even embed-only messages get the channel header
    payload.content = header.trim();
  }

  if (config.forwardEmbeds && message.embeds.length > 0) {
    // webhooks can only accept up to 10 embeds per message
    payload.embeds = message.embeds
      .filter((e) => e.type === 'rich' || e.type === 'image' || e.type === 'video' || e.type === 'article')
      .slice(0, 10)
      .map((e) => e.toJSON());
  }

  if (config.forwardAttachments && message.attachments.size > 0) {
    const attachmentLines = [];
    message.attachments.forEach((att) => {
      attachmentLines.push(att.url);
    });
    const attachmentText = '\n' + attachmentLines.join('\n');
    payload.content = (payload.content || '') + attachmentText;
  }

  if (message.stickers && message.stickers.size > 0) {
    const stickerNames = [];
    message.stickers.forEach((s) => stickerNames.push(`[sticker: ${s.name}]`));
    const stickerText = '\n' + stickerNames.join(' ');
    payload.content = (payload.content || '') + stickerText;
  }

  if (message.reference && message.reference.messageId) {
    const replyPrefix = `> *reply to a message*\n`;
    payload.content = replyPrefix + (payload.content || '');
  }

  return payload;
}

/**
 * splits the payload into multiple payloads if content exceeds 2000 characters
 */
function splitPayloadIfNeeded(payload) {
  if (!payload.content || payload.content.length <= MAX_CONTENT_LENGTH) {
    return [payload];
  }

  // extract the header since we want to attach it to the FIRST chunk only
  const lines = payload.content.split('\n');
  let header = '';
  let bodyContent = payload.content;

  if (lines.length > 0 && lines[0].startsWith('**#') && lines[0].endsWith('**')) {
    header = lines[0] + '\n';
    bodyContent = payload.content.slice(header.length);
  }

  // same for [UPDATED] tag header
  if (lines.length > 0 && lines[0].startsWith('\u26a0\ufe0f UPDATED **#')) {
    header = lines[0] + '\n';
    bodyContent = payload.content.slice(header.length);
  }

  const chunks = [];
  let remaining = bodyContent;

  while (remaining.length > 0) {
    let chunk;
    if (remaining.length <= MAX_CONTENT_LENGTH) {
      chunk = remaining;
      remaining = '';
    } else {
      let splitIndex = remaining.lastIndexOf('\n', MAX_CONTENT_LENGTH);
      if (splitIndex === -1 || splitIndex < MAX_CONTENT_LENGTH * 0.5) {
        splitIndex = remaining.lastIndexOf(' ', MAX_CONTENT_LENGTH);
      }
      if (splitIndex === -1 || splitIndex < MAX_CONTENT_LENGTH * 0.5) {
        splitIndex = MAX_CONTENT_LENGTH;
      }
      chunk = remaining.slice(0, splitIndex);
      remaining = remaining.slice(splitIndex).trimStart();
    }
    chunks.push(chunk);
  }

  return chunks.map((chunk, index) => {
    const finalContent = index === 0 ? header + chunk : chunk;
    const p = {
      username: payload.username,
      avatar_url: payload.avatar_url,
      content: finalContent,
    };
    if (index === 0 && payload.embeds) {
      p.embeds = payload.embeds;
    }
    return p;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
