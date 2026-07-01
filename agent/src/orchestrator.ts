/**
 * Orchestrator — the multi-agent pipeline.
 *
 *   Scout        finds opportunities (free endpoint)
 *   Analyst      decides WHAT DATA IS WORTH BUYING and buys it over x402,
 *                under a hard data budget (spends money before investing money)
 *   Risk Officer composes a risk report per opportunity from purchased data
 *   Treasurer    decides ALLOCATE / REJECT / HOLD (LLM or deterministic)
 *   Policy Guard hard-rule layer; clamps and can escalate to approval
 *   Executor     records EVERY decision on-chain; moves funds only for
 *                guard-approved allocations
 *
 * Every step appends to a ledger so the dashboard (and the on-chain registry)
 * can show exactly why money moved — or didn't.
 */
import { config, defaultPolicy } from "./config.js";
import { X402Client, PriceAboveBudgetError } from "./x402Client.js";
import { guard } from "./policyGuard.js";
import { decide } from "./reasoning.js";
import { recordDecisionOnChain, executeAllocationOnChain, swapCsprForWusdc, vaultStatus } from "./chain.js";
import {
  csprToMotes,
  motesToCspr,
  type AgentDecision,
  type GuardVerdict,
  type LedgerEntry,
  type Opportunity,
  type PolicyConfig,
  type PurchasedData,
  type RiskReport,
  type RunResult,
} from "./types.js";

interface RiskPayload {
  opportunityId: string;
  riskScore: number;
  factors: string[];
}
interface LiquidityPayload {
  opportunityId: string;
  withdrawalDelayDays: number;
  dailyVolumeUsd: number;
  liquidityRating: "deep" | "adequate" | "thin";
}
interface RwaDocPayload {
  opportunityId: string;
  legalRisk: "low" | "medium" | "high";
  missingDisclosures: string[];
  [k: string]: unknown;
}
interface MarketSignalPayload {
  sentiment: string;
  summary?: string;
  [k: string]: unknown;
}

export interface OrchestratorOptions {
  policy?: PolicyConfig;
  /** Simulated treasury balance when DRY_RUN; live mode reads the vault. */
  treasuryBalanceCspr?: number;
  spentTodayCspr?: number;
  blacklist?: string[];
  onLedger?: (entry: LedgerEntry) => void;
}

