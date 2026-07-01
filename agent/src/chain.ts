/**
 * Chain layer — the agent's only path to money movement.
 *
 * All Casper Testnet writes go through the `atlas_livenet` Rust binary
 * (contracts/src/bin/livenet.rs) built on Odra's livenet backend, so the same
 * audited contract bindings handle deploys AND calls. With DRY_RUN=true
 * (default) actions are logged but not submitted — the rest of the pipeline,
 * including x402 purchases, runs identically.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { csprToMotes } from "./types.js";

const exec = promisify(execFile);

async function livenet(args: string[], secretKeyPath?: string): Promise<string> {
  const [cmd, ...base] = config.livenetCmd.split(" ");
  // Optionally sign with a specific key (the owner key for human-approved
  // actions); otherwise inherit the process env (the agent key).
  const env = secretKeyPath
    ? { ...process.env, ODRA_CASPER_LIVENET_SECRET_KEY_PATH: secretKeyPath }
    : process.env;
  const { stdout } = await exec(cmd, [...base, ...args], { timeout: 240_000, env });
  return stdout.trim();
}

export interface OnChainOutcome {
  recorded: boolean;
  executed: boolean;
  dryRun: boolean;
  decisionId?: number;
  error?: string;
}

export async function recordDecisionOnChain(d: {
  opportunityId: string;
  action: string;
  confidence: number;
  riskScore: number;
  amountCspr: number;
  dataCostMotes: string;
  dataSources: string[];
  reason: string;
}): Promise<OnChainOutcome> {
  if (config.dryRun || !config.registryAddress) {
    return { recorded: false, executed: false, dryRun: true };
  }
  try {
    const out = await livenet([
      "record-decision",
      config.registryAddress,
      d.opportunityId,
      d.action,
      String(Math.round(d.confidence * 10_000)),
      String(Math.round(d.riskScore)),
      csprToMotes(d.amountCspr),
      d.dataCostMotes,
      d.dataSources.join(","),
      d.reason.slice(0, 280),
    ]);
    const parsed = JSON.parse(out.split("\n").pop() ?? "{}");
    return { recorded: true, executed: false, dryRun: false, decisionId: parsed.decisionId };
  } catch (err) {
    return { recorded: false, executed: false, dryRun: false, error: String(err) };
  }
}

export async function executeAllocationOnChain(
  d: {
    opportunityId: string;
    amountCspr: number;
    recipient: string;
    riskScore: number;
    confidence: number;
  },
  opts: { asOwner?: boolean } = {},
): Promise<OnChainOutcome> {
  if (config.dryRun || !config.vaultAddress) {
    return { recorded: false, executed: false, dryRun: true };
  }
  // Human-approved allocations (>= the approval threshold) must be signed by the
  // owner; the agent key alone would revert RequiresHumanApproval on-chain. Fail
  // fast (no wasted gas) if owner signing is requested but unconfigured.
  if (opts.asOwner && !config.ownerSecretKeyPath) {
    return {
      recorded: false,
      executed: false,
      dryRun: false,
      error: "OWNER_SECRET_KEY_PATH not configured; cannot sign a human-approved (>= threshold) allocation.",
    };
  }
  const keyPath = opts.asOwner ? config.ownerSecretKeyPath : undefined;
  try {
    await livenet(
      [
        "execute-allocation",
        config.vaultAddress,
        d.opportunityId,
        csprToMotes(d.amountCspr),
        d.recipient,
        String(Math.round(d.riskScore)),
        String(Math.round(d.confidence * 10_000)),
      ],
      keyPath,
    );
    return { recorded: false, executed: true, dryRun: false };
  } catch (err) {
    return { recorded: false, executed: false, dryRun: false, error: String(err) };
  }
}

const CSPR_LIVE_API = "https://api.testnet.cspr.live";

/** Read live WCSPR/WUSDC pool reserves (base units) to size a swap's min_out off-chain. */
async function poolReserves(poolHash: string): Promise<{ wcspr: bigint; wusdc: bigint }> {
  const r = await fetch(`${CSPR_LIVE_API}/accounts/${poolHash}/ft-token-ownership?page=1&limit=10`, {
    headers: { "User-Agent": "atlas-agent" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`pool reserves HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ balance?: string; contract_package?: { metadata?: { symbol?: string } } }> };
  const res: Record<string, bigint> = {};
  for (const t of j.data ?? []) {
    const sym = t.contract_package?.metadata?.symbol;
    if (sym) res[sym] = BigInt(t.balance ?? "0");
  }
  if (!res.WCSPR || !res.WUSDC) throw new Error("WCSPR/WUSDC reserves unavailable");
  return { wcspr: res.WCSPR, wusdc: res.WUSDC };
}

/**
 * Execute a REAL CSPR->WUSDC swap on the cspr.trade DEX (the agent key signs;
 * WUSDC lands in config.csprTradeRecipient). min_out is sized from live reserves
 * with the configured slippage. Guarded by CSPRTRADE_MAX_SWAP_CSPR.
 */
export async function swapCsprForWusdc(
  amountCspr: number,
): Promise<OnChainOutcome & { minOut?: string; expectedOut?: string; txAmountMotes?: string }> {
  if (config.dryRun) return { recorded: false, executed: false, dryRun: true };
  if (!(amountCspr > 0)) return { recorded: false, executed: false, dryRun: false, error: "swap amount must be > 0" };
  if (amountCspr > config.csprTradeMaxSwapCspr) {
    return { recorded: false, executed: false, dryRun: false, error: `swap ${amountCspr} CSPR exceeds CSPRTRADE_MAX_SWAP_CSPR=${config.csprTradeMaxSwapCspr}` };
  }
  try {
    const { wcspr, wusdc } = await poolReserves(config.csprTradePool);
    const amountIn = BigInt(csprToMotes(amountCspr)); // WCSPR base == motes (9 dp)
    // Uniswap-V2 getAmountOut with the 0.3% fee.
    const expectedOut = (amountIn * 997n * wusdc) / (wcspr * 1000n + amountIn * 997n);
    const minOut = (expectedOut * BigInt(10_000 - config.csprTradeSlippageBps)) / 10_000n;
    if (minOut <= 0n) throw new Error("computed min_out is 0 (amount too small for current reserves)");
    await livenet([
      "swap-cspr",
      config.csprTradeRouter,
      config.csprTradeWcspr,
      config.csprTradeWusdc,
      amountIn.toString(),
      config.csprTradeRecipient,
      minOut.toString(),
    ]);
    return { recorded: false, executed: true, dryRun: false, minOut: minOut.toString(), expectedOut: expectedOut.toString(), txAmountMotes: amountIn.toString() };
  } catch (err) {
    return { recorded: false, executed: false, dryRun: false, error: String(err) };
  }
}

export async function vaultStatus(): Promise<unknown | null> {
  if (config.dryRun || !config.vaultAddress) return null;
  try {
    return JSON.parse(await livenet(["vault-status", config.vaultAddress]));
  } catch {
    return null;
  }
}
