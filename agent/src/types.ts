// Shared types across the Atlas agent pipeline.

export interface Opportunity {
  id: string;
  name: string;
  category: "RWA" | "DeFi";
  advertisedApyBps: number;
  minAllocationCspr: number;
  strategyAddress: string;
  blurb: string;
}

export interface PurchasedData {
  source: "risk-score" | "liquidity" | "rwa-doc" | "market-signal";
  costMotes: string;
  settlementTx?: string;
  settlementMode?: "facilitator" | "mock";
  payload: unknown;
}

export interface RiskReport {
  opportunityId: string;
  riskScore: number; // 0..100 composite
  expectedApyBps: number;
  liquidityRating?: "deep" | "adequate" | "thin";
  withdrawalDelayDays?: number;
  legalRisk?: "low" | "medium" | "high";
  missingDisclosures: string[];
  purchased: PurchasedData[];
  dataCostMotes: string;
  notes: string[];
}

export type AgentAction = "ALLOCATE" | "REJECT" | "HOLD" | "QUEUE_FOR_APPROVAL";

export interface AgentDecision {
  decision: AgentAction;
  opportunityId: string;
  confidence: number; // 0..1
  riskScore: number; // 0..100
  recommendedAmountCspr: number;
  dataPurchased: string[];
  reason: string;
}

export interface PolicyConfig {
  maxAllocationPerOpCspr: number;
  maxDailySpendCspr: number;
  minConfidence: number; // 0..1
  maxRiskScore: number; // 0..100
  approvalThresholdCspr: number;
  dataBudgetCspr: number; // off-chain: max spend on x402 data per run
}

export interface GuardVerdict {
  allowed: boolean;
  finalAction: AgentAction;
  violations: string[];
  clampedAmountCspr: number;
}

export interface LedgerEntry {
  ts: string;
  agent: "scout" | "analyst" | "risk-officer" | "treasurer" | "policy-guard" | "executor" | "system";
  message: string;
  data?: unknown;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  decisions: Array<{
    decision: AgentDecision;
    verdict: GuardVerdict;
    report: RiskReport;
    onChain?: { decisionId?: number; recorded: boolean; executed: boolean; dryRun: boolean; error?: string };
  }>;
  totalDataCostMotes: string;
  ledger: LedgerEntry[];
}

export const MOTES_PER_CSPR = 1_000_000_000n;
export const csprToMotes = (cspr: number): string =>
  ((BigInt(Math.round(cspr * 1000)) * MOTES_PER_CSPR) / 1000n).toString();
export const motesToCspr = (motes: string): number => Number(BigInt(motes)) / Number(MOTES_PER_CSPR);
