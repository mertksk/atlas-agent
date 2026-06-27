/**
 * Resilience: the agent must DEGRADE GRACEFULLY when a dependency is down.
 * Spawns only the agent (dry-run) pointed at an unreachable data-services URL,
 * triggers a run, and asserts the process stays healthy and logs the failure
 * instead of crashing.
 *
 *   npm run test:resilience
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const AGENT_PORT = 41950;
const TOKEN = "resilience-token";
const STATE_PATH = join(tmpdir(), `atlas-resil-${process.pid}.json`);
const A = `http://localhost:${AGENT_PORT}`;

let proc: ChildProcess | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c: boolean, m: string) => { console.log(`${c ? "ok  " : "FAIL"} - ${m}`); if (!c) failed++; };

try {
  rmSync(STATE_PATH, { force: true });
  proc = spawn("npm", ["run", "serve", "-w", "agent"], {
    cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_PORT: String(AGENT_PORT),
      SERVICES_URL: "http://127.0.0.1:1", // unreachable on purpose
      DRY_RUN: "true", AGENT_API_TOKEN: TOKEN, STATE_PATH,
      FACILITATOR_URL: "", OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "",
    },
  });

  // wait for health
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${A}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  check(up, "agent boots even though data-services is unreachable");

  // trigger a run that WILL fail (scout can't reach services)
  const r = await fetch(`${A}/api/run`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  check(r.status === 202, "run accepted (202)");

  // wait for it to settle
  for (let i = 0; i < 30; i++) {
    const s = await (await fetch(`${A}/api/state`)).json();
    if (s.running === false) break;
    await sleep(500);
  }

  // the agent must still be alive and have logged the failure (not crashed)
  const health = await fetch(`${A}/api/health`);
  check(health.ok, "agent still healthy after the failed run (no crash)");
  const ev = await (await fetch(`${A}/api/events?since=0`)).json();
  const failedRun = (ev.events ?? []).some((e: any) => /run failed/i.test(e.message ?? ""));
  check(failedRun, "the failed run was logged gracefully (system: run failed)");
  const st = await (await fetch(`${A}/api/state`)).json();
  check(st.running === false, "agent is idle and ready for the next run");
} catch (err) {
  console.log("FAIL - exception:", String(err));
  failed++;
} finally {
  try { if (proc?.pid) process.kill(-proc.pid, "SIGKILL"); } catch {}
  rmSync(STATE_PATH, { force: true });
  await sleep(300);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — resilience (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
