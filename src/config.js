import 'dotenv/config';

/**
 * loads and validates configuration from the .env file
 */

const required = ['DISCORD_TOKEN', 'SOURCE_GUILD_ID'];

for (const key of required) {
  if (!process.env[key] || process.env[key].startsWith('your_')) {
    console.error(`\n❌ missing or unconfigured variable: ${key}`);
    console.error(`   edit the .env file and set the correct value.\n`);
    process.exit(1);
  }
}

// parse default webhook urls (comma-separated)
const defaultWebhookUrls = (process.env.WEBHOOK_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0 && !url.startsWith('your_'));

// parse channel routes (format: sourceChannelId=webhookUrl1|webhookUrl2, one per line or semicolon-separated)
// example: CHANNEL_ROUTES=123=https://hook1|https://hook2;456=https://hook3
const channelRoutes = new Map();
const routesRaw = process.env.CHANNEL_ROUTES || '';
if (routesRaw.length > 0) {
  const entries = routesRaw.split(';').map((e) => e.trim()).filter((e) => e.length > 0);
  for (const entry of entries) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex === -1) continue;
    const channelId = entry.slice(0, eqIndex).trim();
    const urls = entry.slice(eqIndex + 1)
      .split('|')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (channelId && urls.length > 0) {
      channelRoutes.set(channelId, urls);
    }
  }
}

// must have at least default webhooks or channel routes
if (defaultWebhookUrls.length === 0 && channelRoutes.size === 0) {
  console.error('\n❌ no webhooks configured. set WEBHOOK_URLS and/or CHANNEL_ROUTES in .env\n');
  process.exit(1);
}

// parse excluded channel ids into a set for O(1) lookup
const excludedRaw = process.env.EXCLUDED_CHANNEL_IDS || '';
const excludedChannels = new Set(
  excludedRaw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
);

// extract webhook IDs from all urls to prevent infinite loops
const allUrls = [...defaultWebhookUrls];
for (const urls of channelRoutes.values()) {
  allUrls.push(...urls);
}

const webhookIds = new Set();
for (const url of allUrls) {
  // discord webhook urls are formatted as: https://discord.com/api/webhooks/ID/TOKEN
  const match = url.match(/\/webhooks\/(\d+)\//);
  if (match && match[1]) {
    webhookIds.add(match[1]);
  }
}

const config = Object.freeze({
  // discord user token
  token: process.env.DISCORD_TOKEN,

  // source server (guild) id to monitor
  sourceGuildId: process.env.SOURCE_GUILD_ID,

  // set of channel ids to exclude
  excludedChannelIds: excludedChannels,

  // default webhook urls (used when no specific route matches)
  defaultWebhookUrls,

  // channel-specific routing: Map<channelId, webhookUrl[]>
  channelRoutes,

  // set of our own webhook ids (to prevent infinite loops)
  webhookIds,

  // forwarding options
  forwardEmbeds: process.env.FORWARD_EMBEDS !== 'false',
  forwardAttachments: process.env.FORWARD_ATTACHMENTS !== 'false',
  ignoreSelf: process.env.IGNORE_SELF !== 'false',
});

export default config;
