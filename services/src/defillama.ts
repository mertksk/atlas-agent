/**
 * Live data source: DefiLlama yields API (https://yields.llama.fi/pools, free,
 * no key). Maps real protocol pools into the same shapes the mock marketplace
 * serves, deriving REAL risk signals (TVL, IL risk, σ volatility, outlier flag,
 * ML predictions) instead of hand-authored numbers.
 *
 * Enabled with DATA_SOURCE=defillama. Falls back to the mock dataset if the API
 * is unreachable, so the demo never goes dark.
 */
import {
  Opportunity,
  RiskData,
  LiquidityData,
  RwaDocSummary,
  OPPORTUNITIES as MOCK,
  getRisk as mockRisk,
  getLiquidity as mockLiquidity,
  getRwaDoc as mockRwaDoc,
} from "./data.js";

const POOLS_URL = "https://yields.llama.fi/pools";
const TTL_MS = 10 * 60 * 1000; // refresh selection every 10 min
const MAX_OPPS = 7;

// Known real-world-asset protocols on DefiLlama → tagged as RWA for variety.
const RWA_PROJECTS = new Set([
  "ondo-finance", "ondo", "maple", "maple-finance", "centrifuge", "goldfinch",
  "flux-finance", "openeden", "backed", "clearpool", "truefi", "superstate",
]);

const strat = (slot: number) => process.env[`STRATEGY_ADDR_${slot}`] ?? `account-hash-demo-strategy-${slot}`;

export interface Pool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  stablecoin: boolean;
  ilRisk: string; // "yes" | "no"
  exposure: string; // "single" | "multi"
  sigma: number | null;
  outlier: boolean;
  poolMeta?: string | null;
  volumeUsd1d?: number | null;
  predictions?: { predictedClass?: string; predictedProbability?: number } | null;
}

/* ----------------------------------------------------------- pure mappers */
export const usd = (n: number): string =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;

/** Composite 0..100 risk from real DefiLlama signals (higher = riskier). */
export function riskScore(p: Pool): number {
  let r = 12;
  if (p.stablecoin) r -= 6;
  if (p.ilRisk === "yes") r += 14;
  if (p.exposure === "multi") r += 8;
  if (p.outlier) r += 25;
  const apy = p.apy ?? 0;
  if (apy >= 100) r += 35;
  else if (apy >= 50) r += 22;
  else if (apy >= 25) r += 12;
  else if (apy >= 12) r += 5;
  const tvl = p.tvlUsd ?? 0;
  if (tvl < 1e6) r += 22;
  else if (tvl < 1e7) r += 12;
  else if (tvl < 1e8) r += 4;
  else if (tvl > 1e9) r -= 6;
  r += Math.min((p.sigma ?? 0) * 30, 18);
  if (p.predictions?.predictedClass === "Down") r += 12;
  return Math.max(1, Math.min(99, Math.round(r)));
}

export function riskLevel(s: number): RiskData["riskLevel"] {
  return s < 30 ? "low" : s < 55 ? "medium" : s < 80 ? "high" : "critical";
}

export const isRwa = (p: Pool): boolean => RWA_PROJECTS.has(p.project);

export function toOpportunity(p: Pool, slot: number): Opportunity {
  return {
    id: p.pool,
    name: `${p.project} · ${p.symbol}`,
    category: isRwa(p) ? "RWA" : "DeFi",
    advertisedApyBps: Math.round((p.apy ?? 0) * 100),
    minAllocationCspr: 1,
    strategyAddress: strat(slot),
    blurb: `${p.symbol} on ${p.chain} via ${p.project}. TVL ${usd(p.tvlUsd)}${p.poolMeta ? ` · ${p.poolMeta}` : ""}.`,
  };
}

