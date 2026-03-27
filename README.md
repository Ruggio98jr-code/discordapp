# Discord Self-Bot
A self-bot that listens to messages in a private Discord server and forwards them to another channel using a webhook.

## Setup

- Node.js v18+
- Access to the source Discord server
- A webhook URL for the destination channel

### 1. Install dependencies

```bash
npm install
```

### 2. Fill in the `.env` file

The `.env` file is already there — just open it and fill in your values:

```env
DISCORD_TOKEN=your_token_here
SOURCE_GUILD_ID=source_server_id
EXCLUDED_CHANNEL_IDS=id1,id2,id3
WEBHOOK_URLS=https://discord.com/api/webhooks/...,https://discord.com/api/webhooks/...
CHANNEL_ROUTES=
```

### 3. Run it

```bash
npm start
```

---

## Getting user token

1. Open Discord in the browser
2. Open DevTools with `F12`, go to the **Network** tab
3. Send any message in a channel
4. Find the `messages` request in the network log
5. Click it, open **Headers**, and look for `Authorization` — that's your token

---

## Creating webhooks

We need multiple webhooks on the same destination channel for real-time throughput. Each webhook handles ~2.5 msg/s, so create 10 for ~25 msg/s.

1. Go to the destination channel on Discord
2. Open **Channel Settings** > **Integrations** > **Webhooks**
3. Hit **New Webhook**, copy the URL
4. Repeat to create more webhooks (up to 15 per channel)
5. Paste all URLs in `.env` as `WEBHOOK_URLS`, comma-separated

---

## Getting server and channel IDs

First, turn on Developer Mode:
- Discord Settings > Advanced > Developer Mode > ON

Then:
- **Server ID**: right-click the server icon > Copy Server ID
- **Channel ID**: right-click the channel name > Copy Channel ID

---

## Configuration reference

| Variable | What it does | Required |
|---|---|---|
| `DISCORD_TOKEN` | Your Discord token | yes |
| `SOURCE_GUILD_ID` | ID of the server to monitor | yes |
| `WEBHOOK_URLS` | Default webhook URLs, comma-separated | yes* |
| `CHANNEL_ROUTES` | Source→destination mapping (see below) | no |
| `EXCLUDED_CHANNEL_IDS` | Channel IDs to skip, comma-separated | no |
| `FORWARD_EMBEDS` | Forward embeds (`true`/`false`) | no, default `true` |
| `FORWARD_ATTACHMENTS` | Forward attachments (`true`/`false`) | no, default `true` |
| `IGNORE_SELF` | Skip your own messages (`true`/`false`) | no, default `true` |

\* required if CHANNEL_ROUTES doesn't cover all channels

---

## Channel routing

By default, all messages go to the `WEBHOOK_URLS` destination. To send specific source channels to specific destination channels, use `CHANNEL_ROUTES`:

```env
CHANNEL_ROUTES=sourceId1=webhookA|webhookB;sourceId2=webhookC
```

- separate channel mappings with `;`
- use `|` to add multiple webhooks per route (for throughput)
- channels not listed fall back to `WEBHOOK_URLS`
- to use only routes with no default, leave `WEBHOOK_URLS` empty

---

## Project structure

```
Bet/
├── .env                  # your config (not committed)
├── .env.example          # config template
├── .gitignore
├── package.json
├── ecosystem.config.cjs  # pm2 config for VPS
├── README.md
└── src/
    ├── index.js          # entry point
    ├── config.js         # loads and validates .env
    ├── forwarder.js      # webhook forwarding logic
    └── logger.js         # colored console logging
```

---

## VPS deployment

Install PM2 globally on the server:

```bash
npm install -g pm2
```

Then start the bot as a background process:

```bash
npm run prod
```

It will auto-restart on crash and survive terminal disconnects.

Useful commands:

```bash
npm run prod:logs   # view live logs
npm run prod:stop   # stop the bot
pm2 status           # check if it's running
```

To make PM2 survive server reboots:

```bash
pm2 startup
pm2 save
```

---

## Stopping

Locally: `Ctrl+C` in the terminal.
On VPS: `npm run prod:stop`.
