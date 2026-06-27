/**
 * End-to-end smoke test (offline): spawns the data services (mock x402) + the
 * agent (DRY_RUN) on isolated ports and exercises the full path —
 * auth gate -> pipeline run -> decisions -> x402 mock settlements -> treasury
 * debit -> state persistence. No chain, no keys, deterministic scorer.
 *
 *   npm run test:e2e
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SERVICES_PORT = 41910;
const AGENT_PORT = 41900;
const TOKEN = "e2e-secret-token";
const STATE_PATH = join(tmpdir(), `atlas-e2e-${process.pid}.json`);
const A = `http://localhost:${AGENT_PORT}`;

const procs: ChildProcess[] = [];
function start(name: string, args: string[], env: Record<string, string>) {
  const p = spawn("npm", args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr?.on("data", (d) => { if (/Error|throw|EADDRINUSE/.test(String(d))) process.stderr.write(`[${name}] ${d}`); });
  procs.push(p);
  return p;
}
function stopAll() {
  for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url: string, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}`);
}
let failed = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "ok  " : "FAIL"} - ${msg}`);
  if (!cond) failed++;
}

try {
  rmSync(STATE_PATH, { force: true });
  start("services", ["run", "start", "-w", "services"], { SERVICES_PORT: String(SERVICES_PORT), CORS_ORIGIN: "*", FACILITATOR_URL: "" });
  start("agent", ["run", "serve", "-w", "agent"], {
    AGENT_PORT: String(AGENT_PORT), SERVICES_URL: `http://localhost:${SERVICES_PORT}`,
    DRY_RUN: "true", AGENT_API_TOKEN: TOKEN, STATE_PATH, TREASURY_BALANCE_CSPR: "100",
    CORS_ORIGIN: "*", FACILITATOR_URL: "", OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "",
  });

  await waitFor(`http://localhost:${SERVICES_PORT}/opportunities`);
  await waitFor(`${A}/api/health`);

  const state0 = await (await fetch(`${A}/api/state`)).json();
  check(state0.mode === "dry-run", "agent boots in dry-run");

  const noTok = await fetch(`${A}/api/run`, { method: "POST" });
  check(noTok.status === 401, "POST /api/run without token -> 401 (auth gate)");

  const withTok = await fetch(`${A}/api/run`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  check(withTok.status === 202, "POST /api/run with token -> 202");

  // wait for the run to finish
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(`${A}/api/state`)).json();
    if (s.running === false && s.runs >= 1) break;
    await sleep(500);
  }

  const decisions = await (await fetch(`${A}/api/decisions`)).json();
  check(Array.isArray(decisions) && decisions.length === 5, `5 decisions recorded (got ${decisions.length})`);
  const tbill = decisions.find((d: any) => d.opportunityId === "rwa-tbill-001");
  const sus = decisions.find((d: any) => d.opportunityId === "defi-sus-005");
  check(tbill?.action === "ALLOCATE", "conservative T-bill -> ALLOCATE");
  check(sus?.action === "REJECT", "94% APY honeypot -> REJECT");

  const payments = await (await fetch(`${A}/api/payments`)).json();
  check(Array.isArray(payments) && payments.length > 0, `x402 settlements recorded (${payments.length})`);
  check(payments.every((p: any) => p.settlement?.mode === "mock"), "settlements are mock-mode (offline)");

  const state1 = await (await fetch(`${A}/api/state`)).json();
  check(state1.treasuryBalanceCspr < 100, `treasury debited by allocation (${state1.treasuryBalanceCspr} < 100)`);

  check(existsSync(STATE_PATH), "state persisted to disk");
  if (existsSync(STATE_PATH)) {
    const persisted = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    check(persisted.runs?.length >= 1, "persisted state has the run");
  }
} catch (err) {
  console.log("FAIL - exception:", String(err));
  failed++;
} finally {
  stopAll();
  rmSync(STATE_PATH, { force: true });
  await sleep(300);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — e2e (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
