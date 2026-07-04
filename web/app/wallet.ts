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

/** Ask the wallet to sign a server-built deploy; returns the hex signature. */
export async function signDeploy(deployJson: string, publicKey: string): Promise<string> {
  const p = provider();
  if (!p) throw new Error("no-wallet");
  const res = await p.sign(deployJson, publicKey);
  if (res.cancelled) throw new Error("cancelled");
  if (res.signatureHex) return res.signatureHex;
  if (res.signature) {
    const bytes = res.signature instanceof Uint8Array ? res.signature : Uint8Array.from(res.signature as number[]);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("no-signature");
}

/** Read an account's CSPR balance from the public cspr.live testnet API. */
export async function walletBalanceCspr(publicKeyHex: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.testnet.cspr.live/accounts/${publicKeyHex}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return 0; // 404 = unfunded account
    const j = (await r.json()) as { data?: { balance?: string } };
    return Number(j.data?.balance ?? 0) / 1e9;
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
