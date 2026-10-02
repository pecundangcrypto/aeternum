#!/usr/bin/env bash
#
# Start a detached paper evaluation run: local hivemind + the agent, both
# surviving logout so a multi-day run can be left alone.
#
# Paper mode requires no wallet key. If WALLET_PRIVATE_KEY is absent and
# DRY_RUN is true, the agent runs on a synthetic SOL account and is structurally
# unable to sign anything — it cannot interact with any other bot on the machine.
#
#   scripts/paper-run.sh start | stop | status | logs
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PID_DIR="$ROOT/data/run"
LOG_DIR="$ROOT/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

AGENT_PID="$PID_DIR/agent.pid"
HIVE_PID="$PID_DIR/hivemind.pid"
HIVE_PORT="${HIVEMIND_PORT:-8787}"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_one() {
  local name="$1" pidfile="$2" log="$3"; shift 3
  if alive "$pidfile"; then
    echo "  $name already running (pid $(cat "$pidfile"))"
    return 0
  fi
  setsid nohup "$@" >>"$log" 2>&1 &
  echo $! >"$pidfile"
  sleep 1
  if alive "$pidfile"; then
    echo "  $name started (pid $(cat "$pidfile")) → $log"
  else
    echo "  $name failed to start — see $log" >&2
    tail -20 "$log" >&2 || true
    return 1
  fi
}

stop_one() {
  local name="$1" pidfile="$2"
  if ! alive "$pidfile"; then
    echo "  $name not running"
    rm -f "$pidfile"
    return 0
  fi
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  echo "  $name stopped"
}

case "${1:-start}" in
  start)
    if [ -n "${WALLET_PRIVATE_KEY:-}" ] || grep -qE '^WALLET_PRIVATE_KEY=.+' .env 2>/dev/null; then
      echo "A wallet key is configured — this script is for keyless paper runs only." >&2
      echo "Use 'npm start' (or pm2) for a run that signs transactions." >&2
      exit 1
    fi
    echo "Starting paper run:"
    start_one "hivemind" "$HIVE_PID" "$LOG_DIR/hivemind.log" \
      env HOST=127.0.0.1 PORT="$HIVE_PORT" node hivemind-server/server.js
    start_one "agent" "$AGENT_PID" "$LOG_DIR/agent.log" \
      env DRY_RUN=true node index.js
    echo
    echo "  scripts/paper-run.sh logs      follow the agent log"
    echo "  node bin/aeternum.js status    wallet, positions, watcher"
    ;;
  stop)
    echo "Stopping paper run:"
    stop_one "agent" "$AGENT_PID"
    stop_one "hivemind" "$HIVE_PID"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    alive "$AGENT_PID"    && echo "  agent    running (pid $(cat "$AGENT_PID"))"    || echo "  agent    stopped"
    alive "$HIVE_PID"     && echo "  hivemind running (pid $(cat "$HIVE_PID"))"     || echo "  hivemind stopped"
    ;;
  logs)
    tail -f "$LOG_DIR/agent.log"
    ;;
  install)
    # nohup does not survive a reboot. A multi-day evaluation that quietly stops
    # when the box restarts produces a gap you only notice days later, so the
    # persistent form is an explicit, reversible install rather than the default.
    command -v systemctl >/dev/null || { echo "systemd not available on this host" >&2; exit 1; }
    NODE_BIN="$(command -v node)"
    UNIT=/etc/systemd/system/aeternum-paper.service
    cat >"$UNIT" <<UNITEOF
[Unit]
Description=Aeternum paper evaluation run
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=DRY_RUN=true
ExecStartPre=$NODE_BIN $ROOT/hivemind-server/server.js --check
ExecStart=$NODE_BIN $ROOT/index.js
Restart=always
RestartSec=15
StandardOutput=append:$LOG_DIR/agent.log
StandardError=append:$LOG_DIR/agent.log

[Install]
WantedBy=multi-user.target
UNITEOF
    # The hivemind server is a separate, equally restartable unit.
    cat >/etc/systemd/system/aeternum-hivemind.service <<UNITEOF
[Unit]
Description=Aeternum hivemind server (loopback)
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOST=127.0.0.1
Environment=PORT=$HIVE_PORT
ExecStart=$NODE_BIN $ROOT/hivemind-server/server.js
Restart=always
RestartSec=15
StandardOutput=append:$LOG_DIR/hivemind.log
StandardError=append:$LOG_DIR/hivemind.log

[Install]
WantedBy=multi-user.target
UNITEOF
    sed -i '/ExecStartPre/d' "$UNIT"
    systemctl daemon-reload
    systemctl enable --now aeternum-hivemind.service aeternum-paper.service
    echo "Installed. Both services now start on boot and restart on crash."
    echo "  systemctl status aeternum-paper"
    echo "  journalctl -u aeternum-paper -f"
    echo "  scripts/paper-run.sh uninstall   to remove"
    ;;
  uninstall)
    systemctl disable --now aeternum-paper.service aeternum-hivemind.service 2>/dev/null || true
    rm -f /etc/systemd/system/aeternum-paper.service /etc/systemd/system/aeternum-hivemind.service
    systemctl daemon-reload
    echo "Removed."
    ;;
  *)
    echo "Usage: scripts/paper-run.sh start|stop|restart|status|logs|install|uninstall" >&2
    exit 1
    ;;
esac
