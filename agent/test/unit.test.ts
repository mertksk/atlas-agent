import { test } from "node:test";
import assert from "node:assert/strict";
import { guard } from "../src/policyGuard.js";
import { decideDeterministic, reasonerLabel } from "../src/reasoning.js";
import { csprToMotes, motesToCspr } from "../src/types.js";
import type { AgentDecision, PolicyConfig, RiskReport } from "../src/types.js";

const POLICY: PolicyConfig = {
  maxAllocationPerOpCspr: 30,
  maxDailySpendCspr: 50,
  minConfidence: 0.7,
  maxRiskScore: 60,
  approvalThresholdCspr: 25,
  dataBudgetCspr: 4,
};

function decision(over: Partial<AgentDecision> = {}): AgentDecision {
  return {
    decision: "ALLOCATE",
    opportunityId: "op",
    confidence: 0.9,
    riskScore: 20,
    recommendedAmountCspr: 10,
    dataPurchased: ["risk-score", "liquidity"],
    reason: "test",
    ...over,
  };
}
const ctx = (over: Partial<{ spentTodayCspr: number; treasuryBalanceCspr: number; blacklist?: string[] }> = {}) => ({
  spentTodayCspr: 0,
  treasuryBalanceCspr: 100,
  ...over,
});

// ---------------------------------------------------------------- policy guard
test("guard: REJECT/HOLD pass through with zero amount", () => {
  assert.equal(guard(decision({ decision: "REJECT" }), POLICY, ctx()).finalAction, "REJECT");
  const h = guard(decision({ decision: "HOLD" }), POLICY, ctx());
  assert.equal(h.finalAction, "HOLD");
  assert.equal(h.clampedAmountCspr, 0);
});

test("guard: blacklisted opportunity is rejected", () => {
  const v = guard(decision({ opportunityId: "bad" }), POLICY, ctx({ blacklist: ["bad"] }));
  assert.equal(v.finalAction, "REJECT");
  assert.equal(v.allowed, false);
});

test("guard: risk above ceiling -> REJECT", () => {
  assert.equal(guard(decision({ riskScore: 61 }), POLICY, ctx()).finalAction, "REJECT");
});

test("guard: confidence below floor -> HOLD", () => {
  assert.equal(guard(decision({ confidence: 0.69 }), POLICY, ctx()).finalAction, "HOLD");
});

test("guard: in-policy allocation passes unclamped", () => {
  const v = guard(decision({ recommendedAmountCspr: 20 }), POLICY, ctx());
  assert.equal(v.finalAction, "ALLOCATE");
  assert.equal(v.clampedAmountCspr, 20);
  assert.equal(v.violations.length, 0);
});

test("guard: per-op overrun clamps to cap, then escalates at threshold", () => {
  const v = guard(decision({ recommendedAmountCspr: 40 }), POLICY, ctx());
  // 40 -> clamp 30 (cap); 30 >= 25 threshold -> human approval
  assert.equal(v.finalAction, "QUEUE_FOR_APPROVAL");
  assert.equal(v.clampedAmountCspr, 30);
  assert.ok(v.violations.some((x) => /per-opportunity cap/.test(x)));
});

test("guard: clamps to remaining daily cap", () => {
  const v = guard(decision({ recommendedAmountCspr: 20 }), POLICY, ctx({ spentTodayCspr: 45 }));
  assert.equal(v.clampedAmountCspr, 5); // 50-45 remaining
  assert.equal(v.finalAction, "ALLOCATE");
});

test("guard: daily cap exhausted -> HOLD", () => {
  const v = guard(decision({ recommendedAmountCspr: 10 }), POLICY, ctx({ spentTodayCspr: 50 }));
  assert.equal(v.finalAction, "HOLD");
  assert.equal(v.clampedAmountCspr, 0);
});

test("guard: clamps to treasury balance", () => {
  const v = guard(decision({ recommendedAmountCspr: 20 }), POLICY, ctx({ treasuryBalanceCspr: 7 }));
  assert.equal(v.clampedAmountCspr, 7);
});

test("guard: amount at/above approval threshold -> QUEUE_FOR_APPROVAL", () => {
  const v = guard(decision({ recommendedAmountCspr: 25 }), POLICY, ctx());
  assert.equal(v.finalAction, "QUEUE_FOR_APPROVAL");
  assert.equal(v.clampedAmountCspr, 25);
});

// ------------------------------------------------------------ deterministic scorer
function report(over: Partial<RiskReport> = {}): RiskReport {
  return {
    opportunityId: "op",
    riskScore: 22,
    expectedApyBps: 480,
    liquidityRating: "deep",
    withdrawalDelayDays: 7,
    legalRisk: "low",
    missingDisclosures: [],
    purchased: [
      { source: "risk-score", costMotes: "500000000", payload: {} },
      { source: "liquidity", costMotes: "300000000", payload: {} },
      { source: "rwa-doc", costMotes: "800000000", payload: {} },
    ],
    dataCostMotes: "1600000000",
    notes: [],
    ...over,
  };
}

test("scorer: rejects when risk exceeds the policy ceiling", () => {
  const d = decideDeterministic(report({ riskScore: 91 }), POLICY, 100);
  assert.equal(d.decision, "REJECT");
  assert.ok(d.confidence >= 0.85);
});

test("scorer: allocates a sound, well-corroborated opportunity", () => {
  const d = decideDeterministic(report(), POLICY, 100);
  assert.equal(d.decision, "ALLOCATE");
  assert.ok(d.recommendedAmountCspr > 0 && d.recommendedAmountCspr <= POLICY.maxAllocationPerOpCspr);
});

test("scorer: holds when only a single paid source corroborates", () => {
  const d = decideDeterministic(report({ purchased: [{ source: "risk-score", costMotes: "500000000", payload: {} }] }), POLICY, 100);
  assert.equal(d.decision, "HOLD");
});

test("reasonerLabel falls back to deterministic with no LLM keys", () => {
  // No OPENROUTER_API_KEY / ANTHROPIC_API_KEY in the test env.
  assert.equal(reasonerLabel(), "deterministic");
});

// ------------------------------------------------------------------- conversions
test("csprToMotes / motesToCspr round-trip", () => {
  assert.equal(csprToMotes(0.5), "500000000");
  assert.equal(csprToMotes(21), "21000000000");
  assert.equal(motesToCspr("500000000"), 0.5);
  assert.equal(motesToCspr(csprToMotes(13.5)), 13.5);
});
