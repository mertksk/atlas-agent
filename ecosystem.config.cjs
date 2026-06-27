// pm2 process supervision for the full Atlas stack (services + agent + web).
//   npm run stack         # start all three under pm2 (auto-restart, durable)
//   npm run stack:status  # see status
//   npm run stack:logs    # tail logs
//   npm run stack:stop    # stop + remove
//
// Loads .env so every process gets DRY_RUN, contract addresses, the agent/owner
// key paths, AGENT_API_TOKEN, OPENROUTER_API_KEY, STRATEGY_ADDR_*, etc.
const fs = require("fs");
const path = require("path");

function loadEnv(file) {
  const env = {};
  try {
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1"); // strip surrounding quotes
    }
  } catch {
    /* no .env -> rely on the process environment */
  }
  return env;
}

const root = __dirname;
const env = { ...process.env, ...loadEnv(path.join(root, ".env")) };

const common = {
  cwd: root,
  script: "npm",
  interpreter: "none",
  env,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 2000,
  time: true,
};

const apps = [
  { ...common, name: "atlas-services", args: ["run", "start", "-w", "services"] },
  { ...common, name: "atlas-agent", args: ["run", "serve", "-w", "agent"] },
  { ...common, name: "atlas-web", args: ["run", "web"] },
  // Health monitor: polls every service + testnet RPC, logs ALERT on outage,
  // optionally POSTs to MONITOR_WEBHOOK_URL.
  { ...common, name: "atlas-monitor", args: ["run", "monitor"] },
];

// Real on-chain x402 facilitator (vendored via scripts/setup-facilitator.sh).
// Supervised here so it survives restarts instead of running as a bare process.
// It reads its own vendor/casper-x402/js/.env (node, rpc, fee-payer key) at runtime.
const facilitatorDir = path.join(root, "vendor/casper-x402/js");
if (fs.existsSync(facilitatorDir)) {
  apps.push({
    ...common,
    name: "atlas-facilitator",
    cwd: facilitatorDir,
    args: ["exec", "tsx", "examples/facilitator/index.ts"],
  });
}

module.exports = { apps };
