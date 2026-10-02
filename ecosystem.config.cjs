/**
 * pm2 configuration.
 *
 * Always start through this file rather than `pm2 start index.js`. It pins the
 * working directory, which is what keeps the agent reading the same data/ ledger
 * across restarts — a pm2 process started from the wrong directory silently
 * creates a second, empty one and loses track of open positions.
 *
 *   npm run pm2:start
 *   pm2 save
 */

const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "aeternum",
      script: "index.js",
      cwd: __dirname,
      node_args: "--enable-source-maps",
      instances: 1,
      // Two pollers on one Telegram bot token fight each other (HTTP 409), and
      // two watchers would double-submit closes.
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "60s",
      restart_delay: 5000,
      max_memory_restart: "700M",
      // .env is re-read on every start, so `pm2 restart` picks up edits.
      env: { NODE_ENV: "production" },
      error_file: path.join(__dirname, "logs", "error.log"),
      out_file: path.join(__dirname, "logs", "out.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
