"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Onboarding from "./Onboarding";
import { downloadReport } from "./report";

const AGENT = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4030";
const DEFAULT_TOKEN = process.env.NEXT_PUBLIC_AGENT_API_TOKEN ?? "";

/* ------------------------------------------------------------- types */
interface Policy {
  maxAllocationPerOpCspr: number;
  maxDailySpendCspr: number;
  minConfidence: number;
  maxRiskScore: number;
  approvalThresholdCspr: number;
  dataBudgetCspr: number;
}
interface Approval {
  runId: string;
  opportunityId: string;
  opportunityName: string;
  amountCspr: number;
  riskScore: number;
  confidence: number;
  reason: string;
}
interface State {
  mode: "dry-run" | "live";
  network: string;
  policy: Policy;
  treasuryBalanceCspr: number;
  spentTodayCspr: number;
  running: boolean;
  runs: number;
  pendingApprovals: Approval[];
  lastRunDataCostCspr: number;
  llm: boolean;
  reasoner?: string;
  contracts: { vault: string | null; registry: string | null };
}
interface Opp {
  id: string;
  name: string;
  category: string;
  advertisedApyBps: number;
  blurb: string;
}
interface Decision {
  runId: string;
  opportunityId: string;
  action: "ALLOCATE" | "REJECT" | "HOLD" | "QUEUE_FOR_APPROVAL";
  amountCspr: number;
  riskScore: number;
  confidence: number;
  dataCostCspr: number;
  dataSources: string[];
  reason: string;
  violations: string[];
}
interface Entry {
  ts: string;
  agent: string;
  message: string;
}
interface Payment {
  resource?: string;
  amount?: string;
  at?: string;
  settlement?: { transaction?: string; mode?: string };
}
interface Metrics {
  uptimeSec: number;
  runs: number;
  decisions: number;
  reasoner?: string;
  lastError?: { message: string; at: string } | null;
}
interface Health {
  ok: boolean;
  uptimeSec: number;
  lastError: { message: string; at: string } | null;
  deps: { services: boolean };
}

/* ---------------------------------------------------------- the agent pipeline */
// Each role gets a plain-language job description (always visible) and a
// present-tense "doing" line for the live status strip — so a first-time
// visitor can tell what pressing "run analysis" actually does.
const ROLES = [
  { key: "scout", label: "Scout", desc: "finds live pools", doing: "scanning the market for opportunities" },
  { key: "analyst", label: "Analyst", desc: "buys paid evidence", doing: "buying risk data over x402 — each item is a real paid request" },
  { key: "risk-officer", label: "Risk Officer", desc: "scores the danger", doing: "scoring risk from the purchased evidence" },
  { key: "treasurer", label: "Treasurer", desc: "sizes the investment", doing: "deciding how much (if anything) to invest" },
  { key: "policy-guard", label: "Policy Guard", desc: "enforces the rules", doing: "checking every rule — caps, risk ceiling, confidence" },
  { key: "executor", label: "Executor", desc: "moves the money", doing: "executing on-chain and recording the decision" },
] as const;
const ROLE_COLOR: Record<string, string> = {
  scout: "var(--steel)",
  analyst: "var(--copper)",
  "risk-officer": "var(--violet)",
  treasurer: "var(--jade)",
  "policy-guard": "var(--coral)",
  executor: "var(--gold)",
};

const cspr = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtDur = (s?: number) => {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Payment amounts arrive in the settlement asset's base units. */
function fmtPayment(p: Payment): string {
  if (!p.amount) return "?";
  try {
    const n = Number(BigInt(p.amount));
    return p.settlement?.mode === "wusdc" ? `${(n / 1e6).toFixed(4)} WUSDC` : `${cspr(n / 1e9)} CSPR`;
  } catch {
    return "?";
  }
}

/** Replace raw pool ids / long hashes in agent messages with readable names. */
function humanize(msg: string, names: Map<string, string>): string {
  let out = msg;
  for (const [id, name] of names) if (id && out.includes(id)) out = out.split(id).join(name);
  return out
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => `${m.slice(0, 8)}…`)
    .replace(/\b[0-9a-f]{24,64}\b/gi, (m) => `${m.slice(0, 10)}…`);
}