export async function runPipeline(opts: OrchestratorOptions = {}): Promise<RunResult> {
  const policy = opts.policy ?? defaultPolicy;
  const ledger: LedgerEntry[] = [];
  const log = (agent: LedgerEntry["agent"], message: string, data?: unknown) => {
    const entry: LedgerEntry = { ts: new Date().toISOString(), agent, message, data };
    ledger.push(entry);
    opts.onLedger?.(entry);
  };

  const runId = `run-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  const client = new X402Client();
  let spentMotes = 0n;
  const budgetMotes = BigInt(csprToMotes(policy.dataBudgetCspr));
  const remaining = () => budgetMotes - spentMotes;

  // ---------------------------------------------------------------- treasury
  let treasuryBalanceCspr = opts.treasuryBalanceCspr ?? Number(process.env.TREASURY_BALANCE_CSPR ?? 100);
  if (!config.dryRun) {
    const status = (await vaultStatus()) as { balance?: string } | null;
    if (status?.balance) treasuryBalanceCspr = motesToCspr(status.balance);
  }
  let spentTodayCspr = opts.spentTodayCspr ?? 0;
  log(
    "system",
    `Run ${runId} started. Treasury ${treasuryBalanceCspr.toFixed(2)} CSPR, data budget ${policy.dataBudgetCspr} CSPR, mode ${config.dryRun ? "dry-run" : "LIVE (Casper Testnet)"}.`,
  );

  // ------------------------------------------------------------------- scout
  const oppRes = await fetch(`${config.servicesUrl}/opportunities`);
  if (!oppRes.ok) throw new Error(`scout: opportunities endpoint -> ${oppRes.status}`);
  const opportunities = (await oppRes.json()) as Opportunity[];
  log("scout", `Found ${opportunities.length} opportunities on the marketplace.`, {
    ids: opportunities.map((o) => o.id),
  });

  // ----------------------------------------------------------------- analyst
  // Learn prices from the protocol itself: probe each endpoint once and read
  // PaymentRequirements off the 402. No hardcoded price list.
  const u = (path: string, id?: string) => `${config.servicesUrl}${path}${id ? `?id=${id}` : ""}`;
  const [riskPrice, liqPrice, docPrice, signalPrice] = await Promise.all([
    client.quote(u("/api/risk-score", opportunities[0]?.id)),
    client.quote(u("/api/liquidity", opportunities[0]?.id)),
    client.quote(u("/api/rwa-doc", opportunities[0]?.id)),
    client.quote(u("/api/market-signal")),
  ]);
  log(
    "analyst",
    `Quoted data prices via x402 402-responses: risk ${motesToCspr(riskPrice.toString())}, liquidity ${motesToCspr(liqPrice.toString())}, RWA docs ${motesToCspr(docPrice.toString())}, market signal ${motesToCspr(signalPrice.toString())} CSPR.`,
  );

  const purchasedBy = new Map<string, PurchasedData[]>();
  for (const o of opportunities) purchasedBy.set(o.id, []);
  const buy = async <T>(
    source: PurchasedData["source"],
    url: string,
    oppId?: string,
  ): Promise<T | null> => {
    try {
      const res = await client.fetchPaid<T>(url, remaining());
      if (res.paid) {
        spentMotes += BigInt(res.amountMotes);
        const record: PurchasedData = {
          source,
          costMotes: res.amountMotes,
          settlementTx: res.settlementTx,
          settlementMode: res.settlementMode,
          payload: res.data,
        };
        if (oppId) purchasedBy.get(oppId)?.push(record);
        log(
          "analyst",
          `Paid ${motesToCspr(res.amountMotes)} CSPR for ${source}${oppId ? ` on ${oppId}` : ""} (${res.settlementMode ?? "free"}${res.settlementTx ? `, tx ${res.settlementTx.slice(0, 14)}…` : ""}). Budget left ${motesToCspr(remaining().toString())} CSPR.`,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof PriceAboveBudgetError) {
        log("analyst", `Skipped ${source}${oppId ? ` on ${oppId}` : ""}: price exceeds remaining budget.`);
        return null;
      }
      log("analyst", `Failed to buy ${source}${oppId ? ` on ${oppId}` : ""}: ${String(err)}`);
      return null;
    }
  };

  // One market signal for the whole run (cheap, global context).
  const marketSignal = await buy<MarketSignalPayload>("market-signal", u("/api/market-signal"));

  // Value-of-information ranking for risk screening: an opportunity is worth
  // screening if its advertised yield is high (big upside) OR anomalous for
  // its category (scam smell). Both raise the value of a risk score.
  const medianApy = (cat: string) => {
    const xs = opportunities.filter((o) => o.category === cat).map((o) => o.advertisedApyBps).sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)] ?? 0;
  };
  const voi = (o: Opportunity) =>
    o.advertisedApyBps / 100 + Math.abs(o.advertisedApyBps - medianApy(o.category)) / 50;
  const screeningOrder = [...opportunities].sort((a, b) => voi(b) - voi(a));

  // Reserve enough for ONE deep dive (liquidity + docs) once we have at least
  // two screens to compare — otherwise screening eats the whole budget.
  const deepDiveReserve = liqPrice + docPrice;
  const riskOf = new Map<string, RiskPayload>();
  for (const [i, o] of screeningOrder.entries()) {
    const reserve = i >= 2 && riskOf.size >= 2 ? deepDiveReserve : 0n;
    if (remaining() - reserve < riskPrice) {
      log("analyst", `Stopping risk screening at ${riskOf.size}/${opportunities.length}: budget reserved for deep dive.`);
      break;
    }
    const data = await buy<RiskPayload>("risk-score", u("/api/risk-score", o.id), o.id);
    if (data) riskOf.set(o.id, data);
  }

  // Deep-dive the most promising candidates (within policy risk bounds).
  // Conservative mandate: risk discount is squared, so a 58-risk pool must
  // out-yield a 22-risk pool by ~3x to win the deep-dive budget.
  const candidates = opportunities
    .filter((o) => (riskOf.get(o.id)?.riskScore ?? 101) <= policy.maxRiskScore)
    .sort((a, b) => {
      const adj = (o: Opportunity) => {
        const r = riskOf.get(o.id)!.riskScore;
        return o.advertisedApyBps * (1 - r / 100) ** 2;
      };
      return adj(b) - adj(a);
    });
  const liqOf = new Map<string, LiquidityPayload>();
  const docOf = new Map<string, RwaDocPayload>();
  for (const o of candidates) {
    if (remaining() >= liqPrice) {
      const liq = await buy<LiquidityPayload>("liquidity", u("/api/liquidity", o.id), o.id);
      if (liq) liqOf.set(o.id, liq);
    }
    if (o.category === "RWA" && remaining() >= docPrice) {
      const doc = await buy<RwaDocPayload>("rwa-doc", u("/api/rwa-doc", o.id), o.id);
      if (doc) docOf.set(o.id, doc);
    }
    if (remaining() < liqPrice) break; // nothing more we can afford
  }
  log(
    "analyst",
    `Data acquisition complete: ${motesToCspr(spentMotes.toString())} of ${policy.dataBudgetCspr} CSPR spent across ${[...purchasedBy.values()].flat().length} purchases.`,
  );

  // -------------------------------------------------- risk officer + treasurer
  const decisions: RunResult["decisions"] = [];
  for (const o of opportunities) {
    const purchased = purchasedBy.get(o.id) ?? [];
    const dataCostMotes = purchased.reduce((s, p) => s + BigInt(p.costMotes), 0n).toString();
    const risk = riskOf.get(o.id);
    const liq = liqOf.get(o.id);
    const doc = docOf.get(o.id);

    const notes: string[] = [];
    if (risk) notes.push(...risk.factors.map((f) => `risk: ${f}`));
    if (marketSignal?.sentiment) notes.push(`market: ${marketSignal.sentiment}`);
    if (doc?.legalRisk) notes.push(`legal risk: ${doc.legalRisk}`);

    const report: RiskReport = {
      opportunityId: o.id,
      riskScore: risk?.riskScore ?? 100,
      expectedApyBps: o.advertisedApyBps,
      liquidityRating: liq?.liquidityRating,
      withdrawalDelayDays: liq?.withdrawalDelayDays,
      legalRisk: doc?.legalRisk,
      missingDisclosures: doc?.missingDisclosures ?? [],
      purchased,
      dataCostMotes,
      notes,
    };
    log("risk-officer", `Report for ${o.id}: risk ${risk ? report.riskScore : "UNKNOWN (not screened)"}, ${purchased.length} data source(s), cost ${motesToCspr(dataCostMotes)} CSPR.`);

    // Treasurer only deliberates over screened opportunities; unscreened ones
    // are held on principle — we do not move money on advertised numbers alone.
    let decision: AgentDecision;
    if (!risk) {
      decision = {
        decision: "HOLD",
        opportunityId: o.id,
        confidence: 0.3,
        riskScore: 100,
        recommendedAmountCspr: 0,
        dataPurchased: [],
        reason: "Not screened within this run's data budget; no allocation without purchased risk data.",
      };
      log("treasurer", `${o.id}: HOLD — no purchased risk data.`);
    } else {
      decision = await decide(report, policy, treasuryBalanceCspr);
      log(
        "treasurer",
        `${o.id}: ${decision.decision}${decision.decision === "ALLOCATE" ? ` ${decision.recommendedAmountCspr} CSPR` : ""} (confidence ${(decision.confidence * 100).toFixed(0)}%, risk ${decision.riskScore}).`,
        { reason: decision.reason },
      );
    }

    // ------------------------------------------------------------ policy guard
    const verdict: GuardVerdict = guard(decision, policy, {
      spentTodayCspr,
      treasuryBalanceCspr,
      blacklist: opts.blacklist,
    });
    if (verdict.violations.length > 0) {
      log("policy-guard", `${o.id}: ${verdict.finalAction} — ${verdict.violations.join("; ")}`);
    } else {
      log("policy-guard", `${o.id}: ${verdict.finalAction} cleared (${verdict.clampedAmountCspr} CSPR).`);
    }

    // ---------------------------------------------------------------- executor
    const finalAmount = verdict.clampedAmountCspr;
    const onChain = await recordDecisionOnChain({
      opportunityId: o.id,
      action: verdict.finalAction,
      confidence: decision.confidence,
      riskScore: decision.riskScore,
      amountCspr: finalAmount,
      dataCostMotes,
      dataSources: purchased.map((p) => p.source),
      reason: decision.reason,
    });
    log(
      "executor",
      onChain.dryRun
        ? `${o.id}: decision logged (dry-run; set DRY_RUN=false + contract addresses to write to the DecisionRegistry).`
        : onChain.recorded
          ? `${o.id}: decision #${onChain.decisionId} recorded on the DecisionRegistry (Casper Testnet).`
          : `${o.id}: failed to record decision on-chain: ${onChain.error}`,
    );

    if (verdict.finalAction === "ALLOCATE" && finalAmount > 0) {
      // With cspr.trade enabled, executing an allocation performs a REAL on-chain
      // CSPR->WUSDC swap on the DEX; otherwise it's the vault's policy-enforced
      // transfer to the strategy recipient.
      const exec = config.csprTradeEnabled
        ? await swapCsprForWusdc(finalAmount)
        : await executeAllocationOnChain({
            opportunityId: o.id,
            amountCspr: finalAmount,
            recipient: o.strategyAddress,
            riskScore: decision.riskScore,
            confidence: decision.confidence,
          });
      if (exec.executed || exec.dryRun) {
        spentTodayCspr += finalAmount;
        treasuryBalanceCspr -= finalAmount;
      }
      log(
        "executor",
        exec.dryRun
          ? `${o.id}: would allocate ${finalAmount} CSPR to ${o.strategyAddress.slice(0, 16)}… (dry-run).`
          : exec.executed
            ? config.csprTradeEnabled
              ? `${o.id}: swapped ${finalAmount} CSPR → WUSDC on cspr.trade (real DEX execution).`
              : `${o.id}: allocated ${finalAmount} CSPR via TreasuryVault.execute_allocation.`
            : `${o.id}: allocation failed on-chain: ${exec.error}`,
      );
      onChain.executed = exec.executed;
      if (exec.error) onChain.error = exec.error;
    } else if (verdict.finalAction === "QUEUE_FOR_APPROVAL") {
      log("executor", `${o.id}: ${finalAmount} CSPR queued for human approval (above ${policy.approvalThresholdCspr} CSPR threshold).`);
    }

    decisions.push({ decision: { ...decision, recommendedAmountCspr: finalAmount }, verdict, report, onChain });
  }

  const finishedAt = new Date().toISOString();
  log(
    "system",
    `Run complete: ${decisions.filter((d) => d.verdict.finalAction === "ALLOCATE").length} allocation(s), ${decisions.filter((d) => d.verdict.finalAction === "REJECT").length} rejection(s), ${decisions.filter((d) => d.verdict.finalAction === "QUEUE_FOR_APPROVAL").length} queued, ${decisions.filter((d) => d.verdict.finalAction === "HOLD").length} held. Data cost ${motesToCspr(spentMotes.toString())} CSPR.`,
  );

  return {
    runId,
    startedAt,
    finishedAt,
    decisions,
    totalDataCostMotes: spentMotes.toString(),
    ledger,
  };
}
