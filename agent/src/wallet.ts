/**
 * Non-custodial wallet flow for the monetized dApp.
 *
 * The connected Casper Wallet (in the user's browser) is the ONLY signer of the
 * user's funds. The server never holds the user's key: it merely
 *   1. builds an UNSIGNED native-CSPR transfer deploy (buildFeeDeploy), and
 *   2. attaches the browser-produced signature and forwards it to the node
 *      (submitSignedDeploy).
 * This is how the "analysis fee" (criterion 3) is charged from the connected
 * wallet to a fee wallet we designate, with the user signing every move.
 *
 * All casper-js-sdk classes are resolved via a robust dynamic import (mirrors
 * x402Client) because the package's class exports live under .default and tsx
 * may double-wrap them.
 */
import { config } from "./config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let sdkCache: any = null;
async function sdk(): Promise<any> {
  if (sdkCache) return sdkCache;
  const mod: any = await import("casper-js-sdk");
  let s: any = mod.default ?? mod;
  if (!s.makeCsprTransferDeploy && s.default) s = s.default;
  if (!s.makeCsprTransferDeploy && mod.makeCsprTransferDeploy) s = mod;
  sdkCache = s;
  return s;
}

export function feeInfo(): { feeRecipientHex: string; feeCspr: number; chainName: string; configured: boolean } {
  return {
    feeRecipientHex: config.feeRecipientHex,
    feeCspr: config.feeCspr,
    chainName: config.casperChainName,
    configured: Boolean(config.feeRecipientHex),
  };
}

const NATIVE_TRANSFER_MIN_MOTES = 2_500_000_000n; // chainspec native_transfer_minimum_motes (2.5 CSPR)

/** Build an unsigned native CSPR transfer deploy from a wallet to a recipient. */
export async function buildTransferDeploy(
  fromPublicKeyHex: string,
  toPublicKeyHex: string,
  amountCspr: number,
): Promise<{ deploy: unknown; amountCspr: number }> {
  if (!/^0[12][0-9a-f]{64,}$/i.test(fromPublicKeyHex)) throw new Error("from is not a valid Casper public key hex");
  if (!/^0[12][0-9a-f]{64,}$/i.test(toPublicKeyHex)) throw new Error("recipient is not a valid Casper public key hex");
  const s = await sdk();
  const motesBig = BigInt(Math.round(amountCspr * 1e9));
  if (motesBig < NATIVE_TRANSFER_MIN_MOTES) {
    throw new Error(`amount ${amountCspr} CSPR is below the Casper native-transfer minimum of 2.5 CSPR`);
  }
  const deploy = s.makeCsprTransferDeploy({
    senderPublicKeyHex: fromPublicKeyHex,
    recipientPublicKeyHex: toPublicKeyHex,
    transferAmount: motesBig.toString(),
    chainName: config.casperChainName,
  });
  // Deploy.toJSON is a STATIC serializer in this SDK (not an instance method).
  return { deploy: s.Deploy.toJSON(deploy), amountCspr };
}

/** Compute a Casper account-hash ("account-hash-<hex>") from a public key hex —
 *  used as the WUSDC swap recipient so the user receives the token. */
export async function accountHashOf(pubKeyHex: string): Promise<string> {
  const s = await sdk();
  const pub = s.PublicKey.newPublicKey(pubKeyHex);
  const hex = String(pub.accountHash().toHex()).replace(/^account-hash-/i, "").toLowerCase();
  return `account-hash-${hex}`;
}

/** Build the unsigned usage-fee deploy: `from` (the connected wallet) → fee wallet. */
export async function buildFeeDeploy(fromPublicKeyHex: string): Promise<{ deploy: unknown; amountCspr: number }> {
  if (!config.feeRecipientHex) throw new Error("FEE_RECIPIENT_HEX not configured on the server");
  return buildTransferDeploy(fromPublicKeyHex, config.feeRecipientHex, config.feeCspr);
}

/**
 * Attach the browser wallet's signature to a previously-built deploy and submit
 * it to the Casper node. Returns the deploy hash. The signature from Casper
 * Wallet is the raw 64-byte Ed25519/Secp256k1 signature; we prepend the key
 * algorithm tag (matching the public key's first byte) when needed.
 */
export async function submitSignedDeploy(
  deployJson: unknown,
  publicKeyHex: string,
  signatureHex: string,
): Promise<{ deployHash: string }> {
  const s = await sdk();
  const deploy = s.Deploy.fromJSON(deployJson);
  const pub = s.PublicKey.newPublicKey(publicKeyHex);

  // A valid on-chain approval signature is 65 bytes: 1 algorithm-tag byte
  // (01 ed25519 / 02 secp256k1, matching the signer's key) + the 64-byte raw
  // signature. Deploy.setSignature stores the bytes verbatim (it does NOT add a
  // tag), and the Casper Wallet may return either the raw 64-byte signature or
  // an already-tagged 65-byte one — so normalize TOTALLY to exactly one correct
  // tag. (A brittle "128-only" check misses the already-tagged case.)
  const tag = publicKeyHex.slice(0, 2).toLowerCase();
  let sig = signatureHex.replace(/^0x/i, "").toLowerCase();
  if (sig.length === 130 && (sig.startsWith("01") || sig.startsWith("02"))) {
    sig = tag + sig.slice(2); // already tagged → re-tag to this key's algorithm
  } else if (sig.length === 128) {
    sig = tag + sig; // raw 64-byte → prepend the tag
  } else {
    throw new Error(`unexpected signature length: ${sig.length} hex chars`);
  }
  const sigBytes = Uint8Array.from(Buffer.from(sig, "hex"));

  const signed = s.Deploy.setSignature(deploy, sigBytes, pub);

  // Validate locally so a tag/hash mismatch surfaces as a precise message
  // instead of an opaque RPC -32008 "Invalid Deploy".
  try {
    signed.validate();
  } catch (e) {
    throw new Error(`deploy failed local validation: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rpc = new s.RpcClient(new s.HttpHandler(config.casperRpcUrl));
  const res: any = await rpc.putDeploy(signed);
  const deployHash: string =
    res?.deployHash?.toHex?.() ??
    (typeof res?.deployHash === "string" ? res.deployHash : null) ??
    signed?.hash?.toHex?.() ??
    "";
  return { deployHash };
}
