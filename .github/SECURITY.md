# Security Policy

Atlas Agent is a **non-custodial** application: every fund-moving action (the
usage fee, allocations, cspr.trade swaps) is signed by the user's own Casper
Wallet. The server never holds a user's private key and cannot move a user's
funds. It runs on **Casper Testnet** with test-only tokens.

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Instead:

- Use GitHub's **[Report a vulnerability](https://github.com/mertksk/atlas-agent/security/advisories/new)**
  (Security → Advisories) to open a private report, or
- email the maintainer at the address on the GitHub profile.

Please include: a description, reproduction steps, affected component
(`agent/`, `web/`, `services/`, or `contracts/`), and impact. We aim to
acknowledge within 72 hours.

## Scope & trust model

- **In scope:** the agent API (`agent/`), the dashboard (`web/`), the x402 data
  services (`services/`), and the Odra contracts (`contracts/`).
- **Funds safety:** all transfers require the connected wallet's signature — a
  server compromise cannot move a user's CSPR.
- **Known accepted limitation:** per-wallet sessions are keyed by the (public)
  wallet address with no proof-of-control on reads, so someone who knows a
  public key can view that session's off-chain pending recommendations (never
  move funds). A production deployment would add signed-challenge session auth.

## Handling of secrets

Secrets (API tokens, RPC keys, the agent's operating key) live only in the
server `.env` and are never committed. Secret scanning + push protection are
enabled on this repository.
