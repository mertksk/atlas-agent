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

export async function vaultStatus(): Promise<unknown | null> {
  if (config.dryRun || !config.vaultAddress) return null;
  try {
    return JSON.parse(await livenet(["vault-status", config.vaultAddress]));
  } catch {
    return null;
  }
}
