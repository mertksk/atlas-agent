/**
 * Atlas agent entrypoint.
 *
 *   npm run agent:run     one-shot pipeline run, ledger printed to console
 *   npm run agent         HTTP API on :4030 for the dashboard
 *
 * Multi-tenant: per-wallet SESSIONS. Every wallet-scoped request carries the
 * connected public key in the `X-Wallet` header (or the pubkey in the body for
 * signed writes); its runs, ledger, pending allocations, fee receipts and daily
 * spend live in an isolated Session. Requests with no/invalid wallet use the
 * shared "__demo__" session (token-authorized/local runs). Money never moves
 * without the wallet's own signature, so a session key is a public identifier,
 * not a secret — see the trust note on sessionKeyFrom().
 *
 * State is persisted to config.statePath so a restart resumes where it left off.
 */
import express from "express";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { config, defaultPolicy, validateConfig, ConfigError } from "./config.js";
import { runPipeline } from "./orchestrator.js";
import { reasonerLabel } from "./reasoning.js";
import { executeAllocationOnChain, recordDecisionOnChain, swapCsprForWusdc, vaultStatus, type OnChainOutcome } from "./chain.js";
import { feeInfo, buildFeeDeploy, buildTransferDeploy, submitSignedDeploy, accountHashOf } from "./wallet.js";
import { csprCloudEnabled, cloudAccountBalanceCspr, cloudFtHoldings } from "./csprCloud.js";
import { motesToCspr, type LedgerEntry, type RunResult } from "./types.js";

/** A payment receipt (usage fee or a user-signed allocation transfer). */
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

/** A non-custodial allocation awaiting the connected wallet's signature. */
interface PendingAllocation {
  runId: string;
  opportunityId: string;
  opportunityName: string;
  amountCspr: number;
  riskScore: number;
  confidence: number;
  reason: string;
  queuedAt: string;
}

// ------------------------------------------------------------- sessions
/** All per-wallet state. Keyed by the wallet public key (or DEMO_KEY). */
interface Session {
  key: string;
  ledger: LedgerEntry[];
  runs: RunResult[];
  pendingApprovals: PendingApproval[];
  pendingAllocations: PendingAllocation[];
  feeReceipts: FeeReceipt[];
  // One-time run credits minted by a paid usage fee (a wallet user has no bearer
  // token, so a successful fee authorizes exactly one run in ITS session).
  runCredits: string[];
  spentTodayCspr: number;
  dayStamp: string;
  lastError: { message: string; at: string } | null;
}

const DEMO_KEY = "__demo__";
// Old single-tenant state migrates here — preserved but NEVER served to any
// request, so a fresh anonymous visitor never sees the prior owner's history.
const LEGACY_KEY = "__legacy__";
const WALLET_RE = /^0[12][0-9a-f]{60,}$/;

