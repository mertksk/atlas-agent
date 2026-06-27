#!/usr/bin/env node
/**
 * Atlas health monitor — polls every service + the testnet RPC on an interval
 * and logs OK / ALERT / RECOVERED transitions (captured by pm2 logs). Optionally
 * POSTs alerts to MONITOR_WEBHOOK_URL (Slack-style {text}). Dependency-free.
 *
 *   npm run monitor          # standalone
 *   (also runs as the `atlas-monitor` pm2 app in the stack)
 *
 * Env: AGENT_URL, SERVICES_URL, WEB_URL, FACILITATOR_URL, RPC_URL,
 *      MONITOR_INTERVAL_SEC (30), MONITOR_WEBHOOK_URL
 */
const E = process.env;
const INTERVAL = Number(E.MONITOR_INTERVAL_SEC || 30) * 1000;
const WEBHOOK = E.MONITOR_WEBHOOK_URL || "";

const AGENT = (E.AGENT_URL || `http://localhost:${E.AGENT_PORT || 4030}`).replace(/\/$/, "");
const SERVICES = (E.SERVICES_URL || `http://localhost:${E.SERVICES_PORT || 4021}`).replace(/\/$/, "");
const WEB = (E.WEB_URL || "http://localhost:3000").replace(/\/$/, "");
const FAC = (E.FACILITATOR_URL || "http://localhost:4022").replace(/\/$/, "");
const RPC = E.RPC_URL || E.ODRA_CASPER_LIVENET_NODE_ADDRESS || "https://node.testnet.casper.network/rpc";

const targets = [
  { name: "agent", probe: () => okJson(`${AGENT}/api/health`, (j) => j.ok === true) },
  { name: "services", probe: () => ok(`${SERVICES}/payments`) },
  { name: "web", probe: () => ok(WEB) },
  { name: "facilitator", probe: () => ok(`${FAC}/health`) },
  { name: "testnet-rpc", probe: () => ok(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"chain_get_state_root_hash"}' }) },
];

const ts = () => new Date().toISOString();
async function ok(url, init) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(5000), ...init })).ok; } catch { return false; }
}
async function okJson(url, pred) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    return pred(await r.json());
  } catch { return false; }
}
async function notify(text) {
  console.log(text);
  if (!WEBHOOK) return;
  try { await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ }
}

const up = {};
let firstPass = true;
async function tick() {
  const results = await Promise.all(targets.map(async (t) => [t.name, await t.probe()]));
  for (const [name, isUp] of results) {
    // First pass only establishes the baseline — never alert (avoids false
    // alarms during a stack reload when processes are still coming up).
    if (!firstPass && isUp !== up[name]) {
      await notify(`${ts()} ${isUp ? "✅ RECOVERED" : "🚨 ALERT — DOWN"}: ${name}`);
    }
    up[name] = isUp;
  }
  const down = results.filter(([, u]) => !u).map(([n]) => n);
  console.log(`${ts()} health: ${down.length ? "DOWN=" + down.join(",") : "all OK"} (${results.map(([n, u]) => `${n}:${u ? "up" : "down"}`).join(" ")})`);
  firstPass = false;
}

console.log(`${ts()} atlas-monitor started — interval ${INTERVAL / 1000}s, webhook=${WEBHOOK ? "on" : "off"}`);
await tick();
setInterval(tick, INTERVAL);
