/**
 * Reasoning engine — the Treasurer's brain.
 *
 * Provider cascade (whichever is configured first wins; on error it falls
 * through to the next):
 *   1. OpenRouter (OPENROUTER_API_KEY): an OpenAI-compatible model, e.g.
 *      Gemma 4 (`google/gemma-4-26b-a4b-it`).
 *   2. Claude (ANTHROPIC_API_KEY).
 *   3. Deterministic scorer (no key): a transparent scoring function, so the
 *      whole pipeline runs reproducibly with zero external dependencies.
 *
 * Every LLM only RECOMMENDS — the Policy Guard and the on-chain policy decide
 * what actually executes. LLM output is forced into strict JSON, validated with
 * zod; any failure falls through so the treasury never stalls on a bad model.
 */
import { z } from "zod";
import { config } from "./config.js";
import type { AgentDecision, PolicyConfig, RiskReport } from "./types.js";

const DecisionSchema = z.object({
  decision: z.enum(["ALLOCATE", "REJECT", "HOLD", "QUEUE_FOR_APPROVAL"]),
  opportunityId: z.string(),
  confidence: z.number().min(0).max(1),
  riskScore: z.number().min(0).max(100),
  recommendedAmountCspr: z.number().min(0),
  dataPurchased: z.array(z.string()),
  reason: z.string().max(600),
});

/** Human-readable label for the active Treasurer (shown in the dashboard). */
export function reasonerLabel(): string {
  if (config.openrouterApiKey) return `${config.openrouterModel} (openrouter)`;
  if (config.anthropicApiKey) return `${config.anthropicModel} (anthropic)`;
  return "deterministic";
}

export async function decide(
  report: RiskReport,
  policy: PolicyConfig,
  treasuryBalanceCspr: number,
): Promise<AgentDecision> {
  if (config.openrouterApiKey) {
    try {
      return await decideWithOpenRouter(report, policy, treasuryBalanceCspr);
    } catch (err) {
      console.error(`[reasoning] OpenRouter (${config.openrouterModel}) failed, falling through: ${String(err)}`);
    }
  }
  if (config.anthropicApiKey) {
    try {
      return await decideWithClaude(report, policy, treasuryBalanceCspr);
    } catch (err) {
      console.error(`[reasoning] Claude call failed, falling back to deterministic scorer: ${String(err)}`);
    }
  }
  return decideDeterministic(report, policy, treasuryBalanceCspr);
}

/** The shared Treasurer prompt used by every LLM provider. */
function buildPrompt(report: RiskReport, policy: PolicyConfig, treasuryBalanceCspr: number): string {
  return [
    "You are the Treasurer agent of an on-chain DAO treasury on Casper.",
    "Given a risk report for ONE opportunity and the treasury policy, decide:",
    "ALLOCATE (with an amount), REJECT, or HOLD.",
    "Hard policy (a separate guard enforces this — exceeding it wastes the recommendation):",
    JSON.stringify(policy),
    `Treasury balance: ${treasuryBalanceCspr} CSPR.`,
    "Risk report (paid for via x402 micropayments, costs included):",
    JSON.stringify(report),
    "Sizing guidance: prefer conservative sizing; never exceed maxAllocationPerOpCspr;",
    "missing disclosures or 'critical' risk levels should normally mean REJECT.",
    "Respond with ONLY a JSON object (no markdown, no preamble), starting with { and ending with }, with keys:",
    `decision, opportunityId, confidence (0..1), riskScore (0..100), recommendedAmountCspr, dataPurchased (string[]), reason (<=2 sentences).`,
  ].join("\n");
}

