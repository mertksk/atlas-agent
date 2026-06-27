"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const AGENT = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4030";

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

const cspr = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/* -------------------------------------------------------------- page */
export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [opps, setOpps] = useState<Opp[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [offline, setOffline] = useState(false);
  const [token, setToken] = useState("");
  const cursor = useRef(0);

  useEffect(() => {
    if (typeof window !== "undefined") setToken(window.sessionStorage.getItem("atlas_token") ?? "");
  }, []);
  const saveToken = (v: string) => {
    setToken(v);
    if (typeof window !== "undefined") window.sessionStorage.setItem("atlas_token", v);
  };
  // Bearer header for state-changing calls (when the agent requires AGENT_API_TOKEN).
  const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

  const poll = useCallback(async () => {
    try {
      const [s, o, d, e, p] = await Promise.all([
        fetch(`${AGENT}/api/state`).then((r) => r.json()),
        fetch(`${AGENT}/api/opportunities`).then((r) => r.json()),
        fetch(`${AGENT}/api/decisions`).then((r) => r.json()),
        fetch(`${AGENT}/api/events?since=${cursor.current}`).then((r) => r.json()),
        fetch(`${AGENT}/api/payments`).then((r) => r.json()),
      ]);
      setState(s);
      setOpps(o);
      setDecisions(d);
      if (e.events.length) setLedger((prev) => [...prev, ...e.events]);
      cursor.current = e.cursor;
      setPayments(p);
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
    await fetch(`${AGENT}/api/approve/${a.runId}/${a.opportunityId}`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => undefined);
    poll();
  };

  // Latest decision per opportunity.
  const latest = new Map<string, Decision>();
  for (const d of decisions) latest.set(d.opportunityId, d);

  const dataSpend = state?.lastRunDataCostCspr ?? 0;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="wordmark">
          <h1>
            ATLA<em>S</em>
          </h1>
          <span className="tag">autonomous treasury · spends on data before it spends on yield</span>
        </div>
        <div className="mast-right">
          {offline && <span className="chip" style={{ borderColor: "var(--rust)", color: "var(--rust)" }}>agent offline — npm run agent</span>}
          {state && (
            <>
              <span className={`chip ${state.mode === "live" ? "live" : "dry"}`}>
                {state.mode === "live" ? "casper testnet · live" : "dry-run"}
              </span>
              <span className="chip">{state.reasoner ? `${state.reasoner} reasoning` : state.llm ? "llm reasoning" : "deterministic reasoning"}</span>
            </>
          )}
          <input
            className="chip"
            type="password"
            placeholder="API token"
            value={token}
            onChange={(e) => saveToken(e.target.value)}
            title="Bearer token for run/approve (set AGENT_API_TOKEN on the agent)"
            style={{ background: "transparent", width: 96, outline: "none" }}
          />
          <button className="run-btn" onClick={runAnalysis} disabled={!state || state.running}>
            {state?.running ? "Agents working…" : "Run analysis"}
          </button>
        </div>
      </header>

      <main className="grid">
        {/* ------------------------------------------------ treasury rail */}
        <aside>
          <section className="panel">
            <h2>Treasury</h2>
            <div className="figure">
              {state ? cspr(state.treasuryBalanceCspr) : "—"}
              <small>CSPR</small>
            </div>
            <div className="rail-row">
              <span className="k">allocated today</span>
              <span className="v">{state ? cspr(state.spentTodayCspr) : "—"} CSPR</span>
            </div>
            <div className="rail-row">
              <span className="k">data spend (last run)</span>
              <span className="v">{cspr(dataSpend)} CSPR</span>
            </div>
            <div className="rail-row">
              <span className="k">runs</span>
              <span className="v">{state?.runs ?? 0}</span>
            </div>
          </section>

          <section className="panel">
            <h2>Policy — enforced on-chain</h2>
            {state && (
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
                  <span className="k">human approval over</span>
                  <span className="v">{state.policy.approvalThresholdCspr} CSPR</span>
                </div>
                <div className="rail-row">
                  <span className="k">data budget / run</span>
                  <span className="v">{state.policy.dataBudgetCspr} CSPR</span>
                </div>
                <div className="depleted" aria-hidden>
                  <i
                    style={{
                      width: `${Math.min((dataSpend / state.policy.dataBudgetCspr) * 100, 100)}%`,
                    }}
                  />
                </div>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Contracts</h2>
            <div className="rail-row">
              <span className="k">TreasuryVault</span>
              <span className="v">{state?.contracts.vault ? `${state.contracts.vault.slice(0, 10)}…` : "not deployed"}</span>
            </div>
            <div className="rail-row">
              <span className="k">DecisionRegistry</span>
              <span className="v">{state?.contracts.registry ? `${state.contracts.registry.slice(0, 10)}…` : "not deployed"}</span>
            </div>
          </section>
        </aside>

        {/* ------------------------------------------------- opportunities */}
        <section>
          {state && state.pendingApprovals.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              {state.pendingApprovals.map((a) => (
                <div className="approval" key={`${a.runId}-${a.opportunityId}`}>
                  <div className="what">
                    Allocate <b>{a.amountCspr} CSPR</b> to {a.opportunityName}? Risk {a.riskScore},
                    confidence {Math.round(a.confidence * 100)}% — above the auto-execution
                    threshold.
                  </div>
                  <button className="approve-btn" onClick={() => approve(a)}>
                    Approve
                  </button>
                </div>
              ))}
            </div>
          )}

          {opps.length === 0 && <div className="panel empty">Marketplace unreachable — start the data services (npm run services).</div>}

          {opps.map((o) => {
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
              risk === null ? "var(--faint)" : risk > 60 ? "var(--rust)" : risk > 35 ? "var(--brass)" : "var(--mint)";
            return (
              <article className={`opp ${cls}`} key={o.id}>
                <div className="opp-head">
                  <div>
                    <span className="cat">{o.category}</span>
                    <h3>{o.name}</h3>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className={`apy ${apy > 30 ? "absurd" : ""}`}>
                      advertised <b>{apy.toFixed(1)}%</b> APY
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
                        evidence bought via x402: {d.dataSources.join(" + ")} · <b>{cspr(d.dataCostCspr)} CSPR</b>
                      </>
                    ) : (
                      "no data purchased for this opportunity"
                    )}
                    {d.action === "ALLOCATE" && <> — allocated <b>{d.amountCspr} CSPR</b></>}
                  </p>
                )}
              </article>
            );
          })}
        </section>

        {/* ------------------------------------------------------- ledger */}
        <aside>
          <section className="panel">
            <h2>Decision ledger — every step, posted</h2>
            <div className="ledger">
              {ledger.length === 0 && <div className="empty">No entries yet. Run an analysis to watch the agents post their work.</div>}
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

          <section className="panel">
            <h2>x402 settlements</h2>
            {payments.length === 0 && <div className="empty">No payments yet.</div>}
            {payments
              .slice(-8)
              .reverse()
              .map((p, i) => (
                <div className="pay" key={i}>
                  <span className="amt">{p.amount ? cspr(Number(BigInt(p.amount)) / 1e9) : "?"} CSPR</span>
                  <span>{p.resource?.replace("/api/", "")}</span>
                  <span className="tx">{p.settlement?.transaction ?? p.settlement?.mode}</span>
                </div>
              ))}
          </section>
        </aside>
      </main>

      <footer className="foot">
        <span>Atlas Agent — Casper Agentic Buildathon 2026. Contracts in Odra; data paid for over x402; decisions recorded on the Casper DecisionRegistry.</span>
        <span>{state?.network ?? "casper-test"}</span>
      </footer>
    </div>
  );
}
