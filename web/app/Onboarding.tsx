"use client";

import { useCallback, useEffect, useState } from "react";

const SEEN_KEY = "atlas_onboarded_v1";

/* ------------------------------------------------------- little visuals */
function PipelineMini() {
  const colors = ["var(--steel)", "var(--copper)", "var(--violet)", "var(--jade)", "var(--coral)", "var(--gold)"];
  return (
    <div className="onb-pipe">
      {colors.map((c, i) => (
        <span key={i} className="onb-pipe-step" style={{ "--c": c, animationDelay: `${i * 110}ms` } as React.CSSProperties}>
          <span className="onb-pipe-dot">{i + 1}</span>
        </span>
      ))}
    </div>
  );
}
function X402Viz() {
  return (
    <div className="onb-x402">
      <span className="coin">x402</span>
      <svg width="48" height="24" viewBox="0 0 48 24" aria-hidden>
        <path d="M2 12 H40" stroke="var(--copper)" strokeWidth="1.5" strokeDasharray="3 3" />
        <path d="M34 6 L42 12 L34 18" fill="none" stroke="var(--copper)" strokeWidth="1.5" />
      </svg>
      <span className="doc">
        <i /> <i /> <i />
        <b>evidence</b>
      </span>
    </div>
  );
}
function ShieldViz() {
  return (
    <svg className="onb-shield" width="92" height="100" viewBox="0 0 92 100" aria-hidden>
      <path
        d="M46 4 L84 18 V48 C84 74 66 90 46 96 C26 90 8 74 8 48 V18 Z"
        fill="rgba(227,163,92,0.06)"
        stroke="var(--copper)"
        strokeWidth="1.5"
      />
      <path d="M31 50 L42 61 L63 38" fill="none" stroke="var(--jade)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function RunViz() {
  return (
    <div className="onb-run">
      <span className="onb-run-btn">run analysis</span>
      <svg width="150" height="40" viewBox="0 0 150 40" aria-hidden>
        <polyline
          points="0,30 25,26 50,28 75,14 100,18 125,6 150,10"
          fill="none"
          stroke="var(--jade)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/* ----------------------------------------------------------- the steps */
const STEPS = [
  {
    tag: "welcome",
    title: "Meet Atlas",
    body: "An autonomous treasury agent on Casper. It studies on-chain yield opportunities, decides what to fund, and records every move — live on testnet.",
    visual: (
      <div className="onb-hero">
        ATLA<em>S</em>
      </div>
    ),
  },
  {
    tag: "the desk",
    title: "Six agents, one mandate",
    body: "A full desk runs each cycle: Scout finds opportunities, Analyst and Risk Officer weigh them, Treasurer sizes the bet, Policy Guard checks the rules, Executor commits it on-chain.",
    visual: <PipelineMini />,
  },
  {
    tag: "x402",
    title: "Evidence before money",
    body: "Atlas refuses to move on a hunch. It pays for risk data over the x402 protocol — real CEP-18 settlements — before it allocates a single CSPR.",
    visual: <X402Viz />,
  },
  {
    tag: "guardrails",
    title: "Policy enforced on-chain",
    body: "Per-allocation caps, a daily ceiling, a recipient allowlist and human sign-off for big moves are enforced by the contract itself — then logged to the DecisionRegistry.",
    visual: <ShieldViz />,
  },
  {
    tag: "your turn",
    title: "Watch it work",
    body: "Hit Run analysis (add your API token first for live runs) and watch the desk light up: agents post their reasoning to the ledger as the money decisions happen.",
    visual: <RunViz />,
  },
] as const;

/* ----------------------------------------------------------- component */
export default function Onboarding() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.localStorage.getItem(SEEN_KEY)) setOpen(true);
    // let other parts of the UI re-open the tour
    const reopen = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener("atlas:intro", reopen);
    return () => window.removeEventListener("atlas:intro", reopen);
  }, []);

  const finish = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(SEEN_KEY, "1");
    setOpen(false);
  }, []);
  const next = useCallback(() => (last ? finish() : setStep((s) => s + 1)), [last, finish]);
  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, back, finish]);

  if (!open) return null;
  const s = STEPS[step];

  return (
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-labelledby="onb-title" onMouseDown={(e) => e.target === e.currentTarget && finish()}>
      <div className="onb-card">
        <div className="onb-top">
          <span className="onb-tag">
            {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")} · {s.tag}
          </span>
          <button className="onb-skip" onClick={finish}>
            skip ✕
          </button>
        </div>

        <div className="onb-visual" key={`v${step}`}>
          {s.visual}
        </div>

        <div className="onb-body" key={`b${step}`}>
          <h2 id="onb-title">{s.title}</h2>
          <p>{s.body}</p>
        </div>

        <div className="onb-dots" aria-hidden>
          {STEPS.map((_, i) => (
            <button key={i} className={`onb-dot ${i === step ? "on" : ""} ${i < step ? "past" : ""}`} onClick={() => setStep(i)} />
          ))}
        </div>

        <div className="onb-foot">
          <button className="onb-ghost" onClick={back} disabled={step === 0}>
            back
          </button>
          <button className="onb-next" onClick={next} autoFocus>
            {last ? "enter the desk →" : "next →"}
          </button>
        </div>
      </div>
    </div>
  );
}