function emptySession(key: string): Session {
  return {
    key,
    ledger: [],
    runs: [],
    pendingApprovals: [],
    pendingAllocations: [],
    feeReceipts: [],
    runCredits: [],
    spentTodayCspr: 0,
    dayStamp: utcDay(),
    lastError: null,
  };
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 5000; // backstop against unbounded growth
function getSession(key: string): Session {
  let s = sessions.get(key);
  if (!s) {
    // Backstop: if we somehow exceed the cap, evict the oldest (insertion-order)
    // session that isn't the demo session, so writes can't exhaust memory.
    if (sessions.size >= MAX_SESSIONS) {
      for (const k of sessions.keys()) {
        if (k !== DEMO_KEY) {
          sessions.delete(k);
          break;
        }
      }
    }
    s = emptySession(key);
    sessions.set(key, s);
  }
  return s;
}

/** Read-only lookup: returns a TRANSIENT empty session if absent, so read
 *  endpoints never create/retain sessions (bounds memory against GET spam with
 *  random X-Wallet values — only paid/authorized writes create real sessions). */
function peekSession(key: string): Session {
  return sessions.get(key) ?? emptySession(key);
}

/** Normalize any public-key string to a session key; non-wallets → demo session.
 *  TRUST MODEL: a session key is the wallet's PUBLIC key, and reads key off the
 *  (spoofable) X-Wallet header with no proof of control. So sessions ISOLATE
 *  state and gate WRITES (a run needs the secret fee credit; funds always need
 *  the wallet's own signature — no theft or spoofed writes), but READS are not a
 *  confidentiality boundary: someone who knows your public key can view your
 *  session's pending recommendations + reasoning (off-chain, low-sensitivity).
 *  A production deployment would add signed-challenge session auth for read
 *  confidentiality; for this testnet demo it is an accepted limitation. */
function normKey(pubKey: string | undefined): string {
  const k = (pubKey ?? "").trim().toLowerCase();
  return WALLET_RE.test(k) ? k : DEMO_KEY;
}
function sessionKeyFrom(req: express.Request): string {
  const w = req.headers["x-wallet"];
  return normKey(typeof w === "string" ? w : "");
}

// ------------------------------------------------------- process globals
const startedAt = Date.now();
// The pipeline uses the shared agent account (x402 data buys), so only one run
// executes at a time across all sessions; this holds the running session key.
let runningSession: string | null = null;
// On-chain agent-vault mirror (display fallback only; the dashboard shows the
// connected wallet's own balance as the treasury).
let agentVaultCspr = config.treasuryBalanceCspr;

/** Record an operational error on a session (surfaced in its health/metrics). */
function recordError(session: Session, message: string): void {
  session.lastError = { message: message.slice(0, 300), at: new Date().toISOString() };
  console.error(`[atlas-agent] error (${session.key.slice(0, 12)}): ${message}`);
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

/** Read an account's CSPR balance server-side. Prefers CSPR.Cloud (MAKE's
 *  indexer) when CSPR_CLOUD_API_KEY is set; falls back to the cspr.live explorer
 *  API so it behaves exactly as before when the key is absent or errors. */
async function accountBalanceCspr(key: string): Promise<number | null> {
  if (!WALLET_RE.test(key)) return null;
  if (csprCloudEnabled()) {
    try {
      return await cloudAccountBalanceCspr(key);
    } catch {
      /* CSPR.Cloud unavailable/quota — fall back to cspr.live below */
    }
  }
  try {
    const r = await fetch(`https://api.testnet.cspr.live/accounts/${key}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return 0; // 404 = unfunded account
    const j = (await r.json()) as { data?: { balance?: string } };
    return Number(j.data?.balance ?? 0) / 1e9;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- persistence
function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

interface PersistShape {
  sessions: Record<string, Omit<Session, "key">>;
  agentVaultCspr: number;
}

/** Legacy (pre-multitenant) flat state shape, migrated into the demo session. */
interface LegacyShape {
  ledger?: LedgerEntry[];
  runs?: RunResult[];
  pendingApprovals?: PendingApproval[];
  pendingAllocations?: PendingAllocation[];
  feeReceipts?: FeeReceipt[];
  runCredits?: string[];
  spentTodayCspr?: number;
  treasuryBalanceCspr?: number;
  dayStamp?: string;
}

function loadState(): void {
  try {
    if (!existsSync(config.statePath)) return;
    const raw = JSON.parse(readFileSync(config.statePath, "utf8")) as Partial<PersistShape> & LegacyShape;
    if (raw.sessions && typeof raw.sessions === "object") {
      for (const [key, s] of Object.entries(raw.sessions)) {
        sessions.set(key, { ...emptySession(key), ...(s as Omit<Session, "key">), key });
      }
      agentVaultCspr = raw.agentVaultCspr ?? config.treasuryBalanceCspr;
    } else if (raw.ledger || raw.runs || raw.feeReceipts) {
      // Migrate the old single-tenant state into the UNSERVED legacy session, so
      // it is preserved but never shown to a fresh anonymous visitor.
      const legacy = getSession(LEGACY_KEY);
      legacy.ledger = raw.ledger ?? [];
      legacy.runs = raw.runs ?? [];
      legacy.pendingApprovals = raw.pendingApprovals ?? [];
      legacy.pendingAllocations = raw.pendingAllocations ?? [];
      legacy.feeReceipts = raw.feeReceipts ?? [];
      legacy.runCredits = []; // old credits were public deploy hashes — drop them
      legacy.spentTodayCspr = raw.spentTodayCspr ?? 0;
      legacy.dayStamp = raw.dayStamp ?? utcDay();
      agentVaultCspr = raw.treasuryBalanceCspr ?? config.treasuryBalanceCspr;
    }
    for (const s of sessions.values()) if (rolloverDay(s)) writeStateNow();
    const totalRuns = [...sessions.values()].reduce((n, s) => n + s.runs.length, 0);
    console.log(`[atlas-agent] restored ${sessions.size} session(s), ${totalRuns} run(s) from ${config.statePath}.`);
  } catch (err) {
    console.warn(`[atlas-agent] could not load state from ${config.statePath}: ${String(err)}`);
  }
}

/** Atomic write: serialize to a temp file then rename, so a crash mid-write
 *  can never corrupt the state file (rename is atomic on the same filesystem). */
function writeStateNow(): void {
  try {
    mkdirSync(dirname(config.statePath), { recursive: true });
    const out: PersistShape = { sessions: {}, agentVaultCspr };
    for (const [key, s] of sessions.entries()) {
      const { key: _k, ...rest } = s;
      out.sessions[key] = rest;
    }
    const tmp = `${config.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2));
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

/** Flush pending state synchronously (used on money moves and graceful shutdown). */
function flushState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeStateNow();
}

/** Reset a session's daily-spend counter when the UTC day rolls over.
 *  Returns true if it changed state (so callers can persist). */
function rolloverDay(session: Session): boolean {
  const today = utcDay();
  if (session.dayStamp !== today) {
    session.spentTodayCspr = 0;
    session.dayStamp = today;
    return true;
  }
  return false;
}

/** In live mode, reconcile the agent-vault mirror with the on-chain vault. */
async function refreshTreasuryFromChain(): Promise<void> {
  if (config.dryRun) return;
  const vs = (await vaultStatus()) as { balance?: string } | null;
  if (vs?.balance) {
    agentVaultCspr = motesToCspr(vs.balance);
    console.log(`[atlas-agent] vault balance synced from chain: ${agentVaultCspr} CSPR`);
  }
}

// ------------------------------------------------------------------ run
async function executeRun(session: Session): Promise<RunResult> {
  rolloverDay(session);
  try {
    // Size allocations against the connected wallet's OWN balance — non-custodial,
    // so the "treasury" the agent invests from IS the user's CSPR. Keeps the
    // numbers coherent (invest from your real balance, capped by policy) instead
    // of the tiny agent-vault mirror. Falls back to the mirror if unavailable.
    let treasury = agentVaultCspr;
    if (session.key !== DEMO_KEY && session.key !== LEGACY_KEY) {
      const bal = await accountBalanceCspr(session.key);
      if (bal != null && bal > 0) treasury = bal;
    }
    const result = await runPipeline({
      policy: defaultPolicy,
      treasuryBalanceCspr: treasury,
      spentTodayCspr: session.spentTodayCspr,
      onLedger: (e) => session.ledger.push(e),
    });
    session.runs.push(result);
    if (session.runs.length > 40) session.runs.splice(0, session.runs.length - 40);

    const opps = await fetchOpportunities();
    for (const d of result.decisions) {
      if (d.verdict.finalAction === "ALLOCATE") {
        if (config.nonCustodial) {
          // Non-custodial: the user signs the CSPR transfer, so we don't debit
          // anything here — we surface a pending allocation for them to sign.
          const opp = opps.find((o) => o.id === d.decision.opportunityId);
          session.pendingAllocations = session.pendingAllocations.filter(
            (a) => a.opportunityId !== d.decision.opportunityId,
          );
          session.pendingAllocations.push({
            runId: result.runId,
            opportunityId: d.decision.opportunityId,
            opportunityName: opp?.name ?? d.decision.opportunityId,
            amountCspr: d.decision.recommendedAmountCspr,
            riskScore: d.decision.riskScore,
            confidence: d.decision.confidence,
            reason: d.decision.reason,
            queuedAt: new Date().toISOString(),
          });
        } else {
          const moved = config.dryRun || d.onChain?.executed === true;
          if (moved) session.spentTodayCspr += d.decision.recommendedAmountCspr;
        }
      }
      if (d.verdict.finalAction === "QUEUE_FOR_APPROVAL") {
        const opp = opps.find((o) => o.id === d.decision.opportunityId);
        session.pendingApprovals = session.pendingApprovals.filter(
          (a) => a.opportunityId !== d.decision.opportunityId,
        );
        session.pendingApprovals.push({
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

/** The per-session payment receipts: fee + allocation transfers, plus the x402
 *  data purchases derived from THIS session's own runs (so no cross-wallet leak). */
function sessionPayments(session: Session): FeeReceipt[] {
  const data: FeeReceipt[] = [];
  for (const r of session.runs) {
    for (const d of r.decisions) {
      for (const p of d.report.purchased) {
        data.push({
          resource: `/api/${p.source}`,
          amount: p.costMotes,
          at: r.finishedAt ?? r.startedAt,
          settlement: { transaction: p.settlementTx, mode: p.settlementMode },
        });
      }
    }
  }
  return [...data, ...session.feeReceipts];
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
if (!config.dryRun) {
  try {
    await refreshTreasuryFromChain();
    flushState();
  } catch (err) {
    recordError(getSession(DEMO_KEY), `startup vault refresh failed: ${String(err)}`);
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Fee-Credit, X-Wallet");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

// Liveness probe: always 200 if the process answers (global, not per-session).
app.get("/api/health", async (_req, res) => {
  const services = await ping(`${config.servicesUrl}/opportunities`);
  const totalRuns = [...sessions.values()].reduce((n, s) => n + s.runs.length, 0);
  res.json({
    ok: true,
    mode: config.dryRun ? "dry-run" : "live",
    running: runningSession != null,
    runs: totalRuns,
    sessions: sessions.size,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    lastError: peekSession(DEMO_KEY).lastError,
    deps: { services },
  });
});

// Per-session operational metrics.
app.get("/api/metrics", (req, res) => {
  const session = peekSession(sessionKeyFrom(req));
  rolloverDay(session);
  res.json({
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    mode: config.dryRun ? "dry-run" : "live",
    reasoner: reasonerLabel(),
    runs: session.runs.length,
    decisions: session.runs.reduce((n, r) => n + r.decisions.length, 0),
    pendingApprovals: session.pendingApprovals.length,
    treasuryBalanceCspr: agentVaultCspr,
    spentTodayCspr: session.spentTodayCspr,
    running: runningSession === session.key,
    lastError: session.lastError,
  });
});

app.get("/api/state", (req, res) => {
  const session = peekSession(sessionKeyFrom(req));
  rolloverDay(session);
  const last = session.runs.at(-1);
  res.json({
    mode: config.dryRun ? "dry-run" : "live",
    network: "casper-test",
    policy: defaultPolicy,
    treasuryBalanceCspr: agentVaultCspr,
    spentTodayCspr: session.spentTodayCspr,
    running: runningSession === session.key,
    runs: session.runs.length,
    lastRunId: last?.runId ?? null,
    lastRunDataCostCspr: last ? motesToCspr(last.totalDataCostMotes) : 0,
    pendingApprovals: session.pendingApprovals,
    pendingAllocations: session.pendingAllocations,
    nonCustodial: config.nonCustodial,
    llm: Boolean(config.openrouterApiKey || config.anthropicApiKey),
    reasoner: reasonerLabel(),
    contracts: { vault: config.vaultAddress ?? null, registry: config.registryAddress ?? null },
  });
});

/** Consume a one-time run credit from a session (minted by its paid usage fee). */
function consumeRunCredit(session: Session, credit: string): boolean {
  const i = session.runCredits.indexOf(credit);
  if (i === -1) return false;
  session.runCredits.splice(i, 1);
  saveState();
  return true;
}

/** Authorize a run. The shared demo session uses the operator bearer token; a
 *  WALLET session can only be run with the SECRET run credit minted by THAT
 *  wallet's paid fee — the (public, spoofable) X-Wallet header never authorizes a
 *  run into someone else's session. */
function runAuthorized(req: express.Request, key: string, session: Session): boolean {
  if (key === DEMO_KEY) return tokenAuthorized(req);
  const credit = req.headers["x-fee-credit"];
  return typeof credit === "string" && consumeRunCredit(session, credit);
}

app.post("/api/run", (req, res) => {
  const key = sessionKeyFrom(req);
  // Authorize against the EXISTING session (its paid-fee run credit) without
  // creating one — an unauthorized request must not mint a session (GET/POST spam).
  const session = sessions.get(key) ?? emptySession(key);
  if (!runAuthorized(req, key, session)) {
    return res.status(401).json({ error: "unauthorized: provide a bearer token or pay the usage fee" });
  }
  if (runningSession != null) return res.status(409).json({ error: "a run is already in progress" });
  if (!sessions.has(key)) sessions.set(key, session); // persist only once authorized
  runningSession = session.key;
  executeRun(session)
    .catch((err) => {
      recordError(session, `run failed: ${String(err)}`);
      session.ledger.push({ ts: new Date().toISOString(), agent: "system", message: `run failed: ${String(err)}` });
      saveState();
    })
    .finally(() => {
      runningSession = null;
    });
  res.status(202).json({ accepted: true });
});

app.get("/api/events", (req, res) => {
  const session = peekSession(sessionKeyFrom(req));
  const since = Math.max(0, Number(req.query.since ?? 0) || 0);
  res.json({ cursor: session.ledger.length, events: session.ledger.slice(since) });
});

app.get("/api/runs/latest", (req, res) => {
  const session = peekSession(sessionKeyFrom(req));
  const last = session.runs.at(-1);
  if (!last) return res.status(404).json({ error: "no runs yet" });
  res.json(last);
});

app.get("/api/decisions", (req, res) => {
  const session = peekSession(sessionKeyFrom(req));
  res.json(
    session.runs.flatMap((r) =>
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

app.get("/api/opportunities", async (_req, res) => {
  res.json(await fetchOpportunities());
});

app.get("/api/payments", (req, res) => {
  const session = peekSession(sessionKeyFrom(req));
  res.json(sessionPayments(session));
});

// --------------------------------------------------- non-custodial wallet flow
// The connected Casper Wallet signs every move; the server only builds the
// unsigned deploy and forwards the user's signature. Not bearer-guarded: a
// submitted deploy can only move exactly what the user signed.

// Balance proxy: read an account's CSPR balance server-side.
app.get("/api/wallet/balance", async (req, res) => {
  const key = normKey(String(req.query.key ?? ""));
  if (key === DEMO_KEY) return res.status(400).json({ error: "invalid public key" });
  const balanceCspr = await accountBalanceCspr(key);
  res.json({ balanceCspr });
});

// CEP-18 token holdings for a wallet, via CSPR.Cloud's indexer — lets the UI
// show (and thereby on-chain-VERIFY) the WUSDC the user received from the swap,
// instead of trusting the DEX response. Empty when CSPR.Cloud isn't configured.
app.get("/api/wallet/holdings", async (req, res) => {
  const key = normKey(String(req.query.key ?? ""));
  if (key === DEMO_KEY) return res.status(400).json({ error: "invalid public key" });
  if (!csprCloudEnabled()) return res.json({ holdings: [], source: null });
  try {
    const holdings = await cloudFtHoldings(key);
    res.json({ holdings, source: "cspr.cloud" });
  } catch {
    res.json({ holdings: [], source: null });
  }
});

// Fee terms (amount + fee wallet) so the UI can show the user what they'll pay.
app.get("/api/wallet/fee", (_req, res) => res.json(feeInfo()));

// Build the unsigned usage-fee deploy for the connected wallet to sign.
app.post("/api/wallet/fee/build", async (req, res) => {
  try {
    const from = String((req.body as { from?: string } | undefined)?.from ?? "");
    res.json(await buildFeeDeploy(from));
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Build the unsigned CSPR transfer for a pending allocation (user signs it).
app.post("/api/wallet/allocate/build", async (req, res) => {
  const body = req.body as { from?: string; opportunityId?: string } | undefined;
  const from = String(body?.from ?? "");
  const oppId = String(body?.opportunityId ?? "");
  const session = getSession(normKey(from));
  const pending = session.pendingAllocations.find((a) => a.opportunityId === oppId);
  if (!pending) return res.status(404).json({ error: "no pending allocation for that opportunity" });
  try {
    const built = await buildTransferDeploy(from, config.allocationRecipientHex, pending.amountCspr);
    res.json({ ...built, opportunityName: pending.opportunityName });
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Attach the wallet's signature, submit the allocation transfer, record it.
app.post("/api/wallet/allocate/submit", async (req, res) => {
  const body = req.body as
    | { deploy?: unknown; publicKey?: string; signatureHex?: string; opportunityId?: string }
    | undefined;
  if (!body?.deploy || !body.publicKey || !body.signatureHex || !body.opportunityId) {
    return res.status(400).json({ error: "deploy, publicKey, signatureHex and opportunityId are required" });
  }
  const session = getSession(normKey(body.publicKey));
  const idx = session.pendingAllocations.findIndex((a) => a.opportunityId === body.opportunityId);
  if (idx === -1) return res.status(404).json({ error: "no pending allocation for that opportunity" });
  const alloc = session.pendingAllocations[idx];
  try {
    // 1. REAL cspr.trade swap FIRST — from the agent's buffer → WUSDC to the USER's
    //    own account. Doing it before we take the user's CSPR means that if the
    //    swap fails, we never submit their signed transfer and they keep their CSPR.
    const toAccount = await accountHashOf(body.publicKey);
    const swap = await swapCsprForWusdc(alloc.amountCspr, toAccount);
    if (!swap.executed && !swap.dryRun) {
      return res.status(502).json({ error: `swap failed (your CSPR was not taken): ${swap.error ?? "unknown"}` });
    }
    // 2. Swap succeeded (WUSDC is in the user's wallet) — now submit the user's
    //    signed CSPR transfer to the agent, which replenishes the swap buffer.
    const { deployHash } = await submitSignedDeploy(body.deploy, body.publicKey, body.signatureHex);

    session.pendingAllocations.splice(idx, 1);
    session.spentTodayCspr += alloc.amountCspr;
    const wusdcOut = swap.expectedOut ? (Number(swap.expectedOut) / 1e6).toFixed(4) : null;
    session.feeReceipts.push({
      resource: "/api/allocate",
      amount: BigInt(Math.round(alloc.amountCspr * 1e9)).toString(),
      at: new Date().toISOString(),
      from: body.publicKey,
      // Link the receipt to the real DEX swap tx (the WUSDC the user received).
      settlement: { transaction: swap.txHash ?? deployHash, mode: "wusdc-swap" },
    });
    if (session.feeReceipts.length > 200) session.feeReceipts.splice(0, session.feeReceipts.length - 200);
    const run = session.runs.find((r) => r.runId === alloc.runId);
    const slot = run?.decisions.find((d) => d.decision.opportunityId === alloc.opportunityId);
    if (slot) slot.onChain = { ...(slot.onChain ?? { recorded: false, dryRun: false }), executed: true };
    session.ledger.push({
      ts: new Date().toISOString(),
      agent: "executor",
      message: `${alloc.opportunityId}: you invested ${alloc.amountCspr} CSPR → received ${wusdcOut ? `≈ ${wusdcOut} ` : ""}WUSDC in your wallet (real cspr.trade swap${swap.txHash ? `, ${swap.txHash.slice(0, 10)}…` : ""}) on Casper Testnet.`,
    });
    flushState();
    res.json({ ok: true, deployHash, swapTx: swap.txHash, wusdcReceived: wusdcOut });
  } catch (err) {
    recordError(session, `allocation submit failed: ${String(err)}`);
    res.status(502).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Attach the wallet's signature, submit the fee, mint a run credit in ITS session.
app.post("/api/wallet/fee/submit", async (req, res) => {
  const body = req.body as { deploy?: unknown; publicKey?: string; signatureHex?: string } | undefined;
  if (!body?.deploy || !body.publicKey || !body.signatureHex) {
    return res.status(400).json({ error: "deploy, publicKey and signatureHex are required" });
  }
  const session = getSession(normKey(body.publicKey));
  try {
    const { deployHash } = await submitSignedDeploy(body.deploy, body.publicKey, body.signatureHex);
    const receipt: FeeReceipt = {
      resource: "/api/run",
      amount: BigInt(Math.round(config.feeCspr * 1e9)).toString(),
      at: new Date().toISOString(),
      from: body.publicKey,
      settlement: { transaction: deployHash, mode: "cspr" },
    };
    session.feeReceipts.push(receipt);
    if (session.feeReceipts.length > 200) session.feeReceipts.splice(0, session.feeReceipts.length - 200);
    // Secret, unguessable credit (NOT the public on-chain deploy hash) returned
    // only in this HTTP response — so only the paying browser can run the session.
    const runCredit = randomUUID();
    session.runCredits.push(runCredit);
    if (session.runCredits.length > 20) session.runCredits.splice(0, session.runCredits.length - 20);
    session.ledger.push({
      ts: receipt.at!,
      agent: "system",
      message: `Usage fee received: ${config.feeCspr} CSPR from ${body.publicKey.slice(0, 10)}… (deploy ${deployHash.slice(0, 10)}…).`,
    });
    flushState();
    res.json({ ok: true, deployHash, runCredit });
  } catch (err) {
    recordError(session, `fee submit failed: ${String(err)}`);
    res.status(502).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

/** Bearer-token guard (funds-moving routes that use the SERVER's owner key). */
function tokenAuthorized(req: express.Request): boolean {
  if (!config.apiToken) return true; // no token configured (dev/localhost)
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(config.apiToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Human approval path (custodial mode only): execute a queued allocation with
// the owner key. Token-guarded — it moves funds with the SERVER's key (unlike
// the non-custodial allocation flow, where the user signs). In non-custodial
// mode (default) there are no pending approvals, so this path is unused.
app.post("/api/approve/:runId/:oppId", async (req, res) => {
  if (!tokenAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const session = getSession(sessionKeyFrom(req));
  const idx = session.pendingApprovals.findIndex(
    (p) => p.runId === req.params.runId && p.opportunityId === req.params.oppId,
  );
  if (idx === -1) return res.status(404).json({ error: "no such pending approval" });
  const [approval] = session.pendingApprovals.splice(idx, 1);
  flushState();

  let exec: OnChainOutcome;
  try {
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
    recordError(session, `approval execution threw: ${String(err)}`);
    session.pendingApprovals.push(approval);
    flushState();
    return res.status(500).json({ error: String(err) });
  }
  if (!exec.executed && !exec.dryRun) {
    recordError(session, `on-chain execution failed: ${exec.error ?? "unknown"}`);
    session.pendingApprovals.push(approval);
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
  const run = session.runs.find((r) => r.runId === approval.runId);
  const slot = run?.decisions.find((d) => d.decision.opportunityId === approval.opportunityId);
  if (slot) {
    slot.verdict.finalAction = "ALLOCATE";
    slot.decision.decision = "ALLOCATE";
    slot.onChain = { ...(slot.onChain ?? { recorded: false, executed: false, dryRun: exec.dryRun }), ...record, executed: exec.executed || exec.dryRun };
  }
  if (exec.executed || exec.dryRun) session.spentTodayCspr += approval.amountCspr;
  session.ledger.push({
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
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
