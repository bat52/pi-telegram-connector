#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

PID_FILE="./bot.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "ℹ️  No PID file found — bot may not be running."
    echo "   Try: pkill -f 'pi-telegram-connector'"
    exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
    echo "🛑 Stopping bot (PID $PID)..."
    kill "$PID"
    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
        kill -9 "$PID" 2>/dev/null || true
    fi
    echo "✅ Bot stopped"
else
    echo "ℹ️  Bot not running (PID $PID not found)"
fi

rm -f "$PID_FILE"
