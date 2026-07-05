/**
 * Atlas agent entrypoint.
 *
 *   npm run agent:run     one-shot pipeline run, ledger printed to console
 *   npm run agent         HTTP API on :4030 for the dashboard
 *
 * API (all JSON):
 *   GET  /api/state            policy, treasury, run status, pending approvals
 *   POST /api/run              start a pipeline run (409 if one is in flight)
 *   GET  /api/events?since=N   ledger entries after cursor N (dashboard polls)
 *   GET  /api/runs/latest      last full RunResult
 *   GET  /api/decisions        flattened decisions across all runs
 *   POST /api/approve/:runId/:oppId   execute a queued allocation
 *   GET  /api/opportunities    proxied from the data services (free endpoint)
 *   GET  /api/payments         proxied x402 settlement ledger
 *   GET  /api/health           liveness/readiness probe
 *
 * State (ledger, runs, approvals, treasury balance, daily spend) is persisted to
 * config.statePath so a restart resumes where it left off.
 */
import express from "express";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { config, defaultPolicy, validateConfig, ConfigError } from "./config.js";
import { runPipeline } from "./orchestrator.js";
import { reasonerLabel } from "./reasoning.js";
import { executeAllocationOnChain, recordDecisionOnChain, swapCsprForWusdc, vaultStatus, type OnChainOutcome } from "./chain.js";
import { feeInfo, buildFeeDeploy, submitSignedDeploy } from "./wallet.js";
import { motesToCspr, type LedgerEntry, type RunResult } from "./types.js";

/** A usage-fee receipt: the connected wallet's signed CSPR transfer to the fee wallet. */
interface FeeReceipt {
  resource?: string;
  amount?: string;
  at?: string;
  from?: string;
  settlement?: { transaction?: string; mode?: string };
}

interface PendingApproval {
  runId: string;
  opportunityId: string;
  opportunityName: string;
  amountCspr: number;
  recipient: string;
  riskScore: number;
  confidence: number;
  reason: string;
  queuedAt: string;
}

const store = {
  ledger: [] as LedgerEntry[],
  runs: [] as RunResult[],
  running: false,
  pendingApprovals: [] as PendingApproval[],
  feeReceipts: [] as FeeReceipt[],
  // One-time run credits minted by a paid usage fee (criterion 3). A wallet user
  // has no bearer token, so a successful fee authorizes exactly one run.
  runCredits: [] as string[],
  spentTodayCspr: 0,
  treasuryBalanceCspr: config.treasuryBalanceCspr,
  dayStamp: utcDay(),
  // observability (per-process, not persisted)
  startedAt: Date.now(),
  lastError: null as { message: string; at: string } | null,
};

/** Record an operational error for the health/metrics endpoints. */
function recordError(message: string): void {
  store.lastError = { message: message.slice(0, 300), at: new Date().toISOString() };
  console.error(`[atlas-agent] error: ${message}`);
}

