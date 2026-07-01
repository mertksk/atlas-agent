import { test } from "node:test";
import assert from "node:assert/strict";
import { riskScore, riskLevel, selectPools, toOpportunity, isRwa, assessProtocol, type Pool, type Protocol } from "../src/defillama.js";

const mk = (o: Partial<Pool>): Pool => ({
  pool: "id", chain: "Ethereum", project: "x", symbol: "TKN", tvlUsd: 1e8,
  apy: 5, apyBase: 5, apyReward: null, stablecoin: false, ilRisk: "no",
  exposure: "single", sigma: 0.05, outlier: false, predictions: { predictedClass: "Stable/Up" },
  ...o,
});

const proto = (o: Partial<Protocol>): Protocol => ({ name: "X", audits: 2, category: "Lending", auditLinks: 1, chains: 3, listedAt: null, ...o });

test("assessProtocol: unaudited or outlier => high; audited blue-chip => low", () => {
  assert.equal(assessProtocol(mk({ tvlUsd: 3e9 }), proto({ audits: 2 })), "low");
  assert.equal(assessProtocol(mk({ tvlUsd: 3e9 }), proto({ audits: 0 })), "high"); // no audit on record
  assert.equal(assessProtocol(mk({ outlier: true, tvlUsd: 3e9 }), proto({ audits: 3 })), "high"); // anomalous yield
  assert.equal(assessProtocol(mk({ tvlUsd: 5e6 }), proto({ audits: 2 })), "medium"); // audited but small
  assert.equal(assessProtocol(mk({ tvlUsd: 3e9 }), null), "high"); // unknown protocol
});

test("riskScore: blue-chip stablecoin is low, anomalous high-APY outlier is critical", () => {
  const blue = riskScore(mk({ stablecoin: true, apy: 4, tvlUsd: 2e9, sigma: 0.02 }));
  const honeypot = riskScore(mk({ apy: 140, tvlUsd: 200_000, outlier: true, ilRisk: "yes", exposure: "multi", sigma: 0.9 }));
  assert.ok(blue < 30, `blue chip should be low risk, got ${blue}`);
  assert.ok(honeypot > 80, `outlier honeypot should be critical, got ${honeypot}`);
  assert.ok(honeypot > blue);
});

test("riskScore stays within 1..100 and riskLevel buckets line up", () => {
  for (const apy of [0, 5, 30, 90, 500]) {
    const s = riskScore(mk({ apy, outlier: apy > 100 }));
    assert.ok(s >= 1 && s <= 100);
  }
  assert.equal(riskLevel(10), "low");
  assert.equal(riskLevel(40), "medium");
  assert.equal(riskLevel(70), "high");
  assert.equal(riskLevel(95), "critical");
});

test("toOpportunity maps fields and tags known RWA projects", () => {
  const o = toOpportunity(mk({ pool: "p1", project: "ondo-finance", symbol: "USDY", apy: 5.2, chain: "Ethereum", tvlUsd: 5e8 }), 3);
  assert.equal(o.id, "p1");
  assert.equal(o.category, "RWA");
  assert.equal(o.advertisedApyBps, 520);
  assert.match(o.name, /ondo-finance/);
  assert.ok(o.strategyAddress.length > 0);
  assert.equal(isRwa(mk({ project: "uniswap" })), false);
});

test("selectPools curates a bounded, deduped spread including a spicy pool", () => {
  const pools: Pool[] = [
    mk({ pool: "stable1", stablecoin: true, apy: 4, tvlUsd: 3e9 }),
    mk({ pool: "stable2", stablecoin: true, apy: 6, tvlUsd: 1e9 }),
    mk({ pool: "rwa1", project: "maple", apy: 9, tvlUsd: 4e8 }),
    mk({ pool: "mid1", apy: 22, tvlUsd: 8e7 }),
    mk({ pool: "spicy1", apy: 120, tvlUsd: 300_000, outlier: true }),
    mk({ pool: "dust", apy: 5, tvlUsd: 1000 }), // filtered out (tvl too small)
  ];
  const picked = selectPools(pools);
  const ids = picked.map((p) => p.pool);
  assert.ok(picked.length <= 7 && picked.length >= 4);
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
  assert.ok(ids.includes("spicy1"), "should include the high-APY outlier");
  assert.ok(!ids.includes("dust"), "should drop sub-threshold TVL pools");
});