/** Tween a number toward its target (ease-out cubic) for the vault figure. */
function useCountUp(target: number, ms = 750): number {
  const [val, setVal] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min((t - t0) / ms, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(start + (target - start) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return val;
}

/** Derive which agents have spoken in the current/last run, and who's active. */
function pipelineState(ledger: Entry[], running: boolean) {
  let start = 0;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].agent === "system" && /start/i.test(ledger[i].message)) {
      start = i;
      break;
    }
  }
  const counts: Record<string, number> = {};
  let last: string | null = null;
  let lastEntry: Entry | null = null;
  for (const e of ledger.slice(start)) {
    if (e.agent === "system") continue;
    counts[e.agent] = (counts[e.agent] ?? 0) + 1;
    last = e.agent;
    lastEntry = e;
  }
  return { counts, current: running ? last : null, lastEntry };
}

/* -------------------------------------------------------------- page */
export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [opps, setOpps] = useState<Opp[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const cursor = useRef(0);
  // id -> human name, accumulated across polls so old ledger lines stay readable
  const names = useRef(new Map<string, string>());
  const runStartedAt = useRef<number | null>(null);

  // Local demo convenience: if NEXT_PUBLIC_AGENT_API_TOKEN is provided (local/dev
  // only — never bake it into a public deployment), the field auto-fills so you
  // don't have to paste it. Otherwise you enter it manually. Persisted in
  // localStorage so a manual entry sticks across sessions.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Local mode: the prefilled default always wins (avoids a stale/wrong token
    // stuck in localStorage). Public deploys (no default) use the entered token.
    const stored = window.localStorage.getItem("atlas_token");
    setToken(DEFAULT_TOKEN || stored || "");
  }, []);
  const saveToken = (v: string) => {
    setToken(v);
    if (typeof window !== "undefined") window.localStorage.setItem("atlas_token", v);
  };
  const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

  const poll = useCallback(async () => {
    try {
      const [s, o, d, e, p, m, h] = await Promise.all([
        fetch(`${AGENT}/api/state`).then((r) => r.json()),
        fetch(`${AGENT}/api/opportunities`).then((r) => r.json()),
        fetch(`${AGENT}/api/decisions`).then((r) => r.json()),
        fetch(`${AGENT}/api/events?since=${cursor.current}`).then((r) => r.json()),
        fetch(`${AGENT}/api/payments`).then((r) => r.json()),
        fetch(`${AGENT}/api/metrics`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT}/api/health`).then((r) => r.json()).catch(() => null),
      ]);
      setState(s);
      setOpps(o);
      setDecisions(d);
      if (e.events.length) setLedger((prev) => [...prev, ...e.events]);
      cursor.current = e.cursor;
      setPayments(p);
      setMetrics(m);
      setHealth(h);
      setOffline(false);
      // learn readable names for raw pool ids
      for (const opp of o as Opp[]) names.current.set(opp.id, opp.name);
      for (const a of (s as State).pendingApprovals ?? []) names.current.set(a.opportunityId, a.opportunityName);
      // track when a run started (for the elapsed timer)
      if ((s as State).running && runStartedAt.current == null) runStartedAt.current = Date.now();
      if (!(s as State).running) runStartedAt.current = null;
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [poll]);

  const runAnalysis = async () => {
    await fetch(`${AGENT}/api/run`, { method: "POST", headers: authHeaders() }).catch(() => undefined);
    poll();
  };
  const approve = async (a: Approval) => {
    await fetch(`${AGENT}/api/approve/${a.runId}/${a.opportunityId}`, { method: "POST", headers: authHeaders() }).catch(
      () => undefined,
    );
    poll();
  };

  const latest = new Map<string, Decision>();
  for (const d of decisions) latest.set(d.opportunityId, d);

  const dataSpend = state?.lastRunDataCostCspr ?? 0;
  const budget = state?.policy.dataBudgetCspr ?? 1;
  const treasury = useCountUp(state?.treasuryBalanceCspr ?? 0);
  const pipe = pipelineState(ledger, state?.running ?? false);
  const activeRole = ROLES.find((r) => r.key === pipe.current);
  const activeStep = activeRole ? ROLES.indexOf(activeRole) + 1 : 0;
  const lastRunSummary = [...ledger].reverse().find((e) => e.agent === "system" && /run complete/i.test(e.message));
  const pendingCount = state?.pendingApprovals.length ?? 0;

  return (
    <div className="shell">
      <Onboarding />
      {/* ---------------------------------------------------------- masthead */}
      <header className="masthead">
        <div className="wordmark">
          <h1>
            ATLA<em>S</em>
          </h1>
          <span className="tag">autonomous treasury · buys the evidence before it moves the money</span>
        </div>
        <div className="mast-right">
          {offline && (
            <span className="chip alert pulse">
              <i className="dot" /> agent offline
            </span>
          )}
          {state && (
            <>
              <span className={`chip ${state.mode === "live" ? "live" : "dry"} pulse`}>
                <i className="dot" /> {state.mode === "live" ? "casper testnet · live" : "dry-run"}
              </span>
              <span className="chip" title="The AI model doing the reasoning">
                {state.reasoner ?? (state.llm ? "llm reasoning" : "deterministic")}
              </span>
            </>
          )}
          <button
            className="report-btn"
            onClick={() => downloadReport({ state, opps, decisions, payments, ledger }).catch(() => undefined)}
            disabled={!state}
            title="Download an .xlsx report: decisions, evidence bought, x402 settlements, ledger"
          >
            ⤓ report
          </button>
          {token && !editingToken ? (
            <span className="chip authed" title="Authorized to run analysis and approve allocations">
              <i className="dot" /> authorized
              <button className="chip-link" onClick={() => setEditingToken(true)} title="Change API token">
                change
              </button>
            </span>
          ) : (
            <input
              className="token-input"
              type="password"
              placeholder="API token"
              value={token}
              autoFocus={editingToken}
              onChange={(e) => saveToken(e.target.value)}
              onBlur={() => setEditingToken(false)}
              title="Bearer token for run/approve (set AGENT_API_TOKEN on the agent)"
            />
          )}
          <button
            className={`run-btn ${state?.running ? "working" : ""}`}
            onClick={runAnalysis}
            disabled={!state || state.running}
            title="Scans live pools, buys evidence with real x402 payments, decides, records on-chain. A live run takes a few minutes."
          >
            {state?.running ? "agents working…" : "run analysis"}
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------- hero */}
      <div className="hero">
        <section className="vault reveal reveal-1">
          <span className="label">Treasury under management</span>
          <div className="figure">
            {state ? cspr(treasury) : "—"}
            <span className="unit">CSPR</span>
          </div>
          <div className="substats">
            <div>
              <span className="n">{state ? cspr(state.spentTodayCspr) : "—"}</span>
              <span className="l">invested today</span>
            </div>
            <div>
              <span className="n">{cspr(dataSpend)}</span>
              <span className="l">spent on evidence (last run)</span>
            </div>
            <div>
              <span className="n">{metrics?.decisions ?? "—"}</span>
              <span className="l">decisions on-chain</span>
            </div>
            <div>
              <span className="n">{state?.runs ?? 0}</span>
              <span className="l">runs</span>
            </div>
          </div>
        </section>

        <section className="pipeline reveal reveal-2">
          <div className="phead">
            <h2>The desk — six agents work left to right</h2>
            <span className="live-cost" title="How much of this run's data budget went to paid evidence">
              evidence budget&nbsp; <b>{cspr(dataSpend)}</b> / {cspr(budget)} CSPR
            </span>
          </div>
          <div className="flow">
            {ROLES.map((r, i) => {
              const done = (pipe.counts[r.key] ?? 0) > 0;
              const active = pipe.current === r.key;
              return (
                <div
                  key={r.key}
                  className={`step ${active ? "active" : done ? "done" : ""}`}
                  style={{ "--role": ROLE_COLOR[r.key] } as React.CSSProperties}
                >
                  <span className="node">{i + 1}</span>
                  <span className="role">{r.label}</span>
                  <span className="desc">{r.desc}</span>
                  <span className="count">{active ? "working…" : done ? `✓ ${pipe.counts[r.key]}` : ""}</span>
                </div>
              );
            })}
          </div>

          {/* live narration — what is actually happening right now */}
          <div
            className={`desk-status ${state?.running ? "running" : ""}`}
            style={activeRole ? ({ "--role": ROLE_COLOR[activeRole.key] } as React.CSSProperties) : undefined}
          >
            {state?.running ? (
              <>
                <span className="spin" aria-hidden />
                <div>
                  <div className="ds-line">
                    <b>
                      {activeRole ? `${activeRole.label} is ${activeRole.doing}` : "Starting the run — the desk is waking up"}
                    </b>
                    <span className="ds-meta">
                      {activeStep > 0 ? ` · step ${activeStep}/6` : ""} ·{" "}
                      {fmtDur(runStartedAt.current ? (Date.now() - runStartedAt.current) / 1000 : undefined)} elapsed
                    </span>
                  </div>
                  {pipe.lastEntry && <div className="ds-detail">{humanize(pipe.lastEntry.message, names.current)}</div>}
                </div>
              </>
            ) : lastRunSummary ? (
              <div>
                <div className="ds-line">
                  <b>Last run finished.</b>
                  <span className="ds-meta"> {humanize(lastRunSummary.message.replace(/^Run complete: /i, ""), names.current)}</span>
                </div>
                <div className="ds-detail">
                  Press <b>run analysis</b> to start a new cycle — the desk scans real pools, pays for evidence over
                  x402, then decides. {pendingCount > 0 ? `${pendingCount} decision(s) below are waiting for you.` : ""}
                </div>
              </div>
            ) : (
              <div>
                <div className="ds-line">
                  <b>Ready when you are.</b>
                </div>
                <div className="ds-detail">
                  Press <b>run analysis</b> and watch the desk work left to right: find pools → buy evidence (real x402
                  payments) → score risk → size the bet → check the rules → execute on-chain. A live run takes a few
                  minutes.
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------------- grid */}
      <main className="grid">
        {/* left rail */}
        <aside>
          <section className="panel reveal reveal-2">
            <h2>The rules — enforced by the contract</h2>
            <p className="sub">The agent physically cannot break these; the smart contract rejects the transaction.</p>
            {state ? (
              <>
                <div className="rail-row" title="The agent can never put more than this into a single opportunity">
                  <span className="k">max per investment</span>
                  <span className="v">≤ {state.policy.maxAllocationPerOpCspr} CSPR</span>
                </div>
                <div className="rail-row" title="Hard daily ceiling, resets at midnight UTC">
                  <span className="k">max per day</span>
                  <span className="v">≤ {state.policy.maxDailySpendCspr} CSPR</span>
                </div>
                <div className="rail-row" title="Anything scored riskier than this is rejected automatically">
                  <span className="k">auto-reject risk above</span>
                  <span className="v">{state.policy.maxRiskScore} / 100</span>
                </div>
                <div className="rail-row" title="Below this confidence the agent won't act at all">
                  <span className="k">min confidence to act</span>
                  <span className="v">{Math.round(state.policy.minConfidence * 100)}%</span>
                </div>
                <div className="rail-row" title="Anything bigger than this waits for a human to approve it">
                  <span className="k">your sign-off needed over</span>
                  <span className="v">{state.policy.approvalThresholdCspr} CSPR</span>
                </div>
                <div className="meter" aria-hidden>
                  <i style={{ width: `${Math.min((dataSpend / budget) * 100, 100)}%` }} />
                </div>
                <div className="meter-cap">
                  evidence budget: {cspr(dataSpend)} of {cspr(budget)} CSPR used last run
                </div>
              </>
            ) : (
              <div className="empty">connecting…</div>
            )}
          </section>

          <details className="panel contracts-details reveal reveal-3">
            <summary>
              Contracts <span className="sum-hint">on-chain addresses</span>
            </summary>
            <div className="contract">
              <span className="cn">TreasuryVault — holds &amp; guards the money</span>
              {state?.contracts.vault ? (
                <a
                  className="cv"
                  href={`https://testnet.cspr.live/contract-package/${state.contracts.vault.replace("hash-", "")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {state.contracts.vault.slice(0, 26)}…
                </a>
              ) : (
                <span className="cv off">not deployed</span>
              )}
            </div>
            <div className="contract">
              <span className="cn">DecisionRegistry — permanent decision log</span>
              {state?.contracts.registry ? (
                <a
                  className="cv"
                  href={`https://testnet.cspr.live/contract-package/${state.contracts.registry.replace("hash-", "")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {state.contracts.registry.slice(0, 26)}…
                </a>
              ) : (
                <span className="cv off">not deployed</span>
              )}
            </div>
          </details>
        </aside>

        {/* center — approvals + opportunities */}
        <section>
          {state && pendingCount > 0 && (
            <div className="approvals">
              <div className="approvals-head">
                <h2>
                  Needs your sign-off <span className="badge">{pendingCount}</span>
                </h2>
                <p className="sub">
                  These are above your {state.policy.approvalThresholdCspr} CSPR threshold. Approving executes the
                  investment on-chain — for real.
                </p>
              </div>
              {state.pendingApprovals.map((a) => (
                <div className="approval" key={`${a.runId}-${a.opportunityId}`}>
                  <div className="what">
                    Invest <b>{a.amountCspr} CSPR</b> in <b>{a.opportunityName}</b>?
                    <span className="ap-meta">
                      risk {a.riskScore}/100 · confidence {Math.round(a.confidence * 100)}%
                    </span>
                  </div>
                  <button className="approve-btn" onClick={() => approve(a)}>
                    approve
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="opps-head">
            <div>
              <h2>Opportunities</h2>
              <p className="sub">Real pools, live from DefiLlama. The agent's verdict on each is stamped on the card.</p>
            </div>
            <span className="count">{opps.length} on the desk</span>
          </div>

          {opps.length === 0 && <div className="panel empty">Marketplace unreachable — start the data services.</div>}

          {opps.map((o, idx) => {
            const d = latest.get(o.id);
            const cls =
              d?.action === "ALLOCATE"
                ? "allocated"
                : d?.action === "REJECT"
                  ? "rejected"
                  : d?.action === "QUEUE_FOR_APPROVAL"
                    ? "queued"
                    : "";
            const apy = o.advertisedApyBps / 100;
            const risk = d?.riskScore ?? null;
            const riskColor =
              risk === null ? "var(--faint)" : risk > 60 ? "var(--coral)" : risk > 35 ? "var(--copper)" : "var(--jade)";
            const actionLabel =
              d?.action === "ALLOCATE"
                ? "invested"
                : d?.action === "REJECT"
                  ? "rejected"
                  : d?.action === "QUEUE_FOR_APPROVAL"
                    ? "awaiting sign-off"
                    : d?.action === "HOLD"
                      ? "on hold"
                      : null;
            return (
              <article className={`opp ${cls}`} key={o.id} style={{ animationDelay: `${Math.min(idx * 60, 360)}ms` }}>
                <div className="opp-head">
                  <div>
                    <span className="cat">{o.category}</span>
                    <h3>{o.name}</h3>
                  </div>
                  <div className="right">
                    <span className={`apy ${apy > 30 ? "absurd" : ""}`} title="The yield this pool advertises — before the agent verifies it">
                      advertised
                      <br />
                      <b>{apy.toFixed(1)}%</b> APY
                    </span>
                    {d && actionLabel && <span className={`action ${d.action}`}>{actionLabel}</span>}
                  </div>
                </div>

                <div className="riskbar">
                  <span>risk {risk ?? "—"}</span>
                  <span className="track" aria-hidden>
                    <i style={{ width: `${risk ?? 0}%`, background: riskColor }} />
                  </span>
                  <span>confidence {d ? `${Math.round(d.confidence * 100)}%` : "—"}</span>
                </div>

                <p className="why">
                  {d ? (
                    <>
                      <span className="why-tag">agent&apos;s reasoning</span> {d.reason}
                    </>
                  ) : (
                    o.blurb
                  )}
                </p>
                {d && (
                  <p className="bought">
                    {d.dataSources.length > 0 ? (
                      <>
                        <span className="x402" title="Paid for with a real on-chain micro-payment">x402</span>
                        evidence bought: {d.dataSources.join(" + ")} · <b>{cspr(d.dataCostCspr)} CSPR</b>
                      </>
                    ) : (
                      "no paid evidence needed for this one"
                    )}
                    {d.action === "ALLOCATE" && (
                      <>
                        {" "}
                        — invested <b>{d.amountCspr} CSPR</b>
                      </>
                    )}
                  </p>
                )}
              </article>
            );
          })}
        </section>

        {/* right — ledger + settlements */}
        <aside>
          <section className="panel reveal reveal-3">
            <h2>Work log — every step, in order</h2>
            <p className="sub">What each agent did and why, newest first. Nothing is hidden.</p>
            <div className="ledger">
              {ledger.length === 0 && (
                <div className="empty">Quiet for now. Run an analysis and the agents will post their work here live.</div>
              )}
              {[...ledger].reverse().map((e, i) => (
                <div className="entry" key={`${e.ts}-${i}`}>
                  <time>{e.ts.slice(11, 19)}</time>
                  <div>
                    <span className={`who ${e.agent}`}>{e.agent.replaceAll("-", " ")}</span>
                    <span className="msg">{humanize(e.message, names.current)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel reveal reveal-4">
            <h2>Payment receipts — x402</h2>
            <p className="sub">Every piece of evidence was paid for on-chain. These are the receipts.</p>
            {payments.length === 0 && <div className="empty">No payments yet.</div>}
            {payments
              .slice(-8)
              .reverse()
              .map((p, i) => (
                <div className="pay" key={i}>
                  <span className="amt">{fmtPayment(p)}</span>
                  <span className="res">{p.resource?.replace("/api/", "") ?? "—"}</span>
                  {p.settlement?.transaction ? (
                    <a
                      className="tx settled"
                      href={`https://testnet.cspr.live/deploy/${p.settlement.transaction}`}
                      target="_blank"
                      rel="noreferrer"
                      title="View this payment on the Casper explorer"
                    >
                      {p.settlement.transaction.slice(0, 10)}…
                    </a>
                  ) : (
                    <span className="tx">{p.settlement?.mode}</span>
                  )}
                </div>
              ))}
          </section>
        </aside>
      </main>

      {/* ----------------------------------------------------------- system */}
      {(health || metrics) && (
        <section className="panel reveal" style={{ marginTop: 22 }}>
          <h2>System</h2>
          <div className="health">
            <div className="h">
              <span className="dot up" /> agent · up {fmtDur(health?.uptimeSec ?? metrics?.uptimeSec)}
            </div>
            <div className="h">
              <span className={`dot ${health?.deps.services ? "up" : "down"}`} /> data services ·{" "}
              {health?.deps.services ? "reachable" : "unreachable"}
            </div>
            <div className="h">decisions posted · {metrics?.decisions ?? 0}</div>
            <div className="h">reasoner · {metrics?.reasoner ?? (state?.llm ? "llm" : "deterministic")}</div>
            {(health?.lastError ?? metrics?.lastError) && (
              <div className="h" style={{ color: "var(--coral)" }}>
                <span className="dot down" /> last error · {(health?.lastError ?? metrics?.lastError)?.message}
              </div>
            )}
          </div>
        </section>
      )}

      <footer className="foot">
        <span>
          Atlas Agent — Casper Agentic Buildathon 2026. Contracts in Odra; evidence paid over x402; every decision
          recorded on the Casper DecisionRegistry.
        </span>
        <span className="mono">
          {state?.network ?? "casper-test"} ·{" "}
          <button
            className="intro-link"
            onClick={() => typeof window !== "undefined" && window.dispatchEvent(new Event("atlas:intro"))}
          >
            replay intro
          </button>
        </span>
      </footer>
    </div>
  );
}
