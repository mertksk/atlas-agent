/**
 * Live market signal from CoinGecko (free, no key): real CSPR price action →
 * sentiment + realized 30d volatility. Enabled with DATA_SOURCE=defillama
 * (same live-data switch); falls back to the mock signal if the API is down.
 */
import { MarketSignal, getMarketSignal as mockSignal } from "./data.js";

const URL = "https://api.coingecko.com/api/v3/coins/casper-network/market_chart?vs_currency=usd&days=30&interval=daily";
const TTL_MS = 10 * 60 * 1000;

export function classifyVolatility(dailyStdPct: number): MarketSignal["volatility30d"] {
  return dailyStdPct < 2 ? "low" : dailyStdPct < 5 ? "elevated" : "high";
}
export function classifySentiment(change30dPct: number): MarketSignal["csprSentiment"] {
  return change30dPct < -8 ? "bearish" : change30dPct > 8 ? "bullish" : "neutral";
}

/** Pure: turn a daily close series into a real market signal. */
export function computeSignal(prices: number[], asOf: string): MarketSignal {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) if (prices[i - 1] > 0) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const stdPct = Math.sqrt(variance) * 100;
  const first = prices[0] || 1;
  const last = prices[prices.length - 1] || first;
  const chg30 = (last / first - 1) * 100;
  const wk = prices[Math.max(0, prices.length - 8)] || last;
  const chg7 = (last / wk - 1) * 100;
  const vol = classifyVolatility(stdPct);
  const sgn = (n: number) => (n >= 0 ? "+" : "");
  return {
    asOf,
    csprSentiment: classifySentiment(chg30),
    volatility30d: vol,
    newsRisk: [
      `CSPR ${sgn(chg30)}${chg30.toFixed(0)}% over 30d (${sgn(chg7)}${chg7.toFixed(0)}% 7d)`,
      `Realized volatility ${stdPct.toFixed(1)}%/day — ${vol}`,
      vol === "high" ? "Elevated volatility: size positions conservatively" : "No abnormal volatility in last 30d",
    ],
  };
}

let cache: { at: number; signal: MarketSignal } | null = null;

export async function get(): Promise<MarketSignal> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.signal;
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
    const j = (await r.json()) as { prices?: [number, number][] };
    const prices = (j.prices ?? []).map((p) => p[1]).filter((n) => typeof n === "number" && n > 0);
    if (prices.length < 5) throw new Error("CoinGecko returned too few points");
    const signal = computeSignal(prices, new Date().toISOString());
    cache = { at: Date.now(), signal };
    console.log(`[services] CoinGecko market signal: ${signal.csprSentiment}, vol ${signal.volatility30d}`);
    return signal;
  } catch (e) {
    console.warn(`[services] CoinGecko unavailable, using mock market signal: ${String(e)}`);
    return mockSignal();
  }
}