/** Tolerant JSON extraction — strips fences and any prose around the object. */
function extractDecision(text: string, report: RiskReport): AgentDecision {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON object in model output: ${clean.slice(0, 200)}`);
  // Models (esp. smaller ones like Gemma) sometimes emit raw newlines/tabs
  // inside string values — invalid JSON control characters. Collapse any raw
  // control chars to spaces before parsing (harmless between tokens, fixes
  // "Bad control character in string literal").
  const json = clean.slice(start, end + 1).replace(new RegExp("[\\u0000-\\u001F]+", "g"), " ");
  const parsed = DecisionSchema.parse(JSON.parse(json));
  return { ...parsed, opportunityId: report.opportunityId, dataPurchased: report.purchased.map((p) => p.source) };
}

async function decideWithOpenRouter(
  report: RiskReport,
  policy: PolicyConfig,
  treasuryBalanceCspr: number,
): Promise<AgentDecision> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openrouterApiKey as string}`,
      // Optional attribution headers (recommended by OpenRouter).
      "HTTP-Referer": "https://github.com/atlas-agent",
      "X-Title": "Atlas Agent Treasurer",
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      max_tokens: 500,
      temperature: 0.2, // low for JSON reliability + reproducibility
      messages: [
        {
          role: "system",
          content: "You are a careful on-chain treasury analyst. Output ONLY a single JSON object — no markdown, no prose.",
        },
        { role: "user", content: buildPrompt(report, policy, treasuryBalanceCspr) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter api ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(`openrouter error: ${data.error.message ?? JSON.stringify(data.error)}`);
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("openrouter returned empty content");
  return extractDecision(text, report);
}

async function decideWithClaude(
  report: RiskReport,
  policy: PolicyConfig,
  treasuryBalanceCspr: number,
): Promise<AgentDecision> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 500,
      messages: [{ role: "user", content: buildPrompt(report, policy, treasuryBalanceCspr) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic api ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((b) => b.type === "text")?.text ?? "";
  return extractDecision(text, report);
}

/** Transparent scorer: every weight is visible, every run reproducible. */
export function decideDeterministic(
  report: RiskReport,
  policy: PolicyConfig,
  treasuryBalanceCspr: number,
): AgentDecision {
  const dataPurchased = report.purchased.map((p) => p.source);
  const yieldScore = Math.min((report.expectedApyBps / 100) * 1.3, 15); // cap credit for absurd APY
  // Convex in risk: mild at low scores, prohibitive near the policy ceiling.
  const riskPenalty = report.riskScore * 0.08 + report.riskScore * report.riskScore * 0.0018;
  const liquidityBonus =
    report.liquidityRating === "deep" ? 2 : report.liquidityRating === "adequate" ? 0.5 : report.liquidityRating === "thin" ? -2 : 0;
  const disclosurePenalty = report.missingDisclosures.length * 2.5;
  const legalPenalty = report.legalRisk === "high" ? 6 : report.legalRisk === "medium" ? 1.5 : 0;
  const score = yieldScore - riskPenalty + liquidityBonus - disclosurePenalty - legalPenalty;

  // Confidence: how much paid evidence we hold, degraded by red flags.
  const evidence = Math.min(report.purchased.length / 3, 1);
  const redFlags = (report.riskScore > 80 ? 1 : 0) + Math.min(report.missingDisclosures.length, 4) / 4;
  const confidence = Math.max(0.3, Math.min(0.95, 0.55 + evidence * 0.35 - redFlags * 0.1));

  if (report.riskScore > policy.maxRiskScore) {
    return {
      decision: "REJECT",
      opportunityId: report.opportunityId,
      confidence: Math.max(confidence, 0.85),
      riskScore: report.riskScore,
      recommendedAmountCspr: 0,
      dataPurchased,
      reason: `Risk ${report.riskScore} exceeds policy max ${policy.maxRiskScore}. ${report.notes[0] ?? ""}`.trim(),
    };
  }
  if (score < 0) {
    return {
      decision: "REJECT",
      opportunityId: report.opportunityId,
      confidence,
      riskScore: report.riskScore,
      recommendedAmountCspr: 0,
      dataPurchased,
      reason: `Risk-adjusted score ${score.toFixed(1)} is negative: yield does not compensate for risk/liquidity/disclosure profile.`,
    };
  }
  if (score < 1.5) {
    return {
      decision: "HOLD",
      opportunityId: report.opportunityId,
      confidence,
      riskScore: report.riskScore,
      recommendedAmountCspr: 0,
      dataPurchased,
      reason: `Marginal risk-adjusted score ${score.toFixed(1)}; keeping funds idle is preferable at current terms.`,
    };
  }

  // Never move money on a single paid source: corroboration is the whole
  // point of buying data. (Allocation needs at least risk + one deep-dive.)
  if (report.purchased.length < 2) {
    return {
      decision: "HOLD",
      opportunityId: report.opportunityId,
      confidence,
      riskScore: report.riskScore,
      recommendedAmountCspr: 0,
      dataPurchased,
      reason: `Risk-adjusted score ${score.toFixed(1)} is attractive but rests on a single data source; holding until corroborating data fits the budget.`,
    };
  }

  // Size scales with score, bounded by policy and a 40% treasury cap.
  const sizeFactor = Math.min(score / 8, 1);
  const amount = Math.min(
    Math.floor(policy.maxAllocationPerOpCspr * sizeFactor),
    Math.floor(treasuryBalanceCspr * 0.4),
  );
  return {
    decision: "ALLOCATE",
    opportunityId: report.opportunityId,
    confidence,
    riskScore: report.riskScore,
    recommendedAmountCspr: Math.max(amount, 1),
    dataPurchased,
    reason: `Risk-adjusted score ${score.toFixed(1)}: yield ${(report.expectedApyBps / 100).toFixed(1)}% vs risk ${report.riskScore}, liquidity ${report.liquidityRating ?? "n/a"}, ${report.missingDisclosures.length} missing disclosures.`,
  };
}