/** Quick reachability probe (2s timeout) for dependency health. */
async function ping(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok || r.status === 402; // 402 = a paid endpoint is reachable
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- persistence
function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

interface PersistShape {
  ledger: LedgerEntry[];
  runs: RunResult[];
  pendingApprovals: PendingApproval[];
  feeReceipts: FeeReceipt[];
  runCredits: string[];
  spentTodayCspr: number;
  treasuryBalanceCspr: number;
  dayStamp: string;
}

function loadState(): void {
  try {
    if (!existsSync(config.statePath)) return;
    const s = JSON.parse(readFileSync(config.statePath, "utf8")) as Partial<PersistShape>;
    store.ledger = s.ledger ?? [];
    store.runs = s.runs ?? [];
    store.pendingApprovals = s.pendingApprovals ?? [];
    store.feeReceipts = s.feeReceipts ?? [];
    store.runCredits = s.runCredits ?? [];
    store.spentTodayCspr = s.spentTodayCspr ?? 0;
    store.treasuryBalanceCspr = s.treasuryBalanceCspr ?? config.treasuryBalanceCspr;
    store.dayStamp = s.dayStamp ?? utcDay();
    if (rolloverDay()) writeStateNow(); // persist the day reset durably
    console.log(
      `[atlas-agent] restored state from ${config.statePath}: ${store.runs.length} run(s), ${store.ledger.length} ledger entries.`,
    );
  } catch (err) {
    console.warn(`[atlas-agent] could not load state from ${config.statePath}: ${String(err)}`);
  }
}

/** Atomic write: serialize to a temp file then rename, so a crash mid-write
 *  can never corrupt the state file (rename is atomic on the same filesystem). */
function writeStateNow(): void {
  try {
    mkdirSync(dirname(config.statePath), { recursive: true });
    const data: PersistShape = {
      ledger: store.ledger,
      runs: store.runs,
      pendingApprovals: store.pendingApprovals,
      feeReceipts: store.feeReceipts,
      runCredits: store.runCredits,
      spentTodayCspr: store.spentTodayCspr,
      treasuryBalanceCspr: store.treasuryBalanceCspr,
      dayStamp: store.dayStamp,
    };
    const tmp = `${config.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, config.statePath);
  } catch (err) {
    console.warn(`[atlas-agent] could not persist state to ${config.statePath}: ${String(err)}`);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveState(): void {
  // Debounce: a run pushes many ledger lines; coalesce them into one write.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStateNow();
  }, 250);
}

/** Flush pending state synchronously (used on graceful shutdown). */
function flushState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeStateNow();
}

/** Reset the daily-spend counter when the UTC day rolls over (mirrors the vault).
 *  Returns true if it changed state (so callers can persist). */
function rolloverDay(): boolean {
  const today = utcDay();
  if (store.dayStamp !== today) {
    store.spentTodayCspr = 0;
    store.dayStamp = today;
    return true;
  }
  return false;
}

/** In live mode, reconcile the local treasury mirror with the on-chain vault. */
async function refreshTreasuryFromChain(): Promise<void> {
  if (config.dryRun) return;
  const vs = (await vaultStatus()) as { balance?: string } | null;
  if (vs?.balance) {
    store.treasuryBalanceCspr = motesToCspr(vs.balance);
    console.log(`[atlas-agent] vault balance synced from chain: ${store.treasuryBalanceCspr} CSPR`);
  } else {
    console.warn(`[atlas-agent] vault refresh returned no balance: ${JSON.stringify(vs)}`);
  }
}

// ------------------------------------------------------------------ run
async function executeRun(): Promise<RunResult> {
  store.running = true;
  rolloverDay();
  try {
    const result = await runPipeline({
      policy: defaultPolicy,
      treasuryBalanceCspr: store.treasuryBalanceCspr,
      spentTodayCspr: store.spentTodayCspr,
      onLedger: (e) => store.ledger.push(e),
    });
    store.runs.push(result);

    // Book allocations and collect approval requests. In live mode only count an
    // allocation that actually executed on-chain — a failed deploy must not debit
    // the local mirror.
    const opps = await fetchOpportunities();
    for (const d of result.decisions) {
      if (d.verdict.finalAction === "ALLOCATE") {
        const moved = config.dryRun || d.onChain?.executed === true;
        if (moved) {
          store.spentTodayCspr += d.decision.recommendedAmountCspr;
          store.treasuryBalanceCspr -= d.decision.recommendedAmountCspr;
        }
      }
      if (d.verdict.finalAction === "QUEUE_FOR_APPROVAL") {
        const opp = opps.find((o) => o.id === d.decision.opportunityId);
        // Keep only the latest pending approval per opportunity — re-running
        // shouldn't pile up duplicates for the same opportunity.
        store.pendingApprovals = store.pendingApprovals.filter((a) => a.opportunityId !== d.decision.opportunityId);
        store.pendingApprovals.push({
          runId: result.runId,
          opportunityId: d.decision.opportunityId,
          opportunityName: opp?.name ?? d.decision.opportunityId,
          amountCspr: d.decision.recommendedAmountCspr,
          recipient: opp?.strategyAddress ?? "",
          riskScore: d.decision.riskScore,
          confidence: d.decision.confidence,
          reason: d.decision.reason,
          queuedAt: new Date().toISOString(),
        });
      }
    }
    await refreshTreasuryFromChain();
    return result;
  } finally {
    store.running = false;
    flushState(); // money-moving mutations: persist synchronously, not debounced
  }
}

async function fetchOpportunities(): Promise<Array<{ id: string; name: string; strategyAddress: string }>> {
  try {
    const res = await fetch(`${config.servicesUrl}/opportunities`);
    return res.ok ? ((await res.json()) as Array<{ id: string; name: string; strategyAddress: string }>) : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------- config validation
function assertConfigOrExit(): void {
  try {
    for (const w of validateConfig()) console.warn(`[atlas-agent] config warning: ${w}`);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[atlas-agent] fatal config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

// ----------------------------------------------------------------- CLI mode
const mode = process.argv[2] ?? "serve";

if (mode === "run") {
  assertConfigOrExit();
  const result = await runPipeline({
    onLedger: (e) => console.log(`[${e.ts.slice(11, 19)}] ${e.agent.padEnd(12)} ${e.message}`),
  });
  console.log("\n=== decisions ===");
  for (const d of result.decisions) {
    console.log(
      `${d.decision.opportunityId.padEnd(16)} ${d.verdict.finalAction.padEnd(20)} ${d.decision.recommendedAmountCspr} CSPR  (risk ${d.decision.riskScore}, conf ${(d.decision.confidence * 100).toFixed(0)}%, data ${motesToCspr(d.report.dataCostMotes)} CSPR)`,
    );
  }
  console.log(`\ntotal data spend: ${motesToCspr(result.totalDataCostMotes)} CSPR`);
  process.exit(0);
}

// ----------------------------------------------------------------- API mode
assertConfigOrExit();
loadState();
// In live mode, reconcile the displayed treasury balance with the on-chain vault
// BEFORE accepting traffic, so a run never races a late balance overwrite.
if (!config.dryRun) {
  try {
    await refreshTreasuryFromChain();
    flushState();
  } catch (err) {
    recordError(`startup vault refresh failed: ${String(err)}`);
  }
}

const app = express();
app.use(express.json());

// Lightweight access log: method, path, status, latency.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () =>
    console.log(`[atlas-agent] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - t0}ms`),
  );
  next();
});

// CORS: reflect only allow-listed origins (config.corsOrigins). "*" is honored
// if explicitly configured, but defaults to the local dashboard only.
const allowAny = config.corsOrigins.includes("*");
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Fee-Credit");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

// Bearer-token guard for state-changing endpoints. If no token is configured,
// requests pass (dev/localhost); a startup warning is emitted in that case.
const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!config.apiToken) return next();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(config.apiToken);
  // Constant-time comparison (length-guarded) — this guards funds-moving routes.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "unauthorized: missing or invalid bearer token" });
    return;
  }
  next();
};

// Liveness probe: always 200 if the process answers. Dependency state is
// reported in the body (readiness), so monitors can distinguish "agent down"
// from "a dependency is down" without the agent flapping.
app.get("/api/health", async (_req, res) => {
  const services = await ping(`${config.servicesUrl}/opportunities`);
  res.json({
    ok: true,
    mode: config.dryRun ? "dry-run" : "live",
    running: store.running,
    runs: store.runs.length,
    uptimeSec: Math.floor((Date.now() - store.startedAt) / 1000),
    lastError: store.lastError,
    deps: { services },
  });
});

// Aggregate operational metrics for dashboards / scrapers.
app.get("/api/metrics", (_req, res) => {
  rolloverDay();
  res.json({
    uptimeSec: Math.floor((Date.now() - store.startedAt) / 1000),
    mode: config.dryRun ? "dry-run" : "live",
    reasoner: reasonerLabel(),
    runs: store.runs.length,
    decisions: store.runs.reduce((n, r) => n + r.decisions.length, 0),
    pendingApprovals: store.pendingApprovals.length,
    treasuryBalanceCspr: store.treasuryBalanceCspr,
    spentTodayCspr: store.spentTodayCspr,
    running: store.running,
    lastError: store.lastError,
  });
});

app.get("/api/state", (_req, res) => {
  rolloverDay();
  const last = store.runs.at(-1);
  res.json({
    mode: config.dryRun ? "dry-run" : "live",
    network: "casper-test",
    policy: defaultPolicy,
    treasuryBalanceCspr: store.treasuryBalanceCspr,
    spentTodayCspr: store.spentTodayCspr,
    running: store.running,
    runs: store.runs.length,
    lastRunId: last?.runId ?? null,
    lastRunDataCostCspr: last ? motesToCspr(last.totalDataCostMotes) : 0,
    pendingApprovals: store.pendingApprovals,
    llm: Boolean(config.openrouterApiKey || config.anthropicApiKey),
    reasoner: reasonerLabel(),
    contracts: { vault: config.vaultAddress ?? null, registry: config.registryAddress ?? null },
  });
});

/** Consume a one-time run credit minted by a paid usage fee. */
function consumeRunCredit(credit: string): boolean {
  const i = store.runCredits.indexOf(credit);
  if (i === -1) return false;
  store.runCredits.splice(i, 1);
  saveState();
  return true;
}

/** Authorize a run via the bearer token OR a paid-fee run credit (X-Fee-Credit). */
function runAuthorized(req: express.Request): boolean {
  if (config.apiToken) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(token);
    const b = Buffer.from(config.apiToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  } else {
    return true; // no token configured (dev/localhost)
  }
  // Wallet users have no token: a valid, unconsumed fee credit authorizes one run.
  const credit = req.headers["x-fee-credit"];
  if (config.feeRecipientHex && typeof credit === "string" && consumeRunCredit(credit)) return true;
  return false;
}

app.post("/api/run", (req, res) => {
  if (!runAuthorized(req)) {
    return res.status(401).json({ error: "unauthorized: provide a bearer token or pay the usage fee" });
  }
  if (store.running) return res.status(409).json({ error: "a run is already in progress" });
  executeRun().catch((err) => {
    recordError(`run failed: ${String(err)}`);
    store.ledger.push({ ts: new Date().toISOString(), agent: "system", message: `run failed: ${String(err)}` });
    saveState();
  });
  res.status(202).json({ accepted: true });
});

app.get("/api/events", (req, res) => {
  const since = Math.max(0, Number(req.query.since ?? 0) || 0);
  res.json({ cursor: store.ledger.length, events: store.ledger.slice(since) });
});

app.get("/api/runs/latest", (_req, res) => {
  const last = store.runs.at(-1);
  if (!last) return res.status(404).json({ error: "no runs yet" });
  res.json(last);
});

app.get("/api/decisions", (_req, res) => {
  res.json(
    store.runs.flatMap((r) =>
      r.decisions.map((d) => ({
        runId: r.runId,
        at: r.finishedAt ?? r.startedAt,
        opportunityId: d.decision.opportunityId,
        action: d.verdict.finalAction,
        amountCspr: d.decision.recommendedAmountCspr,
        riskScore: d.decision.riskScore,
        confidence: d.decision.confidence,
        dataCostCspr: motesToCspr(d.report.dataCostMotes),
        dataSources: d.report.purchased.map((p) => p.source),
        reason: d.decision.reason,
        onChain: d.onChain ?? null,
        violations: d.verdict.violations,
      })),
    ),
  );
});

app.post("/api/approve/:runId/:oppId", requireAuth, async (req, res) => {
  const idx = store.pendingApprovals.findIndex(
    (p) => p.runId === req.params.runId && p.opportunityId === req.params.oppId,
  );
  if (idx === -1) return res.status(404).json({ error: "no such pending approval" });

  // Idempotency: remove the approval and persist the removal SYNCHRONOUSLY before
  // the on-chain call, so a crash mid-execution can never let the same allocation
  // be approved (and transferred) twice. Restore it if the chain call fails.
  const [approval] = store.pendingApprovals.splice(idx, 1);
  flushState();

  // Human approval => execute with the OWNER key (the agent key alone cannot move
  // amounts >= the on-chain approval threshold).
  let exec: OnChainOutcome;
  try {
    // cspr.trade enabled => the approved allocation is executed as a REAL
    // CSPR->WUSDC swap on the DEX; otherwise the owner-signed vault transfer.
    exec = config.csprTradeEnabled
      ? await swapCsprForWusdc(approval.amountCspr)
      : await executeAllocationOnChain(
          {
            opportunityId: approval.opportunityId,
            amountCspr: approval.amountCspr,
            recipient: approval.recipient,
            riskScore: approval.riskScore,
            confidence: approval.confidence,
          },
          { asOwner: true },
        );
  } catch (err) {
    recordError(`approval execution threw: ${String(err)}`);
    store.pendingApprovals.push(approval);
    flushState();
    return res.status(500).json({ error: String(err) });
  }
  if (!exec.executed && !exec.dryRun) {
    recordError(`on-chain execution failed: ${exec.error ?? "unknown"}`);
    store.pendingApprovals.push(approval); // nothing moved on-chain — restore it
    flushState();
    return res.status(502).json({ error: exec.error ?? "on-chain execution failed" });
  }
  const record = await recordDecisionOnChain({
    opportunityId: approval.opportunityId,
    action: "ALLOCATE",
    confidence: approval.confidence,
    riskScore: approval.riskScore,
    amountCspr: approval.amountCspr,
    dataCostMotes: "0",
    dataSources: [],
    reason: `Human-approved allocation (queued at ${approval.queuedAt}).`,
  });

  rolloverDay(); // approval already removed from pending (above)
  const run = store.runs.find((r) => r.runId === approval.runId);
  const slot = run?.decisions.find((d) => d.decision.opportunityId === approval.opportunityId);
  if (slot) {
    slot.verdict.finalAction = "ALLOCATE";
    slot.decision.decision = "ALLOCATE";
    slot.decision.reason += " Approved by treasury owner.";
    slot.onChain = { ...(slot.onChain ?? { recorded: false, executed: false, dryRun: exec.dryRun }), ...record, executed: exec.executed || exec.dryRun };
  }
  if (exec.executed || exec.dryRun) {
    store.spentTodayCspr += approval.amountCspr;
    store.treasuryBalanceCspr -= approval.amountCspr;
  }
  store.ledger.push({
    ts: new Date().toISOString(),
    agent: "executor",
    message: `${approval.opportunityId}: human approved — ${approval.amountCspr} CSPR ${
      config.csprTradeEnabled ? "swapped → WUSDC on cspr.trade" : "allocated"
    }${exec.dryRun ? " (dry-run)" : " on Casper Testnet"}.`,
  });
  await refreshTreasuryFromChain();
  flushState();
  res.json({ ok: true, dryRun: exec.dryRun });
});

app.get("/api/opportunities", async (_req, res) => {
  res.json(await fetchOpportunities());
});

app.get("/api/payments", async (_req, res) => {
  let upstream: unknown[] = [];
  try {
    const r = await fetch(`${config.servicesUrl}/payments`);
    if (r.ok) upstream = (await r.json()) as unknown[];
  } catch {
    upstream = [];
  }
  // Merge the wallet usage-fee receipts (criterion 3) with the x402 data receipts.
  res.json([...upstream, ...store.feeReceipts]);
});

// --------------------------------------------------- non-custodial wallet flow
// The connected Casper Wallet signs every move; the server only builds the
// unsigned deploy and forwards the user's signature. These endpoints are NOT
// bearer-guarded: building a deploy is harmless, and a submitted deploy can only
// move exactly what the user signed — the fee itself is the run gate.

// Balance proxy: read an account's CSPR balance server-side (cspr.live blocks
// cross-origin browser reads, so the dashboard reads it through us instead).
app.get("/api/wallet/balance", async (req, res) => {
  const key = String(req.query.key ?? "");
  if (!/^0[12][0-9a-f]{60,}$/i.test(key)) return res.status(400).json({ error: "invalid public key" });
  try {
    const r = await fetch(`https://api.testnet.cspr.live/accounts/${key}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ balanceCspr: 0 }); // 404 = unfunded account
    const j = (await r.json()) as { data?: { balance?: string } };
    return res.json({ balanceCspr: Number(j.data?.balance ?? 0) / 1e9 });
  } catch {
    return res.json({ balanceCspr: null });
  }
});

