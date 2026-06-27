/**
 * x402 payment middleware for the Atlas data services.
 *
 * Two settlement modes (chosen by whether FACILITATOR_URL is set):
 *
 *   FACILITATOR (real, on-chain): emit x402-v2 PaymentRequirements (CEP-18 token
 *   asset + EIP-712 domain `extra`), then POST /verify + /settle on the official
 *   Casper x402 facilitator, which submits a CEP-18 `transfer_with_authorization`
 *   deploy on Casper Testnet. Receipts carry the real deploy hash.
 *
 *   MOCK (default, zero-setup dev): emit x402-v1 requirements and ed25519-verify
 *   the payload in-process; receipt labeled "mode":"mock". No value moves.
 *
 * Protocol shape (both): 402 + PaymentRequirements -> client signs a payment
 * authorization -> retry with PAYMENT-SIGNATURE -> X-PAYMENT-RESPONSE receipt.
 */
import type { NextFunction, Request, Response } from "express";
import nacl from "tweetnacl";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  // v1 (mock) field:
  maxAmountRequired?: string; // motes
  // v2 (facilitator) field:
  amount?: string; // token base units
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export interface Settlement {
  success: boolean;
  mode: "facilitator" | "mock";
  network: string;
  transaction?: string; // deploy hash when settled on-chain
  payer?: string;
  amount?: string;
  errorReason?: string;
}

const NETWORK = process.env.X402_NETWORK ?? "casper:casper-test";
const FACILITATOR_URL = process.env.FACILITATOR_URL; // e.g. http://localhost:4022
// --- v2 / facilitator config (CEP-18 token + EIP-712 domain) ---
const ASSET_PACKAGE = (process.env.X402_ASSET_PACKAGE ?? "").replace(/^hash-/, "");
const PAYEE = process.env.X402_PAYEE ?? ""; // "00" + 64-hex account hash
const TOKEN_NAME = process.env.X402_TOKEN_NAME ?? "Casper X402 Token";
const TOKEN_VERSION = process.env.X402_TOKEN_VERSION ?? "1";
const TOKEN_DECIMALS = process.env.X402_TOKEN_DECIMALS ?? "9";
// --- v1 / mock config ---
const PAY_TO = process.env.X402_PAY_TO ?? "atlas-data-services-demo-payee";
const ASSET = process.env.X402_ASSET ?? "CSPR";

const FACILITATOR = Boolean(FACILITATOR_URL);

export const paymentLedger: Array<{
  resource: string;
  amount: string;
  payer: string;
  settlement: Settlement;
  at: string;
}> = [];

function requirementsFor(req: Request, priceMotes: string, description: string): PaymentRequirements {
  const resource = `${req.protocol}://${req.get("host")}${req.path}`;
  if (FACILITATOR) {
    return {
      scheme: "exact",
      network: NETWORK,
      amount: priceMotes,
      maxAmountRequired: priceMotes, // kept so v1-style clients can still read the price
      resource,
      description,
      mimeType: "application/json",
      payTo: PAYEE,
      maxTimeoutSeconds: 900,
      asset: ASSET_PACKAGE,
      extra: { name: TOKEN_NAME, version: TOKEN_VERSION, decimals: TOKEN_DECIMALS },
    };
  }
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: priceMotes,
    resource,
    description,
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: ASSET,
    extra: { provider: "atlas-data-services", version: "1" },
  };
}

function decodePayload(header: string): any | null {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/** Canonical bytes that the client signs in mock mode (sorted-key JSON). */
export function authorizationBytes(auth: Record<string, unknown>): Uint8Array {
  const canonical = JSON.stringify(auth, Object.keys(auth).sort());
  return new TextEncoder().encode(canonical);
}

async function settleViaFacilitator(
  paymentPayload: any,
  requirements: PaymentRequirements,
): Promise<Settlement> {
  try {
    const body = JSON.stringify({
      x402Version: paymentPayload?.x402Version ?? 2,
      paymentPayload,
      paymentRequirements: requirements,
    });
    const vRes = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const verify = (await vRes.json()) as { isValid?: boolean; invalidReason?: string; invalidMessage?: string };
    if (!verify.isValid) {
      return { success: false, mode: "facilitator", network: NETWORK, errorReason: verify.invalidReason ?? verify.invalidMessage ?? "invalid payment" };
    }
    const sRes = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const settle = (await sRes.json()) as { success?: boolean; transaction?: string; errorReason?: string; errorMessage?: string; payer?: string };
    return {
      success: Boolean(settle.success),
      mode: "facilitator",
      network: NETWORK,
      transaction: settle.transaction,
      payer: settle.payer ?? paymentPayload?.payload?.authorization?.from,
      amount: requirements.amount,
      errorReason: settle.errorReason ?? settle.errorMessage,
    };
  } catch (err) {
    return { success: false, mode: "facilitator", network: NETWORK, errorReason: `facilitator unreachable: ${String(err)}` };
  }
}

function settleMock(payload: any, requirements: PaymentRequirements): Settlement {
  const auth = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (!auth || !signature) return { success: false, mode: "mock", network: NETWORK, errorReason: "malformed payload" };
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validBefore) < now) return { success: false, mode: "mock", network: NETWORK, errorReason: "authorization expired" };
  if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired ?? "0")) {
    return { success: false, mode: "mock", network: NETWORK, errorReason: "amount below price" };
  }
  try {
    const ok = nacl.sign.detached.verify(authorizationBytes(auth), Buffer.from(signature, "hex"), Buffer.from(auth.from, "hex"));
    if (!ok) return { success: false, mode: "mock", network: NETWORK, errorReason: "bad signature" };
  } catch {
    return { success: false, mode: "mock", network: NETWORK, errorReason: "malformed signature/key" };
  }
  return {
    success: true,
    mode: "mock",
    network: NETWORK,
    transaction: `mock-${Buffer.from(nacl.hash(authorizationBytes(auth))).toString("hex").slice(0, 32)}`,
    payer: auth.from,
    amount: auth.value,
  };
}

/** Express middleware factory: protect a route behind an x402 price (in motes). */
export function paid(priceMotes: string, description: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const requirements = requirementsFor(req, priceMotes, description);
    const header = req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT");

    if (!header) {
      res.status(402).json({ x402Version: FACILITATOR ? 2 : 1, error: "PAYMENT-SIGNATURE header is required", accepts: [requirements] });
      return;
    }
    const payload = decodePayload(header);
    if (!payload) {
      res.status(402).json({ x402Version: FACILITATOR ? 2 : 1, error: "malformed PAYMENT-SIGNATURE payload", accepts: [requirements] });
      return;
    }

    const settlement = FACILITATOR ? await settleViaFacilitator(payload, requirements) : settleMock(payload, requirements);
    if (!settlement.success) {
      res.status(402).json({ x402Version: FACILITATOR ? 2 : 1, error: settlement.errorReason ?? "payment failed", accepts: [requirements] });
      return;
    }

    paymentLedger.push({
      resource: req.path,
      amount: requirements.amount ?? requirements.maxAmountRequired ?? "0",
      payer: settlement.payer ?? "unknown",
      settlement,
      at: new Date().toISOString(),
    });
    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settlement)).toString("base64"));
    next();
  };
}
