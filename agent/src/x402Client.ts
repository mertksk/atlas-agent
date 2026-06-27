/**
 * x402 client — how the agent BUYS data.
 *
 * fetchPaid() performs the protocol dance:
 *   request -> 402 + PaymentRequirements -> sign authorization -> retry with
 *   PAYMENT-SIGNATURE -> 200 + X-PAYMENT-RESPONSE settlement receipt.
 *
 * Two payment modes, auto-detected from the 402 PaymentRequirements:
 *   - v2 / facilitator (real): requirements carry a CEP-18 token `asset` (64-hex
 *     package hash) + EIP-712 domain `extra`. The agent signs an EIP-712
 *     `TransferWithAuthorization` digest with its Casper payer key (casper-js-sdk
 *     + @casper-ecosystem/casper-eip-712); the services settle it on-chain via the
 *     facilitator (CEP-18 transfer_with_authorization).
 *   - v1 / mock (default): ephemeral ed25519 over canonical JSON, verified
 *     in-process by the services. Zero setup, fully offline.
 */
import nacl from "tweetnacl";
import { config } from "./config.js";

export interface Signer {
  publicKeyHex(): string;
  sign(bytes: Uint8Array): Promise<string>; // hex signature
}

export class DevSigner implements Signer {
  private readonly keypair = nacl.sign.keyPair();
  publicKeyHex(): string {
    return Buffer.from(this.keypair.publicKey).toString("hex");
  }
  async sign(bytes: Uint8Array): Promise<string> {
    return Buffer.from(nacl.sign.detached(bytes, this.keypair.secretKey)).toString("hex");
  }
}

