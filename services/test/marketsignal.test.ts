import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVolatility, classifySentiment, computeSignal } from "../src/marketsignal.js";

test("volatility + sentiment classifiers bucket correctly", () => {
  assert.equal(classifyVolatility(1.2), "low");
  assert.equal(classifyVolatility(3.5), "elevated");
  assert.equal(classifyVolatility(7), "high");
  assert.equal(classifySentiment(-20), "bearish");
  assert.equal(classifySentiment(0), "neutral");
  assert.equal(classifySentiment(15), "bullish");
});

test("computeSignal: steady decline reads bearish; flat reads neutral/low-vol", () => {
  const decline = Array.from({ length: 31 }, (_, i) => 1 - i * 0.01); // -30% drift
  const s1 = computeSignal(decline, "2026-01-01T00:00:00Z");
  assert.equal(s1.csprSentiment, "bearish");
  assert.equal(s1.newsRisk.length, 3);

  const flat = Array.from({ length: 31 }, () => 1.0);
  const s2 = computeSignal(flat, "2026-01-01T00:00:00Z");
  assert.equal(s2.csprSentiment, "neutral");
  assert.equal(s2.volatility30d, "low");
});
