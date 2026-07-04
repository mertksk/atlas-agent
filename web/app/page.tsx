"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Onboarding from "./Onboarding";
import { downloadReport, downloadLogs } from "./report";
import { useI18n, LANGS, type Lang, type StrKey } from "./i18n";
import {
  connectWallet,
  currentKey,
  disconnectWallet,
  walletBalanceCspr,
  subscribeWallet,
  signDeploy,
  shortKey,
  walletInstalled,
} from "./wallet";

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
// Role metadata references i18n keys: l = label, d = job description (always
// visible), g = present-tense "doing" line for the live status strip.
const ROLES: ReadonlyArray<{ key: string; l: StrKey; d: StrKey; g: StrKey }> = [
  { key: "scout", l: "rScout", d: "rScoutD", g: "rScoutG" },
  { key: "analyst", l: "rAnalyst", d: "rAnalystD", g: "rAnalystG" },
  { key: "risk-officer", l: "rRiskO", d: "rRiskOD", g: "rRiskOG" },
  { key: "treasurer", l: "rTreas", d: "rTreasD", g: "rTreasG" },
  { key: "policy-guard", l: "rPolicy", d: "rPolicyD", g: "rPolicyG" },
  { key: "executor", l: "rExec", d: "rExecD", g: "rExecG" },
];
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

