/**
 * CSPR.Cloud data layer (MAKE's enterprise Casper indexer REST API).
 *
 * Built with the official CSPR.Cloud AI Agent Skill (https://cspr.cloud/skill.md,
 * committed at skills/cspr-cloud/SKILL.md) as the grounding for the endpoints,
 * base URL and auth convention.
 *
 * This is ADDITIVE and read-only: when CSPR_CLOUD_API_KEY is set, Atlas prefers
 * CSPR.Cloud for account balance / CEP-18 holdings / deploy status; every caller
 * falls back to the existing cspr.live + node-RPC path if the key is unset, the
 * quota is hit, or a request fails. Nothing here touches signing or swap exec.
 *
 * Auth: REST expects `Authorization: <raw-token>` (NOT "Bearer <token>").
 * Register a free access token at https://console.cspr.build/sign-up.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE = process.env.CSPR_CLOUD_URL ?? "https://api.testnet.cspr.cloud";
const apiKey = (): string | undefined => process.env.CSPR_CLOUD_API_KEY;

/** True when a CSPR.Cloud key is configured (so callers know to prefer it). */
export const csprCloudEnabled = (): boolean => Boolean(apiKey());

async function get(path: string): Promise<any> {
  const k = apiKey();
  if (!k) throw new Error("CSPR_CLOUD_API_KEY unset"); // caller falls back
  const r = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json", authorization: k }, // raw token, no "Bearer"
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`cspr.cloud HTTP ${r.status}`);
  return r.json();
}

/** Liquid CSPR balance (CSPR). `id` = public-key hex OR account-hash. */
export async function cloudAccountBalanceCspr(id: string): Promise<number> {
  const j = await get(`/accounts/${id}`);
  return Number(j.data?.balance ?? j.balance ?? 0) / 1e9;
}

export interface FtHolding {
  symbol: string | null;
  decimals: number;
  contractPackageHash: string;
  balance: string; // base units (string)
  amount: number; // decimal-adjusted
}

/** CEP-18 fungible-token holdings for an account — lets us VERIFY on-chain that
 *  the user actually received the swapped WUSDC (not just trust the DEX). */
export async function cloudFtHoldings(id: string): Promise<FtHolding[]> {
  const j = await get(`/accounts/${id}/ft-token-ownership?page=1&page_size=50&includes=contract_package`);
  const rows: any[] = j.data ?? [];
  return rows.map((t) => {
    const meta = t.contract_package?.metadata ?? {};
    const decimals = Number(meta.decimals ?? 0);
    const balance = String(t.balance ?? "0");
    return {
      symbol: meta.symbol ?? null,
      decimals,
      contractPackageHash: t.contract_package_hash ?? t.contract_package?.contract_package_hash ?? "",
      balance,
      amount: decimals > 0 ? Number(balance) / 10 ** decimals : Number(balance),
    };
  });
}

/** Deploy execution status by hash (on-chain confirmation of a swap/transfer). */
export async function cloudDeployStatus(hash: string): Promise<{ found: boolean; success?: boolean; errorMessage?: string }> {
  try {
    const j = await get(`/deploys/${hash}`);
    const d = j.data ?? j;
    const err = d?.error_message ?? null;
    return { found: true, success: err == null, errorMessage: err ?? undefined };
  } catch {
    return { found: false };
  }
}