interface Requirements {
  scheme: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  payTo: string;
  resource: string;
  description: string;
  asset?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface PaidResponse<T> {
  data: T;
  paid: boolean;
  amountMotes: string;
  settlementTx?: string;
  settlementMode?: "facilitator" | "mock";
}

function authorizationBytes(auth: Record<string, unknown>): Uint8Array {
  const canonical = JSON.stringify(auth, Object.keys(auth).sort());
  return new TextEncoder().encode(canonical);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** True when the 402 requirements describe a real CEP-18 / EIP-712 payment. */
function isV2(req: Requirements): boolean {
  return Boolean(req.amount && req.asset && /^[0-9a-f]{64}$/i.test(req.asset) && req.extra && typeof req.extra.name === "string");
}

/**
 * Lazy Casper EIP-712 signer (only loaded for real/facilitator payments).
 * Mirrors @make-software/casper-x402's ExactCasperScheme exactly, reproduced
 * with the published casper-js-sdk + @casper-ecosystem/casper-eip-712.
 */
let casperSigner:
  | { accountAddress: string; publicKey: string; signEIP712: (d: Uint8Array) => Promise<Uint8Array> }
  | null = null;

async function getCasperSigner() {
  if (casperSigner) return casperSigner;
  if (!config.x402PayerKeyPath) throw new Error("X402_PAYER_KEY_PATH not set — required for facilitator-mode x402 payments");
  const { readFileSync } = await import("node:fs");
  // casper-js-sdk's class exports live under .default (and tsx may double-wrap);
  // resolve them robustly across node/tsx interop.
  const mod: any = await import("casper-js-sdk");
  let sdk: any = mod.default ?? mod;
  if (!sdk.KeyAlgorithm && sdk.default) sdk = sdk.default;
  if (!sdk.KeyAlgorithm && mod.KeyAlgorithm) sdk = mod;
  const { KeyAlgorithm, PrivateKey } = sdk;
  const algo = config.x402PayerKeyAlgo === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const pk = PrivateKey.fromPem(readFileSync(config.x402PayerKeyPath, "utf8"), algo);
  casperSigner = {
    accountAddress: "00" + pk.publicKey.accountHash().toHex(),
    publicKey: pk.publicKey.toHex(),
    signEIP712: async (digest: Uint8Array) => pk.signAndAddAlgorithmBytes(digest),
  };
  return casperSigner;
}

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function buildV2Payload(req: Requirements): Promise<unknown> {
  const { buildDomain, CASPER_DOMAIN_TYPES, hashTypedData } = await import("@casper-ecosystem/casper-eip-712");
  const signer = await getCasperSigner();
  const name = String(req.extra?.name);
  const version = String(req.extra?.version ?? "1");
  const asset = req.asset as string;
  const amount = (req.amount ?? req.maxAmountRequired) as string;

  const domain = buildDomain(name, version, req.network, "0x" + asset);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600;
  const validBefore = now + (req.maxTimeoutSeconds ?? 900);
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  const message = {
    from: "0x" + signer.accountAddress,
    to: "0x" + req.payTo,
    value: BigInt(amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: "0x" + hex(nonce),
  };
  const digest = hashTypedData(domain, TRANSFER_TYPES, "TransferWithAuthorization", message, { domainTypes: CASPER_DOMAIN_TYPES });
  const signature = await signer.signEIP712(digest);

  return {
    x402Version: 2,
    scheme: "exact",
    network: req.network,
    accepted: req,
    payload: {
      signature: hex(signature),
      publicKey: signer.publicKey,
      authorization: {
        from: signer.accountAddress,
        to: req.payTo,
        value: amount,
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce: hex(nonce),
      },
    },
  };
}

export class X402Client {
  constructor(private readonly signer: Signer = new DevSigner()) {}

  /** GET a possibly-paid resource; on 402, pay (if within `maxMotes`) and retry once. */
  async fetchPaid<T>(url: string, maxMotes: bigint): Promise<PaidResponse<T>> {
    const first = await fetch(url);
    if (first.status !== 402) {
      if (!first.ok) throw new Error(`${url} -> ${first.status}`);
      return { data: (await first.json()) as T, paid: false, amountMotes: "0" };
    }

    const body = (await first.json()) as { accepts?: Requirements[] };
    const req = body.accepts?.[0];
    if (!req) throw new Error(`402 without PaymentRequirements from ${url}`);
    const priceStr = req.amount ?? req.maxAmountRequired ?? "0";
    const amount = BigInt(priceStr);
    if (amount > maxMotes) throw new PriceAboveBudgetError(url, priceStr);

    let payload: unknown;
    if (isV2(req)) {
      payload = await buildV2Payload(req);
    } else {
      const authorization = {
        from: this.signer.publicKeyHex(),
        to: req.payTo,
        value: priceStr,
        validAfter: 0,
        validBefore: Math.floor(Date.now() / 1000) + 60,
        nonce: Buffer.from(nacl.randomBytes(16)).toString("hex"),
      };
      const signature = await this.signer.sign(authorizationBytes(authorization));
      payload = { x402Version: 1, scheme: "exact", network: req.network, payload: { authorization, signature } };
    }

    const second = await fetch(url, {
      headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") },
    });
    if (!second.ok) {
      const err = await second.text();
      throw new Error(`payment rejected by ${url}: ${second.status} ${err}`);
    }

    let settlementTx: string | undefined;
    let settlementMode: "facilitator" | "mock" | undefined;
    const receiptHeader = second.headers.get("X-PAYMENT-RESPONSE");
    if (receiptHeader) {
      try {
        const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf-8"));
        settlementTx = receipt.transaction;
        settlementMode = receipt.mode;
      } catch {
        /* receipt is informational */
      }
    }
    return { data: (await second.json()) as T, paid: true, amountMotes: priceStr, settlementTx, settlementMode };
  }

  /** Ask the price of a resource without paying (one probe request). */
  async quote(url: string): Promise<bigint> {
    const res = await fetch(url);
    if (res.status !== 402) return 0n;
    const body = (await res.json()) as { accepts?: Requirements[] };
    const r = body.accepts?.[0];
    return BigInt(r?.amount ?? r?.maxAmountRequired ?? "0");
  }
}

export class PriceAboveBudgetError extends Error {
  constructor(public readonly url: string, public readonly priceMotes: string) {
    super(`price ${priceMotes} motes exceeds remaining data budget for ${url}`);
  }
}