/** Render a translated template, bolding the {amount}/{name} slots (order-safe across languages). */
function tRich(template: string, parts: { amount: ReactNode; name: ReactNode }): ReactNode[] {
  return template.split(/(\{amount\}|\{name\})/g).map((tok, i) =>
    tok === "{amount}" ? <b key={i}>{parts.amount}</b> : tok === "{name}" ? <b key={i}>{parts.name}</b> : tok,
  );
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
  const { t, lang, setLang } = useI18n();
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
  // --- wallet (non-custodial) ---
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [feeStage, setFeeStage] = useState<"" | "paying" | "submitting">("");
  const [notice, setNotice] = useState<string | null>(null);
  const [feeCspr, setFeeCspr] = useState(1);
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

  // ---- wallet: restore an existing connection, subscribe to key/disconnect
  // events, and learn the server's fee terms. Non-custodial: we only read the
  // public key + balance; the wallet holds the key and signs every move.
  useEffect(() => {
    currentKey().then((k) => k && setWallet(k)).catch(() => undefined);
    fetch(`${AGENT}/api/wallet/fee`)
      .then((r) => r.json())
      .then((f) => typeof f?.feeCspr === "number" && setFeeCspr(f.feeCspr))
      .catch(() => undefined);
    return subscribeWallet({
      onKey: (k) => {
        setWallet(k);
        setNotice(null);
      },
      onDisconnect: () => {
        setWallet(null);
        setWalletBal(null);
      },
    });
  }, []);

  // ---- wallet balance: this is the treasury under management (criterion 6).
  useEffect(() => {
    if (!wallet) {
      setWalletBal(null);
      return;
    }
    let alive = true;
    const load = () => walletBalanceCspr(wallet).then((b) => alive && setWalletBal(b)).catch(() => undefined);
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [wallet]);

  const onConnect = async () => {
    setNotice(null);
    setWalletBusy(true);
    try {
      if (!walletInstalled()) {
        setNotice(t("walletInstall"));
        return;
      }
      setWallet(await connectWallet());
    } catch (e) {
      setNotice((e as Error).message === "rejected" ? t("walletRejected") : t("walletInstall"));
    } finally {
      setWalletBusy(false);
    }
  };

  const onDisconnect = async () => {
    await disconnectWallet().catch(() => undefined);
    setWallet(null);
    setWalletBal(null);
  };

  /** Charge the usage fee from the connected wallet (user signs). Returns true on success. */
  const payFee = async (): Promise<boolean> => {
    if (!wallet) return false;
    setNotice(null);
    try {
      setFeeStage("paying");
      const build = await fetch(`${AGENT}/api/wallet/fee/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: wallet }),
      }).then((r) => r.json());
      if (!build?.deploy) throw new Error(build?.error || "could not build fee deploy");
      const signatureHex = await signDeploy(JSON.stringify(build.deploy), wallet);
      setFeeStage("submitting");
      const sub = await fetch(`${AGENT}/api/wallet/fee/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploy: build.deploy, publicKey: wallet, signatureHex }),
      }).then((r) => r.json());
      if (!sub?.ok) throw new Error(sub?.error || "fee submission failed");
      setNotice(t("feePaid"));
      return true;
    } catch (e) {
      const m = (e as Error).message;
      setNotice(m === "cancelled" ? t("feeCancelled") : `${t("feeFailed")}: ${m}`);
      return false;
    } finally {
      setFeeStage("");
    }
  };

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
    // Monetized path: with a wallet connected, charge the usage fee first (the
    // user signs it), then start the run. Without a wallet (local demo) the run
    // starts directly.
    if (wallet) {
      const paid = await payFee();
      if (!paid) return;
    }
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
  // Treasury under management = the connected wallet's own CSPR (non-custodial,
  // criterion 6). Falls back to the agent vault mirror when no wallet is linked.
  const walletLinked = wallet != null;
  const treasuryTarget = walletLinked && walletBal != null ? walletBal : state?.treasuryBalanceCspr ?? 0;
  const treasury = useCountUp(treasuryTarget);
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
          <span className="tag">{t("tagline")}</span>
        </div>
        <div className="mast-right">
          <select
            className="lang-select"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            title="Language / Dil"
            aria-label="Language"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.native}
              </option>
            ))}
          </select>
          {offline && (
            <span className="chip alert pulse">
              <i className="dot" /> {t("offline")}
            </span>
          )}
          {state && (
            <>
              <span className={`chip ${state.mode === "live" ? "live" : "dry"} pulse`}>
                <i className="dot" /> {state.mode === "live" ? t("live") : t("dry")}
              </span>
              <span className="chip" title={t("reasonerW")}>
                {state.reasoner ?? (state.llm ? t("llm") : t("det"))}
              </span>
            </>
          )}
          <button
            className="report-btn"
            onClick={() => downloadReport({ state, opps, decisions, payments, ledger }).catch(() => undefined)}
            disabled={!state}
            title={t("reportT")}
          >
            ⤓ {t("report")}
          </button>
          {wallet ? (
            <span className="chip wallet" title={t("nonCustodialNote")}>
              <i className="dot" /> 🔑 {shortKey(wallet)}
              {walletBal != null && <b className="wbal">· {cspr(walletBal)} CSPR</b>}
              <button className="chip-link" onClick={onDisconnect} title={t("walletDisconnect")}>
                {t("walletDisconnect")}
              </button>
            </span>
          ) : (
            <button className="wallet-btn" onClick={onConnect} disabled={walletBusy} title={t("walletT")}>
              {walletBusy ? t("walletConnecting") : `🔗 ${t("walletConnect")}`}
            </button>
          )}
          {/* API token is only needed for the local/demo (no-wallet) path. */}
          {!wallet &&
            (token && !editingToken ? (
              <span className="chip authed" title={t("authedT")}>
                <i className="dot" /> {t("authed")}
                <button className="chip-link" onClick={() => setEditingToken(true)} title={t("apiToken")}>
                  {t("change")}
                </button>
              </span>
            ) : (
              <input
                className="token-input"
                type="password"
                placeholder={t("apiToken")}
                value={token}
                autoFocus={editingToken}
                onChange={(e) => saveToken(e.target.value)}
                onBlur={() => setEditingToken(false)}
                title={t("tokenT")}
              />
            ))}
          <button
            className={`run-btn ${state?.running || feeStage ? "working" : ""}`}
            onClick={runAnalysis}
            disabled={!state || state.running || feeStage !== "" || walletBusy}
            title={t("runT")}
          >
            {feeStage === "paying"
              ? t("feePaying")
              : feeStage === "submitting"
                ? t("feeSubmitting")
                : state?.running
                  ? t("running")
                  : wallet
                    ? t("feePayRun", { amount: feeCspr })
                    : t("run")}
          </button>
        </div>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="notice-x" onClick={() => setNotice(null)} aria-label="dismiss">
            ✕
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------- hero */}
      <div className="hero">
        <section className="vault reveal reveal-1">
          <span className="label">{walletLinked ? t("treasuryWallet") : t("treasury")}</span>
          <div className="figure">
            {walletLinked ? (walletBal != null ? cspr(treasury) : "…") : state ? cspr(treasury) : "—"}
            <span className="unit">CSPR</span>
          </div>
          {walletLinked && <p className="custody-note">{t("nonCustodialNote")}</p>}
          <div className="substats">
            <div>
              <span className="n">{state ? cspr(state.spentTodayCspr) : "—"}</span>
              <span className="l">{t("investedToday")}</span>
            </div>
            <div>
              <span className="n">{cspr(dataSpend)}</span>
              <span className="l">{t("evidenceSpent")}</span>
            </div>
            <div>
              <span className="n">{metrics?.decisions ?? "—"}</span>
              <span className="l">{t("decisionsOnChain")}</span>
            </div>
            <div>
              <span className="n">{state?.runs ?? 0}</span>
              <span className="l">{t("runs")}</span>
            </div>
          </div>
        </section>

        <section className="pipeline reveal reveal-2">
          <div className="phead">
            <h2>{t("deskTitle")}</h2>
            <span className="live-cost" title={t("evBudgetT")}>
              {t("evBudget")}&nbsp; <b>{cspr(dataSpend)}</b> / {cspr(budget)} CSPR
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
                  <span className="role">{t(r.l)}</span>
                  <span className="desc">{t(r.d)}</span>
                  <span className="count">{active ? t("working") : done ? `✓ ${pipe.counts[r.key]}` : ""}</span>
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
                    <b>{activeRole ? t("nowFmt", { role: t(activeRole.l), doing: t(activeRole.g) }) : t("starting")}</b>
                    <span className="ds-meta">
                      {activeStep > 0 ? ` · ${t("stepW")} ${activeStep}/6` : ""} ·{" "}
                      {fmtDur(runStartedAt.current ? (Date.now() - runStartedAt.current) / 1000 : undefined)}{" "}
                      {t("elapsed")}
                    </span>
                  </div>
                  {pipe.lastEntry && <div className="ds-detail">{humanize(pipe.lastEntry.message, names.current)}</div>}
                </div>
              </>
            ) : lastRunSummary ? (
              <div>
                <div className="ds-line">
                  <b>{t("lastRun")}</b>
                  <span className="ds-meta"> {humanize(lastRunSummary.message.replace(/^Run complete: /i, ""), names.current)}</span>
                </div>
                <div className="ds-detail">
                  {t("pressNext")} {pendingCount > 0 ? t("waiting", { n: pendingCount }) : ""}
                </div>
              </div>
            ) : (
              <div>
                <div className="ds-line">
                  <b>{t("ready")}</b>
                </div>
                <div className="ds-detail">{t("readyD")}</div>
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
            <h2>{t("rulesTitle")}</h2>
            <p className="sub">{t("rulesSub")}</p>
            {state ? (
              <>
                <div className="rail-row" title={t("ruleMaxPerT")}>
                  <span className="k">{t("ruleMaxPer")}</span>
                  <span className="v">≤ {state.policy.maxAllocationPerOpCspr} CSPR</span>
                </div>
                <div className="rail-row" title={t("ruleMaxDayT")}>
                  <span className="k">{t("ruleMaxDay")}</span>
                  <span className="v">≤ {state.policy.maxDailySpendCspr} CSPR</span>
                </div>
                <div className="rail-row" title={t("ruleRiskT")}>
                  <span className="k">{t("ruleRisk")}</span>
                  <span className="v">{state.policy.maxRiskScore} / 100</span>
                </div>
                <div className="rail-row" title={t("ruleConfT")}>
                  <span className="k">{t("ruleConf")}</span>
                  <span className="v">{Math.round(state.policy.minConfidence * 100)}%</span>
                </div>
                <div className="rail-row" title={t("ruleSignT")}>
                  <span className="k">{t("ruleSign")}</span>
                  <span className="v">{state.policy.approvalThresholdCspr} CSPR</span>
                </div>
                <div className="meter" aria-hidden>
                  <i style={{ width: `${Math.min((dataSpend / budget) * 100, 100)}%` }} />
                </div>
                <div className="meter-cap">{t("budgetUsed", { used: cspr(dataSpend), total: cspr(budget) })}</div>
              </>
            ) : (
              <div className="empty">{t("connecting")}</div>
            )}
          </section>

          <details className="panel contracts-details reveal reveal-3">
            <summary>
              {t("contracts")} <span className="sum-hint">{t("contractsHint")}</span>
            </summary>
            <div className="contract">
              <span className="cn">{t("vaultLabel")}</span>
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
                <span className="cv off">{t("notDeployed")}</span>
              )}
            </div>
            <div className="contract">
              <span className="cn">{t("registryLabel")}</span>
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
                <span className="cv off">{t("notDeployed")}</span>
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
                  {t("needsSignOff")} <span className="badge">{pendingCount}</span>
                </h2>
                <p className="sub">{t("signOffSub", { n: state.policy.approvalThresholdCspr })}</p>
              </div>
              {state.pendingApprovals.map((a) => (
                <div className="approval" key={`${a.runId}-${a.opportunityId}`}>
                  <div className="what">
                    {tRich(t("investQ"), { amount: a.amountCspr, name: a.opportunityName })}
                    <span className="ap-meta">
                      {t("riskW")} {a.riskScore}/100 · {t("confW")} {Math.round(a.confidence * 100)}%
                    </span>
                  </div>
                  <button className="approve-btn" onClick={() => approve(a)}>
                    {t("approve")}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="opps-head">
            <div>
              <h2>{t("opps")}</h2>
              <p className="sub">{t("oppsSub")}</p>
            </div>
            <span className="count">{t("onDesk", { n: opps.length })}</span>
          </div>

          {opps.length === 0 && <div className="panel empty">{t("marketDown")}</div>}

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
                ? t("actInvested")
                : d?.action === "REJECT"
                  ? t("actRejected")
                  : d?.action === "QUEUE_FOR_APPROVAL"
                    ? t("actAwaiting")
                    : d?.action === "HOLD"
                      ? t("actHold")
                      : null;
            return (
              <article className={`opp ${cls}`} key={o.id} style={{ animationDelay: `${Math.min(idx * 60, 360)}ms` }}>
                <div className="opp-head">
                  <div>
                    <span className="cat">{o.category}</span>
                    <h3>{o.name}</h3>
                  </div>
                  <div className="right">
                    <span className={`apy ${apy > 30 ? "absurd" : ""}`} title={t("advertisedT")}>
                      {t("advertised")}
                      <br />
                      <b>{apy.toFixed(1)}%</b> APY
                    </span>
                    {d && actionLabel && <span className={`action ${d.action}`}>{actionLabel}</span>}
                  </div>
                </div>

                <div className="riskbar">
                  <span>
                    {t("riskW")} {risk ?? "—"}
                  </span>
                  <span className="track" aria-hidden>
                    <i style={{ width: `${risk ?? 0}%`, background: riskColor }} />
                  </span>
                  <span>
                    {t("confW")} {d ? `${Math.round(d.confidence * 100)}%` : "—"}
                  </span>
                </div>

                <p className="why">
                  {d ? (
                    <>
                      <span className="why-tag">{t("reasoningTag")}</span> {d.reason}
                    </>
                  ) : (
                    o.blurb
                  )}
                </p>
                {d && (
                  <p className="bought">
                    {d.dataSources.length > 0 ? (
                      <>
                        <span className="x402" title={t("x402T")}>
                          x402
                        </span>
                        {t("evBought")} {d.dataSources.join(" + ")} · <b>{cspr(d.dataCostCspr)} CSPR</b>
                      </>
                    ) : (
                      t("noEv")
                    )}
                    {d.action === "ALLOCATE" && (
                      <>
                        {" "}
                        — {t("investedAmt")} <b>{d.amountCspr} CSPR</b>
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
            <div className="worklog-head">
              <h2>{t("workLog")}</h2>
              <button
                className="log-dl"
                onClick={() => downloadLogs({ state, opps, decisions, payments, ledger })}
                disabled={ledger.length === 0 && decisions.length === 0}
                title={t("downloadLogT")}
              >
                ⤓ {t("downloadLog")}
              </button>
            </div>
            <p className="sub">
              {t("workLogSub")}
              {lang !== "en" ? ` ${t("logNote")}` : ""}
            </p>
            <div className="ledger">
              {ledger.length === 0 && <div className="empty">{t("workLogEmpty")}</div>}
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
            <h2>{t("receipts")}</h2>
            <p className="sub">{t("receiptsSub")}</p>
            {payments.length === 0 && <div className="empty">{t("noPayments")}</div>}
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
                      title={t("viewExplorer")}
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
          <h2>{t("system")}</h2>
          <div className="health">
            <div className="h">
              <span className="dot up" /> {t("agentUp", { t: fmtDur(health?.uptimeSec ?? metrics?.uptimeSec) })}
            </div>
            <div className="h">
              <span className={`dot ${health?.deps.services ? "up" : "down"}`} /> {t("dataServices")} ·{" "}
              {health?.deps.services ? t("reachable") : t("unreachable")}
            </div>
            <div className="h">
              {t("decisionsPosted")} · {metrics?.decisions ?? 0}
            </div>
            <div className="h">
              {t("reasonerW")} · {metrics?.reasoner ?? (state?.llm ? t("llm") : t("det"))}
            </div>
            {(health?.lastError ?? metrics?.lastError) && (
              <div className="h" style={{ color: "var(--coral)" }}>
                <span className="dot down" /> {t("lastErrorW")} · {(health?.lastError ?? metrics?.lastError)?.message}
              </div>
            )}
          </div>
        </section>
      )}

      <footer className="foot">
        <span>{t("footerLine")}</span>
        <span className="mono">
          {state?.network ?? "casper-test"} ·{" "}
          <button
            className="intro-link"
            onClick={() => typeof window !== "undefined" && window.dispatchEvent(new Event("atlas:intro"))}
          >
            {t("replayIntro")}
          </button>
        </span>
      </footer>
    </div>
  );
}
