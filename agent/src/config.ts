import { existsSync } from "node:fs";
import type { PolicyConfig } from "./types.js";

/** Thrown on fatal misconfiguration so the process fails fast and loudly. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : v.toLowerCase() !== "false" && v !== "0";

const num = (name: string, raw: string | undefined, dflt: number): number => {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a finite number, got "${raw}"`);
  return n;
};

export const config = {
  servicesUrl: process.env.SERVICES_URL ?? "http://localhost:4021",
  apiPort: num("AGENT_PORT", process.env.AGENT_PORT, 4030),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY, // optional: enables Claude as Treasurer
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  // optional: enables an OpenRouter-hosted model (e.g. Gemma 4) as Treasurer.
  // Takes precedence over Claude when set. Cascade: openrouter -> claude -> deterministic.
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterModel: process.env.OPENROUTER_MODEL ?? "google/gemma-4-26b-a4b-it",
  // x402 data-payment payer (facilitator/real mode): the Casper key that signs the
  // EIP-712 TransferWithAuthorization the facilitator settles as a CEP-18 transfer.
  x402PayerKeyPath: process.env.X402_PAYER_KEY_PATH,
  x402PayerKeyAlgo: process.env.X402_PAYER_KEY_ALGO ?? "ed25519",
  // On-chain wiring (Casper Testnet). DRY_RUN=false requires deployed contracts
  // + the atlas_livenet binary + a funded key. Everything else works without it.
  dryRun: bool(process.env.DRY_RUN, true),
  vaultAddress: process.env.VAULT_ADDRESS,
  registryAddress: process.env.REGISTRY_ADDRESS,
  livenetCmd:
    process.env.LIVENET_CMD ??
    "cargo run --quiet --bin atlas_livenet --features livenet --manifest-path ../contracts/Cargo.toml --",
  // The atlas_livenet binary signs with this key; we validate it exists in live mode.
  // In the two-key model this is the AGENT key (used for record-decision + sub-
  // threshold execute-allocation).
  livenetSecretKeyPath: process.env.ODRA_CASPER_LIVENET_SECRET_KEY_PATH,
  // Owner key, used only for human-approved actions (executing allocations that
  // are >= the on-chain approval threshold, which the agent key alone cannot).
  // Unset => approvals of >= the approval threshold cannot succeed (the agent key
  // would be rejected on-chain). Sub-threshold auto-allocations still work.
  ownerSecretKeyPath: process.env.OWNER_SECRET_KEY_PATH,
  // Bearer token guarding the state-changing API endpoints (run, approve).
  // Unset => those endpoints are unauthenticated (dev only).
  apiToken: process.env.AGENT_API_TOKEN,
  // CORS allowlist for the agent API. Comma-separated origins; "*" allowed but
  // discouraged. Defaults to the local dashboard only.
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Persistent ledger/state file so runs, decisions and balances survive restarts.
  statePath: process.env.STATE_PATH ?? "data/ledger.json",
  treasuryBalanceCspr: num("TREASURY_BALANCE_CSPR", process.env.TREASURY_BALANCE_CSPR, 100),
};

export const defaultPolicy: PolicyConfig = {
  maxAllocationPerOpCspr: num("POLICY_MAX_PER_OP", process.env.POLICY_MAX_PER_OP, 30),
  maxDailySpendCspr: num("POLICY_MAX_DAILY", process.env.POLICY_MAX_DAILY, 50),
  minConfidence: num("POLICY_MIN_CONFIDENCE", process.env.POLICY_MIN_CONFIDENCE, 0.7),
  maxRiskScore: num("POLICY_MAX_RISK", process.env.POLICY_MAX_RISK, 60),
  approvalThresholdCspr: num("POLICY_APPROVAL_THRESHOLD", process.env.POLICY_APPROVAL_THRESHOLD, 25),
  // 4 CSPR covers: market signal (0.4) + risk screens for all 5 opportunities
  // (5 x 0.5) + one full deep dive (liquidity 0.3 + RWA docs 0.8). Lower it and
  // the analyst degrades gracefully, screening fewer opportunities.
  dataBudgetCspr: num("POLICY_DATA_BUDGET", process.env.POLICY_DATA_BUDGET, 4),
};

/**
 * Validate configuration once at startup. Throws {@link ConfigError} on fatal
 * problems (so a misconfigured live deployment never silently mis-allocates);
 * returns a list of non-fatal warnings for the caller to log.
 */
