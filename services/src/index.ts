/**
 * Atlas Data Services — a tiny x402 marketplace the agent shops at.
 *
 *   GET /opportunities            free   — the marketplace listing
 *   GET /api/risk-score?id=       0.5 CSPR
 *   GET /api/liquidity?id=        0.3 CSPR
 *   GET /api/rwa-doc?id=          0.8 CSPR
 *   GET /api/market-signal        0.4 CSPR
 *   GET /payments                 free   — settlement ledger (for the dashboard)
 *
 * Every /api/* route speaks the x402 protocol: first call returns
 * `402 Payment Required` + PaymentRequirements; the agent signs a payment
 * authorization and retries with PAYMENT-SIGNATURE.
 */
import express from "express";
import { getLiquidity, getMarketSignal, getRisk, getRwaDoc, OPPORTUNITIES } from "./data.js";
import * as llama from "./defillama.js";
import * as marketSignal from "./marketsignal.js";
import { paid, paymentLedger } from "./x402.js";

// DATA_SOURCE=defillama → real protocol pools from yields.llama.fi (free).
// Anything else → the deterministic mock marketplace (used by tests/CI).
const USE_LLAMA = (process.env.DATA_SOURCE ?? "mock").toLowerCase() === "defillama";

const app = express();

// CORS allowlist (comma-separated origins; "*" allowed but discouraged).
// The agent reaches these endpoints server-side, so the browser only needs the
// dashboard origin. Defaults to the local dashboard.
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowAny = corsOrigins.includes("*");
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type, payment-signature, x-payment");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  next();
});

const MOTES = 1_000_000_000n;
const price = (cspr: number) => ((BigInt(Math.round(cspr * 1000)) * MOTES) / 1000n).toString();

app.get("/opportunities", async (_req, res) => {
  res.json(USE_LLAMA ? await llama.listOpportunities() : OPPORTUNITIES);
});

app.get("/api/risk-score", paid(price(0.5), "Protocol risk score with factor breakdown"), async (req, res) => {
  const id = String(req.query.id ?? "");
  const data = USE_LLAMA ? await llama.risk(id) : getRisk(id);
  if (!data) return res.status(404).json({ error: "unknown opportunity id" });
  res.json(data);
});

app.get("/api/liquidity", paid(price(0.3), "Liquidity depth, volume and withdrawal terms"), async (req, res) => {
  const id = String(req.query.id ?? "");
  const data = USE_LLAMA ? await llama.liquidity(id) : getLiquidity(id);
  if (!data) return res.status(404).json({ error: "unknown opportunity id" });
  res.json(data);
});

app.get("/api/rwa-doc", paid(price(0.8), "RWA legal document analysis and disclosure gaps"), async (req, res) => {
  const id = String(req.query.id ?? "");
  const data = USE_LLAMA ? await llama.rwaDoc(id) : getRwaDoc(id);
  if (!data) return res.status(404).json({ error: "unknown opportunity id" });
  res.json(data);
});

app.get("/api/market-signal", paid(price(0.4), "Market sentiment, volatility and news-risk summary"), async (_req, res) => {
  res.json(USE_LLAMA ? await marketSignal.get() : getMarketSignal());
});

app.get("/payments", (_req, res) => {
  res.json(paymentLedger);
});

const PORT = Number(process.env.SERVICES_PORT ?? 4021);
app.listen(PORT, () => {
  console.log(`[services] Atlas data services on :${PORT}`);
  console.log(`[services] data source: ${USE_LLAMA ? "DefiLlama (live yields.llama.fi)" : "mock marketplace"}`);
  console.log(`[services] x402 mode: ${process.env.FACILITATOR_URL ? `facilitator @ ${process.env.FACILITATOR_URL}` : "mock (set FACILITATOR_URL for on-chain settlement)"}`);
});
