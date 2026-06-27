/**
 * The opportunity marketplace + the data behind the four paid services.
 * Deterministic by design so demos are reproducible. Opportunity #5 is the
 * honeypot: it looks great on free data and falls apart once the agent pays
 * for risk + document analysis.
 */

export interface Opportunity {
  id: string;
  name: string;
  category: "RWA" | "DeFi";
  advertisedApyBps: number; // what the marketplace shows for free
  minAllocationCspr: number;
  strategyAddress: string; // testnet account that receives allocations in the demo
  blurb: string;
}

export const OPPORTUNITIES: Opportunity[] = [
  {
    id: "rwa-tbill-001",
    name: "Conservative RWA Treasury Vault",
    category: "RWA",
    advertisedApyBps: 480,
    minAllocationCspr: 5,
    strategyAddress: process.env.STRATEGY_ADDR_1 ?? "account-hash-demo-strategy-1",
    blurb: "Tokenized short-term treasury bills, weekly liquidity windows.",
  },
  {
    id: "rwa-credit-002",
    name: "High-Yield Private Credit Pool",
    category: "RWA",
    advertisedApyBps: 1150,
    minAllocationCspr: 10,
    strategyAddress: process.env.STRATEGY_ADDR_2 ?? "account-hash-demo-strategy-2",
    blurb: "Senior secured SME loans, 90-day lockup.",
  },
  {
    id: "rwa-invoice-003",
    name: "Tokenized Invoice Pool",
    category: "RWA",
    advertisedApyBps: 820,
    minAllocationCspr: 5,
    strategyAddress: process.env.STRATEGY_ADDR_3 ?? "account-hash-demo-strategy-3",
    blurb: "Factored B2B invoices, 30-60 day duration.",
  },
  {
    id: "defi-stable-004",
    name: "DeFi Stable Yield Pool",
    category: "DeFi",
    advertisedApyBps: 610,
    minAllocationCspr: 1,
    strategyAddress: process.env.STRATEGY_ADDR_4 ?? "account-hash-demo-strategy-4",
    blurb: "Blue-chip stablecoin LP with auto-compounding.",
  },
  {
    id: "defi-sus-005",
    name: "Quantum Yield Maximizer",
    category: "DeFi",
    advertisedApyBps: 9400,
    minAllocationCspr: 1,
    strategyAddress: process.env.STRATEGY_ADDR_5 ?? "account-hash-demo-strategy-5",
    blurb: "94% APY. Audited*. Limited slots. (*audit pending)",
  },
];

// ---------------------------------------------------------------- paid data

export interface RiskData {
  opportunityId: string;
  riskScore: number; // 0..100, higher = riskier
  riskLevel: "low" | "medium" | "high" | "critical";
  factors: string[];
}

const RISK: Record<string, RiskData> = {
  "rwa-tbill-001": {
    opportunityId: "rwa-tbill-001",
    riskScore: 22,
    riskLevel: "low",
    factors: ["Regulated custodian", "Daily NAV attestations", "Underlying: T-bills < 90d"],
  },
  "rwa-credit-002": {
    opportunityId: "rwa-credit-002",
    riskScore: 58,
    riskLevel: "medium",
    factors: ["Borrower concentration 31% top-5", "90-day lockup", "Senior secured, 1.4x collateral"],
  },
  "rwa-invoice-003": {
    opportunityId: "rwa-invoice-003",
    riskScore: 44,
    riskLevel: "medium",
    factors: ["Diversified obligors", "Credit insurance on 80% of book", "Short duration"],
  },
  "defi-stable-004": {
    opportunityId: "defi-stable-004",
    riskScore: 35,
    riskLevel: "medium",
    factors: ["Audited contracts (2 firms)", "Depeg tail risk", "Deep liquidity"],
  },
  "defi-sus-005": {
    opportunityId: "defi-sus-005",
    riskScore: 91,
    riskLevel: "critical",
    factors: ["Unverifiable collateral", "Anonymous team", "APY inconsistent with stated strategy", "No audit found"],
  },
};

