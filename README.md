# pi Telegram Connector

A bridge between [pi-coding-agent](https://pi.dev) and **Telegram**.  
Chat with pi through Telegram — send a message and pi responds with AI-powered
coding assistance using your project files, tools, and context.

## How It Works

```
Telegram ──► pi-telegram-connector ──► pi-coding-agent SDK ──► LLM
                 │                                               │
                 ◄────────────────── response ◄──────────────────┘
```

1. You send a Telegram message to your bot
2. The connector forwards it to pi via the SDK
3. pi processes it with its tools (read, write, edit, bash, etc.)
4. The response is sent back to you on Telegram

## Quick Start

### Prerequisites

- **Node.js >= 20** with npm
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- A **pi-coding-agent** installation (`npm install -g @earendil-works/pi-coding-agent`)
- An **API key** for your preferred LLM provider configured in pi

### Installation

```bash
git clone <your-repo-url>
cd pi-telegram-connector
npm install
```

### Configuration

Set your bot token as an environment variable:

```bash
export TELEGRAM_BOT_TOKEN="your:token_here"
```

You can add this to a `.env` file or your shell profile.

### Usage

```bash
# Start the bot (uses current directory as pi's working directory)
node index.mjs

# Or specify a project directory for pi to work in
node index.mjs --cwd=/path/to/your/project
```

Then open Telegram, find your bot, and send `/start`.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with feature overview |
| `/help` | List all available commands |
| `/status` | Check if pi session is active |
| `/new` | Reset pi session (fresh context) |
| `/compact` | Summarize conversation and reset (preserves context) |

Any other message is forwarded to pi for AI-powered processing.

## Features

- **Long message support** — Automatically splits responses >4000 chars
- **Typing indicator** — Shows "typing..." while pi is processing
- **Graceful shutdown** — Ctrl+C disposes the pi session cleanly
- **Automatic reconnection** — Survives transient network errors
- **Markdown formatting** — pi's Markdown responses render in Telegram
- **Session compaction** — `/compact` summarizes and resets to manage context limits

## How It Uses pi

The connector uses pi's [SDK](https://pi.dev) (`createAgentSession` from
`@earendil-works/pi-coding-agent`) to create an agent session in the
given working directory. This gives pi full access to your project files,
tools, extensions, and skills — just like using pi from the terminal.

The session is initialized once at startup and persists across messages.

## Deployment

### Running in the Background (Linux/macOS)

```bash
nohup node index.mjs --cwd=/path/to/project > pi-telegram.log 2>&1 &
```

### Using systemd (Linux)

Create `/etc/systemd/system/pi-telegram.service`:

```ini
[Unit]
Description=pi Telegram Connector
After=network.target

[Service]
Type=simple
Environment=TELEGRAM_BOT_TOKEN=your:token_here
ExecStart=/usr/bin/node /path/to/pi-telegram-connector/index.mjs --cwd=/path/to/project
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pi-telegram
sudo systemctl start pi-telegram
```

### Using Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.mjs"]
```

Build and run:

```bash
docker build -t pi-telegram .
docker run -d --restart always \
  -e TELEGRAM_BOT_TOKEN="your:token_here" \
  -v /path/to/project:/project \
  pi-telegram node index.mjs --cwd=/project
```

## Security Notes

- The connector runs with **your full system permissions** — same as running pi directly
- Anyone who can message your bot can interact with pi
- Consider restricting bot access via Telegram's privacy settings
- Keep your bot token secret — it's the key to your bot

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Your bot token from @BotFather |

## Project Structure

```
pi-telegram-connector/
├── index.mjs            # Main connector logic
├── package.json         # Dependencies and scripts
├── README.md            # This file
└── .gitignore
```

## References

- [pi-coding-agent SDK documentation](https://pi.dev)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [@BotFather](https://t.me/BotFather) — Create and manage Telegram bots

## License

Apache 2.0