/** Curate a demo-friendly spread of REAL pools: safe anchors → RWA → mid → one spicy outlier. */
export function selectPools(pools: Pool[]): Pool[] {
  const ok = pools.filter(
    (p) => p.pool && p.symbol && p.project && typeof p.apy === "number" && (p.apy as number) >= 0 && typeof p.tvlUsd === "number" && p.tvlUsd > 50_000,
  );
  const byTvl = (a: Pool, b: Pool) => b.tvlUsd - a.tvlUsd;
  const byApy = (a: Pool, b: Pool) => (b.apy ?? 0) - (a.apy ?? 0);
  const picked: Pool[] = [];
  const used = new Set<string>();
  const take = (arr: Pool[], n: number) => {
    for (const p of arr) {
      if (picked.length >= MAX_OPPS || n <= 0) break;
      if (!used.has(p.pool)) {
        used.add(p.pool);
        picked.push(p);
        n--;
      }
    }
  };
  take(ok.filter((p) => p.stablecoin && (p.apy as number) >= 1 && (p.apy as number) <= 12).sort(byTvl), 2); // safe stable anchors
  take(ok.filter(isRwa).sort(byTvl), 2); // real-world-asset pools
  take(ok.filter((p) => (p.apy as number) >= 12 && (p.apy as number) <= 45 && p.tvlUsd > 5e6 && !p.outlier).sort(byTvl), 1); // mid
  take(ok.filter((p) => (p.apy as number) >= 80 || p.outlier).sort(byApy), 1); // spicy / anomalous yield
  take(ok.sort(byTvl), MAX_OPPS - picked.length); // backfill with blue chips
  return picked.slice(0, MAX_OPPS);
}

/* ----------------------------------------------------------- live cache */
let cache: { at: number; opps: Opportunity[]; pools: Map<string, Pool> } | null = null;

async function fetchPools(): Promise<Pool[]> {
  const r = await fetch(POOLS_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`DefiLlama responded ${r.status}`);
  const j = (await r.json()) as { data?: Pool[] };
  if (!Array.isArray(j.data) || j.data.length === 0) throw new Error("DefiLlama returned no pools");
  return j.data;
}

async function ensureFresh(): Promise<void> {
  if (cache && Date.now() - cache.at < TTL_MS) return;
  const selected = selectPools(await fetchPools());
  const pools = new Map<string, Pool>();
  const opps = selected.map((p, i) => {
    pools.set(p.pool, p);
    return toOpportunity(p, (i % 5) + 1);
  });
  cache = { at: Date.now(), opps, pools };
  console.log(`[services] DefiLlama: ${opps.length} live pools selected (${opps.map((o) => o.name).join(", ")})`);
}

export async function listOpportunities(): Promise<Opportunity[]> {
  try {
    await ensureFresh();
    return cache!.opps;
  } catch (e) {
    console.warn(`[services] DefiLlama unavailable, falling back to mock opportunities: ${String(e)}`);
    return MOCK;
  }
}

async function pool(id: string): Promise<Pool | null> {
  try {
    await ensureFresh();
  } catch {
    return null; // signal caller to fall back to mock
  }
  return cache!.pools.get(id) ?? null;
}

export async function risk(id: string): Promise<RiskData | undefined> {
  const p = await pool(id);
  if (!p) return mockRisk(id);
  const score = riskScore(p);
  return {
    opportunityId: id,
    riskScore: score,
    riskLevel: riskLevel(score),
    factors: [
      `TVL ${usd(p.tvlUsd)} on ${p.chain}`,
      `APY ${(p.apy ?? 0).toFixed(2)}% (base ${(p.apyBase ?? 0).toFixed(2)}%${p.apyReward ? `, +${p.apyReward.toFixed(2)}% rewards` : ""})`,
      p.stablecoin ? "Stablecoin exposure" : `${p.exposure}-asset · IL risk: ${p.ilRisk}`,
      `30d volatility σ=${(p.sigma ?? 0).toFixed(3)}`,
      p.outlier
        ? "⚠ DefiLlama OUTLIER flag — yield anomalous vs. peers"
        : `ML outlook: ${p.predictions?.predictedClass ?? "n/a"}${p.predictions?.predictedProbability ? ` (${p.predictions.predictedProbability}%)` : ""}`,
    ],
  };
}