export interface LiquidityData {
  opportunityId: string;
  withdrawalDelayDays: number;
  dailyVolumeUsd: number;
  liquidityRating: "deep" | "adequate" | "thin";
}

const LIQUIDITY: Record<string, LiquidityData> = {
  "rwa-tbill-001": { opportunityId: "rwa-tbill-001", withdrawalDelayDays: 7, dailyVolumeUsd: 2_400_000, liquidityRating: "deep" },
  "rwa-credit-002": { opportunityId: "rwa-credit-002", withdrawalDelayDays: 90, dailyVolumeUsd: 310_000, liquidityRating: "thin" },
  "rwa-invoice-003": { opportunityId: "rwa-invoice-003", withdrawalDelayDays: 30, dailyVolumeUsd: 720_000, liquidityRating: "adequate" },
  "defi-stable-004": { opportunityId: "defi-stable-004", withdrawalDelayDays: 0, dailyVolumeUsd: 5_100_000, liquidityRating: "deep" },
  "defi-sus-005": { opportunityId: "defi-sus-005", withdrawalDelayDays: 0, dailyVolumeUsd: 64_000, liquidityRating: "thin" },
};

export interface RwaDocSummary {
  opportunityId: string;
  collateralType: string;
  maturity: string;
  counterparty: string;
  legalRisk: "low" | "medium" | "high";
  missingDisclosures: string[];
}

const RWA_DOCS: Record<string, RwaDocSummary> = {
  "rwa-tbill-001": {
    opportunityId: "rwa-tbill-001",
    collateralType: "US T-bills (CUSIP-verified)",
    maturity: "Rolling 4-13 weeks",
    counterparty: "Regulated trust company (audited)",
    legalRisk: "low",
    missingDisclosures: [],
  },
  "rwa-credit-002": {
    opportunityId: "rwa-credit-002",
    collateralType: "Senior secured SME loans",
    maturity: "12-24 months, 90d redemption gate",
    counterparty: "Licensed credit fund",
    legalRisk: "medium",
    missingDisclosures: ["Per-borrower exposure table"],
  },
  "rwa-invoice-003": {
    opportunityId: "rwa-invoice-003",
    collateralType: "Factored B2B receivables",
    maturity: "30-60 days",
    counterparty: "Factoring platform, insured book",
    legalRisk: "medium",
    missingDisclosures: ["Insurance policy terms (summary only)"],
  },
  "defi-stable-004": {
    opportunityId: "defi-stable-004",
    collateralType: "Stablecoin LP positions",
    maturity: "Open-ended",
    counterparty: "On-chain protocol (no legal wrapper)",
    legalRisk: "medium",
    missingDisclosures: [],
  },
  "defi-sus-005": {
    opportunityId: "defi-sus-005",
    collateralType: "UNDISCLOSED — claims 'delta-neutral basis'",
    maturity: "Open-ended",
    counterparty: "Anonymous",
    legalRisk: "high",
    missingDisclosures: ["Audit report", "Collateral proof", "Team identity", "Strategy documentation"],
  },
};

export interface MarketSignal {
  asOf: string;
  csprSentiment: "bearish" | "neutral" | "bullish";
  volatility30d: "low" | "elevated" | "high";
  newsRisk: string[];
}

export function getRisk(id: string): RiskData | undefined {
  return RISK[id];
}
export function getLiquidity(id: string): LiquidityData | undefined {
  return LIQUIDITY[id];
}
export function getRwaDoc(id: string): RwaDocSummary | undefined {
  return RWA_DOCS[id];
}
export function getMarketSignal(): MarketSignal {
  return {
    asOf: new Date().toISOString(),
    csprSentiment: "neutral",
    volatility30d: "elevated",
    newsRisk: ["Regulatory consultation on tokenized funds (EU)", "No protocol-specific incidents in last 30d"],
  };
}