export function validateConfig(): string[] {
  const warnings: string[] = [];
  const p = defaultPolicy;

  // --- Policy sanity (always enforced; these mirror on-chain expectations) ---
  if (!(p.minConfidence > 0 && p.minConfidence <= 1))
    throw new ConfigError(`POLICY_MIN_CONFIDENCE must be in (0,1], got ${p.minConfidence}`);
  if (!(p.maxRiskScore >= 0 && p.maxRiskScore <= 100))
    throw new ConfigError(`POLICY_MAX_RISK must be in [0,100], got ${p.maxRiskScore}`);
  for (const [k, v] of [
    ["POLICY_MAX_PER_OP", p.maxAllocationPerOpCspr],
    ["POLICY_MAX_DAILY", p.maxDailySpendCspr],
    ["POLICY_APPROVAL_THRESHOLD", p.approvalThresholdCspr],
    ["POLICY_DATA_BUDGET", p.dataBudgetCspr],
  ] as const) {
    if (!(v >= 0)) throw new ConfigError(`${k} must be >= 0, got ${v}`);
  }
  if (p.maxAllocationPerOpCspr > p.maxDailySpendCspr)
    warnings.push(
      `POLICY_MAX_PER_OP (${p.maxAllocationPerOpCspr}) exceeds POLICY_MAX_DAILY (${p.maxDailySpendCspr}); the daily cap will bind first.`,
    );
  if (p.approvalThresholdCspr > p.maxAllocationPerOpCspr)
    warnings.push(
      `POLICY_APPROVAL_THRESHOLD (${p.approvalThresholdCspr}) exceeds POLICY_MAX_PER_OP (${p.maxAllocationPerOpCspr}); no allocation can ever reach human approval.`,
    );

  // --- CORS hygiene ---
  if (config.corsOrigins.includes("*"))
    warnings.push(`CORS_ORIGIN is "*" (any origin). Set it to your dashboard origin for production.`);

  // --- API auth ---
  if (!config.apiToken)
    warnings.push(
      `AGENT_API_TOKEN is unset — POST /api/run and /api/approve are UNAUTHENTICATED. Set it for any non-localhost deployment.`,
    );

  // --- Live-mode requirements (fatal if missing) ---
  if (!config.dryRun) {
    if (config.ownerSecretKeyPath && !existsSync(config.ownerSecretKeyPath))
      throw new ConfigError(`Owner key not found at OWNER_SECRET_KEY_PATH=${config.ownerSecretKeyPath}`);
    if (!config.ownerSecretKeyPath)
      warnings.push(
        `OWNER_SECRET_KEY_PATH unset: approvals use the agent key, so allocations >= the approval threshold will revert on-chain (owner-only). Set a separate owner key for the two-key model.`,
      );
    const missing: string[] = [];
    if (!config.vaultAddress) missing.push("VAULT_ADDRESS");
    if (!config.registryAddress) missing.push("REGISTRY_ADDRESS");
    if (!config.livenetSecretKeyPath) missing.push("ODRA_CASPER_LIVENET_SECRET_KEY_PATH");
    // Fail-closed: never expose funds-moving endpoints unauthenticated in live mode.
    if (!config.apiToken) missing.push("AGENT_API_TOKEN");
    if (missing.length)
      throw new ConfigError(
        `DRY_RUN=false (live mode) requires: ${missing.join(", ")}. Set them, or run with DRY_RUN=true.`,
      );
    if (config.livenetSecretKeyPath && !existsSync(config.livenetSecretKeyPath))
      throw new ConfigError(
        `Secret key not found at ODRA_CASPER_LIVENET_SECRET_KEY_PATH=${config.livenetSecretKeyPath}`,
      );
    for (const [k, v] of [
      ["VAULT_ADDRESS", config.vaultAddress],
      ["REGISTRY_ADDRESS", config.registryAddress],
    ] as const) {
      if (v && !v.startsWith("hash-"))
        warnings.push(`${k}=${v} does not look like a contract hash (expected "hash-…").`);
    }
  }

  return warnings;
}
