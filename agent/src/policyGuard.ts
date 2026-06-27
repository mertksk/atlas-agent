/**
 * Policy Guard — the hard-rule layer between the reasoning engine and money.
 *
 * The LLM proposes; the guard disposes. Pure, deterministic, unit-testable.
 * It mirrors the on-chain policy in TreasuryVault, so anything the guard
 * passes will also pass the contract (defense in depth: even if this layer
 * were bypassed, the contract enforces the same limits).
 */
import type { AgentDecision, GuardVerdict, PolicyConfig } from "./types.js";

export function guard(
  decision: AgentDecision,
  policy: PolicyConfig,
  ctx: { spentTodayCspr: number; treasuryBalanceCspr: number; blacklist?: string[] },
): GuardVerdict {
  const violations: string[] = [];
  let amount = decision.recommendedAmountCspr;
  let action = decision.decision;

  // Non-allocating actions pass through untouched.
  if (action === "REJECT" || action === "HOLD") {
    return { allowed: true, finalAction: action, violations, clampedAmountCspr: 0 };
  }

  if (ctx.blacklist?.includes(decision.opportunityId)) {
    return {
      allowed: false,
      finalAction: "REJECT",
      violations: [`opportunity ${decision.opportunityId} is blacklisted`],
      clampedAmountCspr: 0,
    };
  }

  if (decision.riskScore > policy.maxRiskScore) {
    return {
      allowed: false,
      finalAction: "REJECT",
      violations: [`risk ${decision.riskScore} > policy max ${policy.maxRiskScore}`],
      clampedAmountCspr: 0,
    };
  }

  if (decision.confidence < policy.minConfidence) {
    return {
      allowed: false,
      finalAction: "HOLD",
      violations: [`confidence ${decision.confidence.toFixed(2)} < policy min ${policy.minConfidence}`],
      clampedAmountCspr: 0,
    };
  }

  if (amount <= 0) {
    return { allowed: false, finalAction: "HOLD", violations: ["non-positive amount"], clampedAmountCspr: 0 };
  }

  // Clamp rather than reject on size overruns — the agent's direction can be
  // right even when its sizing is greedy. Every clamp is logged as a violation.
  if (amount > policy.maxAllocationPerOpCspr) {
    violations.push(`amount ${amount} clamped to per-opportunity cap ${policy.maxAllocationPerOpCspr}`);
    amount = policy.maxAllocationPerOpCspr;
  }
  const dailyRemaining = policy.maxDailySpendCspr - ctx.spentTodayCspr;
  if (amount > dailyRemaining) {
    if (dailyRemaining <= 0) {
      return {
        allowed: false,
        finalAction: "HOLD",
        violations: [...violations, "daily spend cap exhausted"],
        clampedAmountCspr: 0,
      };
    }
    violations.push(`amount ${amount} clamped to remaining daily cap ${dailyRemaining}`);
    amount = dailyRemaining;
  }
  if (amount > ctx.treasuryBalanceCspr) {
    violations.push(`amount ${amount} clamped to treasury balance ${ctx.treasuryBalanceCspr}`);
    amount = Math.floor(ctx.treasuryBalanceCspr);
  }
  if (amount <= 0) {
    return { allowed: false, finalAction: "HOLD", violations, clampedAmountCspr: 0 };
  }

  // Big tickets always go to a human, regardless of what the model says.
  if (amount >= policy.approvalThresholdCspr) {
    return {
      allowed: true,
      finalAction: "QUEUE_FOR_APPROVAL",
      violations: [...violations, `amount ${amount} >= approval threshold ${policy.approvalThresholdCspr}: human sign-off required`],
      clampedAmountCspr: amount,
    };
  }

  return { allowed: true, finalAction: "ALLOCATE", violations, clampedAmountCspr: amount };
}
