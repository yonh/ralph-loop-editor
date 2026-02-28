#!/bin/bash

# Kill Claude processes in infinite loop
# Press Ctrl+C to stop

CHECK_INTERVAL=${CHECK_INTERVAL:-600}  # 检查间隔（秒），默认 10 秒

echo "=== Claude Code Process Killer ==="
echo "Checking every ${CHECK_INTERVAL} seconds..."
echo "Press Ctrl+C to stop"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo "Stopping Claude killer..."
    exit 0
}

trap cleanup SIGINT SIGTERM

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

    # Get all Claude process IDs (exclude grep and this script)
    PIDS=$(ps aux | grep -i claude | grep -v grep | grep -v "$0" | awk '{print $2}')

    if [ -z "$PIDS" ]; then
        echo "[$TIMESTAMP] No Claude processes found."
    else
        echo "[$TIMESTAMP] Found Claude processes: $PIDS"

        # Kill each process
        for PID in $PIDS; do
            # Get process name for logging
            PROC_NAME=$(ps -p $PID -o comm= 2>/dev/null || echo "unknown")

            echo "  -> Killing $PID ($PROC_NAME)..."
            kill -9 $PID 2>/dev/null
            if [ $? -eq 0 ]; then
                echo "     Process $PID terminated successfully."
            else
                echo "     Failed to kill process $PID (may have already exited)."
            fi
        done
    fi

    sleep "$CHECK_INTERVAL"
done
