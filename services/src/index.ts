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
import { paid, paymentLedger } from "./x402.js";

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

app.get("/opportunities", (_req, res) => {
  res.json(OPPORTUNITIES);
});

app.get("/api/risk-score", paid(price(0.5), "Protocol risk score with factor breakdown"), (req, res) => {
  const data = getRisk(String(req.query.id ?? ""));
  if (!data) return res.status(404).json({ error: "unknown opportunity id" });
  res.json(data);
});

app.get("/api/liquidity", paid(price(0.3), "Liquidity depth, volume and withdrawal terms"), (req, res) => {
  const data = getLiquidity(String(req.query.id ?? ""));
  if (!data) return res.status(404).json({ error: "unknown opportunity id" });
  res.json(data);
});

app.get("/api/rwa-doc", paid(price(0.8), "RWA legal document analysis and disclosure gaps"), (req, res) => {
  const data = getRwaDoc(String(req.query.id ?? ""));
  if (!data) return res.status(404).json({ error: "unknown opportunity id" });
  res.json(data);
});

app.get("/api/market-signal", paid(price(0.4), "Market sentiment, volatility and news-risk summary"), (_req, res) => {
  res.json(getMarketSignal());
});

app.get("/payments", (_req, res) => {
  res.json(paymentLedger);
});

const PORT = Number(process.env.SERVICES_PORT ?? 4021);
app.listen(PORT, () => {
  console.log(`[services] Atlas data services on :${PORT}`);
  console.log(`[services] x402 mode: ${process.env.FACILITATOR_URL ? `facilitator @ ${process.env.FACILITATOR_URL}` : "mock (set FACILITATOR_URL for on-chain settlement)"}`);
});