export async function liquidity(id: string): Promise<LiquidityData | undefined> {
  const p = await pool(id);
  if (!p) return mockLiquidity(id);
  const vol = p.volumeUsd1d ?? Math.round(p.tvlUsd * 0.05);
  return {
    opportunityId: id,
    withdrawalDelayDays: 0,
    dailyVolumeUsd: Math.round(vol),
    liquidityRating: p.tvlUsd > 1e8 ? "deep" : p.tvlUsd > 1e7 ? "adequate" : "thin",
  };
}

/* ------------------------------------------------ protocol due-diligence (audits) */
export interface Protocol {
  name: string;
  audits: number;
  category?: string;
  auditLinks: number;
  chains: number;
  listedAt: number | null; // unix seconds
  url?: string;
}
let protoCache: { at: number; map: Map<string, Protocol> } | null = null;
const PROTO_TTL_MS = 30 * 60 * 1000;

async function fetchProtocols(): Promise<Map<string, Protocol>> {
  if (protoCache && Date.now() - protoCache.at < PROTO_TTL_MS) return protoCache.map;
  const r = await fetch("https://api.llama.fi/protocols", { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`DefiLlama protocols ${r.status}`);
  const arr = (await r.json()) as Array<Record<string, unknown>>;
  const map = new Map<string, Protocol>();
  for (const x of arr) {
    const slug = String(x.slug ?? "");
    if (!slug) continue;
    map.set(slug, {
      name: String(x.name ?? slug),
      audits: Number(x.audits ?? 0) || 0,
      category: x.category ? String(x.category) : undefined,
      auditLinks: Array.isArray(x.audit_links) ? x.audit_links.length : 0,
      chains: Array.isArray(x.chains) ? x.chains.length : 0,
      listedAt: typeof x.listedAt === "number" ? x.listedAt : null,
      url: x.url ? String(x.url) : undefined,
    });
  }
  protoCache = { at: Date.now(), map };
  return map;
}

/** Real due-diligence from DefiLlama protocol metadata: audit status, category, age. */
export function assessProtocol(p: Pool, proto: Protocol | null): RwaDocSummary["legalRisk"] {
  const audits = proto?.audits ?? 0;
  if (p.outlier || audits === 0) return "high";
  if (audits >= 2 && p.tvlUsd > 1e8) return "low";
  return "medium";
}

export async function rwaDoc(id: string): Promise<RwaDocSummary | undefined> {
  const p = await pool(id);
  if (!p) return mockRwaDoc(id);
  let proto: Protocol | null = null;
  try {
    proto = (await fetchProtocols()).get(p.project) ?? null;
  } catch {
    /* fall back to pool-only heuristics */
  }

  const missing: string[] = [];
  if (proto) {
    if (proto.audits === 0) missing.push("No audit on record (DefiLlama)");
    else if (proto.auditLinks === 0) missing.push("Audit exists but reports not publicly linked");
    if (proto.listedAt && Date.now() / 1000 - proto.listedAt < 180 * 86400)
      missing.push("Limited operating history (listed < 6 months ago)");
  } else {
    missing.push("Protocol not indexed by DefiLlama");
  }
  if (!isRwa(p)) missing.push("No legal wrapper (permissionless DeFi protocol)");
  if (p.tvlUsd < 1e7) missing.push("Limited TVL / track record");
  if (p.outlier) missing.push("Yield flagged anomalous by DefiLlama");

  const audits = proto?.audits ?? 0;
  return {
    opportunityId: id,
    collateralType: `${p.symbol} (${p.exposure}-asset${p.stablecoin ? ", stablecoin" : ""})`,
    maturity: "Open-ended (on-chain)",
    counterparty: `${proto?.name ?? p.project} · ${proto?.category ?? "DeFi"} · ${audits} audit(s)${proto?.url ? ` · ${proto.url}` : ""}`,
    legalRisk: assessProtocol(p, proto),
    missingDisclosures: missing,
  };
}