// Fee terms (amount + fee wallet) so the UI can show the user what they'll pay.
app.get("/api/wallet/fee", (_req, res) => res.json(feeInfo()));

// Build the unsigned usage-fee deploy for the connected wallet to sign.
app.post("/api/wallet/fee/build", async (req, res) => {
  try {
    const from = String((req.body as { from?: string } | undefined)?.from ?? "");
    const built = await buildFeeDeploy(from);
    res.json(built);
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Attach the wallet's signature and submit to the node; record a receipt.
app.post("/api/wallet/fee/submit", async (req, res) => {
  const body = req.body as { deploy?: unknown; publicKey?: string; signatureHex?: string } | undefined;
  if (!body?.deploy || !body.publicKey || !body.signatureHex) {
    return res.status(400).json({ error: "deploy, publicKey and signatureHex are required" });
  }
  try {
    const { deployHash } = await submitSignedDeploy(body.deploy, body.publicKey, body.signatureHex);
    const receipt: FeeReceipt = {
      resource: "/api/run",
      amount: BigInt(Math.round(config.feeCspr * 1e9)).toString(),
      at: new Date().toISOString(),
      from: body.publicKey,
      settlement: { transaction: deployHash, mode: "cspr" },
    };
    store.feeReceipts.push(receipt);
    if (store.feeReceipts.length > 200) store.feeReceipts.splice(0, store.feeReceipts.length - 200);
    // Mint a one-time run credit so this paying wallet (no bearer token) can run once.
    const runCredit = deployHash || `${receipt.at}:${body.publicKey}`;
    store.runCredits.push(runCredit);
    if (store.runCredits.length > 200) store.runCredits.splice(0, store.runCredits.length - 200);
    store.ledger.push({
      ts: receipt.at!,
      agent: "system",
      message: `Usage fee received: ${config.feeCspr} CSPR from ${body.publicKey.slice(0, 10)}… (deploy ${deployHash.slice(0, 10)}…).`,
    });
    flushState();
    res.json({ ok: true, deployHash, runCredit });
  } catch (err) {
    recordError(`fee submit failed: ${String(err)}`);
    res.status(502).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

const server = app.listen(config.apiPort, () => {
  console.log(
    `[atlas-agent] API on http://localhost:${config.apiPort} (services: ${config.servicesUrl}, ${config.dryRun ? "dry-run" : "LIVE — Casper Testnet"})`,
  );
});

// Graceful shutdown: flush state to disk and stop accepting connections.
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[atlas-agent] ${sig} received — flushing state and shutting down.`);
    flushState();
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // drop idle keep-alive conns so close() fires promptly
    // Hard cap in case connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
