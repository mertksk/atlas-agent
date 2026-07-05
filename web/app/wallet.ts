"use client";

/**
 * Casper Wallet (browser extension) integration — non-custodial.
 * The browser only connects and signs; the server builds & submits deploys
 * (see /api/wallet/*), so the user's key never leaves their wallet and no
 * server key touches the user's funds.
 *
 * Provider API: window.CasperWalletProvider() → { requestConnection,
 * getActivePublicKey, isConnected, disconnectFromSite, sign(deployJson, key) }.
 * Events are CustomEvents named by window.CasperWalletEventTypes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Provider = {
  requestConnection: () => Promise<boolean>;
  getActivePublicKey: () => Promise<string>;
  isConnected: () => Promise<boolean>;
  disconnectFromSite: () => Promise<boolean>;
  sign: (deployJson: string, publicKey: string) => Promise<{ cancelled?: boolean; signature?: Uint8Array | number[]; signatureHex?: string }>;
};

function provider(): Provider | null {
  if (typeof window === "undefined") return null;
  const f = (window as any).CasperWalletProvider;
  try {
    return typeof f === "function" ? f() : null;
  } catch {
    return null;
  }
}

export function walletInstalled(): boolean {
  return provider() != null;
}

export async function connectWallet(): Promise<string> {
  const p = provider();
  if (!p) throw new Error("no-wallet");
  const ok = await p.requestConnection();
  if (!ok) throw new Error("rejected");
  return p.getActivePublicKey();
}

export async function currentKey(): Promise<string | null> {
  const p = provider();
  if (!p) return null;
  try {
    if (!(await p.isConnected())) return null;
    return await p.getActivePublicKey();
  } catch {
    return null;
  }
}

export async function disconnectWallet(): Promise<void> {
  const p = provider();
  if (p) {
    try {
      await p.disconnectFromSite();
    } catch {
      /* ignore */
    }
  }
}

/** Ask the wallet to sign a server-built deploy; returns the RAW hex signature
 *  (no 0x, lowercase). The server normalizes/tags it before setSignature — the
 *  Casper Wallet may return the raw 64-byte sig or an already-tagged 65-byte one. */
export async function signDeploy(deployJson: string, publicKey: string): Promise<string> {
  const p = provider();
  if (!p) throw new Error("no-wallet");
  const res = await p.sign(deployJson, publicKey);
  if (res.cancelled) throw new Error("cancelled");
  let hex: string | null = null;
  if (res.signatureHex) {
    hex = res.signatureHex;
  } else if (res.signature) {
    const bytes = res.signature instanceof Uint8Array ? res.signature : Uint8Array.from(res.signature as number[]);
    hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (!hex) throw new Error("no-signature");
  return hex.replace(/^0x/i, "").toLowerCase();
}

/** Read an account's CSPR balance via the agent's server-side proxy (cspr.live
 *  blocks cross-origin browser reads, so we go through our own API). */
export async function walletBalanceCspr(publicKeyHex: string, agentBase = ""): Promise<number | null> {
  try {
    const r = await fetch(`${agentBase}/api/wallet/balance?key=${publicKeyHex}`, {
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { balanceCspr?: number | null };
    return j.balanceCspr ?? null;
  } catch {
    return null;
  }
}

/** Subscribe to wallet events (active-key change / disconnect). Returns an unsubscribe fn. */
export function subscribeWallet(cb: { onKey?: (k: string | null) => void; onDisconnect?: () => void }): () => void {
  if (typeof window === "undefined") return () => undefined;
  const types = (window as any).CasperWalletEventTypes ?? {};
  const detailKey = (e: Event): string | null => {
    try {
      const d = JSON.parse((e as CustomEvent).detail);
      return d.activeKey ?? null;
    } catch {
      return null;
    }
  };
  const akEvt = types.ActiveKeyChanged ?? "casper-wallet:activeKeyChanged";
  const cnEvt = types.Connected ?? "casper-wallet:connected";
  const dcEvt = types.Disconnected ?? "casper-wallet:disconnected";
  const lkEvt = types.Locked ?? "casper-wallet:locked";
  const onKey = (e: Event) => cb.onKey?.(detailKey(e));
  const onDc = () => cb.onDisconnect?.();
  window.addEventListener(akEvt, onKey);
  window.addEventListener(cnEvt, onKey);
  window.addEventListener(dcEvt, onDc);
  window.addEventListener(lkEvt, onDc);
  return () => {
    window.removeEventListener(akEvt, onKey);
    window.removeEventListener(cnEvt, onKey);
    window.removeEventListener(dcEvt, onDc);
    window.removeEventListener(lkEvt, onDc);
  };
}

/** Short display form of a public key. */
export const shortKey = (k: string) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);
