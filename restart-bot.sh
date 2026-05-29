#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

BOT_DIR="./"
LOG_DIR="$BOT_DIR/logs"
PID_FILE="$BOT_DIR/bot.pid"

mkdir -p "$LOG_DIR"

# Stop existing instance if running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "🛑 Stopping bot (PID $OLD_PID)..."
        kill "$OLD_PID"
        sleep 2
        # Force kill if still alive
        if kill -0 "$OLD_PID" 2>/dev/null; then
            kill -9 "$OLD_PID" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
fi

# Ensure dependencies are installed
if [ ! -d "$BOT_DIR/node_modules" ]; then
    echo "📦 Installing dependencies..."
    cd "$BOT_DIR"
    npm install --omit=dev
    cd "$OLDPWD"
fi

# Determine working directory for pi (default: herve project root)
CWD="${1:-$(pwd)}"

# Start the bot
echo "🚀 Starting pi-telegram-bot (CWD: $CWD)..."
nohup node "$BOT_DIR/index.mjs" --cwd="$CWD" > "$LOG_DIR/bot.log" 2>&1 &
BOT_PID=$!
echo "$BOT_PID" > "$PID_FILE"

echo "✅ Bot started (PID $BOT_PID)"
echo "📝 Logs: $LOG_DIR/bot.log"
echo "📋 Tail: tail -f $LOG_DIR/bot.log"
