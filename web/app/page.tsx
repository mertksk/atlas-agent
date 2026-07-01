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
const ROLES = [
  { key: "scout", label: "Scout" },
  { key: "analyst", label: "Analyst" },
  { key: "risk-officer", label: "Risk Officer" },
  { key: "treasurer", label: "Treasurer" },
  { key: "policy-guard", label: "Policy Guard" },
  { key: "executor", label: "Executor" },
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
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

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
  for (const e of ledger.slice(start)) {
    if (e.agent === "system") continue;
    counts[e.agent] = (counts[e.agent] ?? 0) + 1;
    last = e.agent;
  }
  return { counts, current: running ? last : null };
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

  // Local demo convenience: if NEXT_PUBLIC_AGENT_API_TOKEN is provided (local/dev
  // only — never bake it into a public deployment), the field auto-fills so you
  // don't have to paste it. Otherwise you enter it manually. Persisted in
  // localStorage so a manual entry sticks across sessions.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("atlas_token");
    setToken(stored ?? DEFAULT_TOKEN);
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
              <span className="chip">{state.reasoner ?? (state.llm ? "llm reasoning" : "deterministic")}</span>
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
          <button className={`run-btn ${state?.running ? "working" : ""}`} onClick={runAnalysis} disabled={!state || state.running}>
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
              <span className="l">allocated today</span>
            </div>
            <div>
              <span className="n">{cspr(dataSpend)}</span>
              <span className="l">evidence bought (last run)</span>
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
            <h2>The desk — six agents, one mandate</h2>
            <span className="live-cost">
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
                  <span className="count">{done ? `${pipe.counts[r.key]} notes` : ""}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------------- grid */}
      <main className="grid">
        {/* left rail */}
        <aside>
          <section className="panel reveal reveal-2">
            <h2>Policy — enforced on-chain</h2>
            {state ? (
              <>
                <div className="rail-row">
                  <span className="k">per allocation</span>
                  <span className="v">≤ {state.policy.maxAllocationPerOpCspr} CSPR</span>
                </div>
                <div className="rail-row">
                  <span className="k">daily spend</span>
                  <span className="v">≤ {state.policy.maxDailySpendCspr} CSPR</span>
                </div>
                <div className="rail-row">
                  <span className="k">risk ceiling</span>
                  <span className="v">{state.policy.maxRiskScore} / 100</span>
                </div>
                <div className="rail-row">
                  <span className="k">min confidence</span>
                  <span className="v">{Math.round(state.policy.minConfidence * 100)}%</span>
                </div>
                <div className="rail-row">
                  <span className="k">human sign-off over</span>
                  <span className="v">{state.policy.approvalThresholdCspr} CSPR</span>
                </div>
                <div className="meter" aria-hidden>
                  <i style={{ width: `${Math.min((dataSpend / budget) * 100, 100)}%` }} />
                </div>
                <div className="meter-cap">data budget {cspr(dataSpend)} / {cspr(budget)} CSPR spent</div>
              </>
            ) : (
              <div className="empty">connecting…</div>
            )}
          </section>

          <section className="panel reveal reveal-3">
            <h2>Contracts</h2>
            <div className="contract">
              <span className="cn">TreasuryVault</span>
              <span className={`cv ${state?.contracts.vault ? "" : "off"}`}>
                {state?.contracts.vault ? `${state.contracts.vault.slice(0, 22)}…` : "not deployed"}
              </span>
            </div>
            <div className="contract">
              <span className="cn">DecisionRegistry</span>
              <span className={`cv ${state?.contracts.registry ? "" : "off"}`}>
                {state?.contracts.registry ? `${state.contracts.registry.slice(0, 22)}…` : "not deployed"}
              </span>
            </div>
          </section>
        </aside>

        {/* center — opportunities */}
        <section>
          {state && state.pendingApprovals.length > 0 && (
            <div className="approvals">
              {state.pendingApprovals.map((a) => (
                <div className="approval" key={`${a.runId}-${a.opportunityId}`}>
                  <div className="what">
                    Allocate <b>{a.amountCspr} CSPR</b> to {a.opportunityName}? Risk {a.riskScore}, confidence{" "}
                    {Math.round(a.confidence * 100)}% — above the auto-execution threshold.
                  </div>
                  <button className="approve-btn" onClick={() => approve(a)}>
                    approve
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="opps-head">
            <h2>Opportunities</h2>
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
            return (
              <article className={`opp ${cls}`} key={o.id} style={{ animationDelay: `${Math.min(idx * 60, 360)}ms` }}>
                <div className="opp-head">
                  <div>
                    <span className="cat">{o.category}</span>
                    <h3>{o.name}</h3>
                  </div>
                  <div className="right">
                    <span className={`apy ${apy > 30 ? "absurd" : ""}`}>
                      advertised
                      <br />
                      <b>{apy.toFixed(1)}%</b> APY
                    </span>
                    {d && <span className={`action ${d.action}`}>{d.action.replaceAll("_", " ")}</span>}
                  </div>
                </div>

                <div className="riskbar">
                  <span>risk {risk ?? "—"}</span>
                  <span className="track" aria-hidden>
                    <i style={{ width: `${risk ?? 0}%`, background: riskColor }} />
                  </span>
                  <span>conf {d ? `${Math.round(d.confidence * 100)}%` : "—"}</span>
                </div>

                <p className="why">{d ? d.reason : o.blurb}</p>
                {d && (
                  <p className="bought">
                    {d.dataSources.length > 0 ? (
                      <>
                        <span className="x402">x402</span>
                        evidence: {d.dataSources.join(" + ")} · <b>{cspr(d.dataCostCspr)} CSPR</b>
                      </>
                    ) : (
                      "no data purchased for this opportunity"
                    )}
                    {d.action === "ALLOCATE" && (
                      <>
                        {" "}
                        — allocated <b>{d.amountCspr} CSPR</b>
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
            <h2>Decision ledger — every step, posted</h2>
            <div className="ledger">
              {ledger.length === 0 && (
                <div className="empty">No entries yet. Run an analysis to watch the desk post its work.</div>
              )}
              {[...ledger].reverse().map((e, i) => (
                <div className="entry" key={`${e.ts}-${i}`}>
                  <time>{e.ts.slice(11, 19)}</time>
                  <div>
                    <span className={`who ${e.agent}`}>{e.agent.replaceAll("-", " ")}</span>
                    <span className="msg">{e.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel reveal reveal-4">
            <h2>x402 settlements</h2>
            {payments.length === 0 && <div className="empty">No payments yet.</div>}
            {payments
              .slice(-8)
              .reverse()
              .map((p, i) => (
                <div className="pay" key={i}>
                  <span className="amt">{p.amount ? cspr(Number(BigInt(p.amount)) / 1e9) : "?"} CSPR</span>
                  <span className="res">{p.resource?.replace("/api/", "") ?? "—"}</span>
                  <span className={`tx ${p.settlement?.transaction ? "settled" : ""}`}>
                    {p.settlement?.transaction ? `${p.settlement.transaction.slice(0, 10)}…` : p.settlement?.mode}
                  </span>
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
