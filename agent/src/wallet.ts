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

/** Build the unsigned usage-fee deploy: `from` (the connected wallet) → fee wallet. */
export async function buildFeeDeploy(fromPublicKeyHex: string): Promise<{ deploy: unknown; amountCspr: number }> {
  if (!config.feeRecipientHex) throw new Error("FEE_RECIPIENT_HEX not configured on the server");
  if (!/^0[12][0-9a-f]{64,}$/i.test(fromPublicKeyHex)) throw new Error("from is not a valid Casper public key hex");
  const s = await sdk();
  const motes = BigInt(Math.round(config.feeCspr * 1e9)).toString();
  const deploy = s.makeCsprTransferDeploy({
    senderPublicKeyHex: fromPublicKeyHex,
    recipientPublicKeyHex: config.feeRecipientHex,
    transferAmount: motes,
    chainName: config.casperChainName,
  });
  // Deploy.toJSON is a STATIC serializer in this SDK (not an instance method).
  return { deploy: s.Deploy.toJSON(deploy), amountCspr: config.feeCspr };
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

  let sig = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  // 64-byte raw signature (128 hex chars) → prepend the algorithm tag (01/02).
  if (sig.length === 128) sig = publicKeyHex.slice(0, 2).toLowerCase() + sig;
  const sigBytes = Uint8Array.from(Buffer.from(sig, "hex"));

  const signed = s.Deploy.setSignature(deploy, sigBytes, pub);

  const rpc = new s.RpcClient(new s.HttpHandler(config.casperRpcUrl));
  const res: any = await rpc.putDeploy(signed);
  const deployHash: string =
    res?.deployHash?.toHex?.() ??
    (typeof res?.deployHash === "string" ? res.deployHash : null) ??
    signed?.hash?.toHex?.() ??
    "";
  return { deployHash };
}
