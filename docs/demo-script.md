# Atlas — 3-minute demo script

Target: a tight screen recording for the DoraHacks submission. Two windows: the
dashboard (full screen) and a small terminal. Contracts deployed beforehand so
the run is live (`DRY_RUN=false`); rehearse once in dry-run.

## Setup (before recording)

```bash
# contracts deployed, vault funded with 100 CSPR, agent set as recorder
npm run services                                   # :4021
DRY_RUN=false VAULT_ADDRESS=… REGISTRY_ADDRESS=… npm run agent   # :4030
cd web && npm run dev                              # :3000
```

Have testnet.cspr.live open on the DecisionRegistry contract in a background tab.

## Beats

**0:00 – 0:25 — The problem.**
Dashboard visible, idle. Voiceover: "DeFi agents today decide on free, unverified
data, and nothing stops them from exceeding their mandate. Atlas is a treasury
agent for Casper that fixes both: it *pays* for its evidence over x402, and its
policy is enforced by the vault contract itself — not by the prompt."

**0:25 – 0:40 — The marketplace.**
Scroll the five opportunity cards. Pause on the last one: "Five opportunities.
One of them advertises 94% APY. Let's see if Atlas takes the bait."

**0:40 – 1:40 — Run analysis.**
Click **Run analysis**. Narrate the ledger as entries post:
- "First economic decision: what is knowledge worth? It reads prices straight
  off the 402 responses and screens all five with paid risk scores."
- "Best risk-adjusted candidate gets the deep dive — liquidity terms and an RWA
  document analysis. Exactly 4 CSPR of evidence, the full budget, nothing more."
- Point at the honeypot card flipping to REJECT: "The 94% pool? Risk 91 —
  unverifiable collateral, anonymous team, no audit. Rejected, with the receipt
  for the data that killed it."
- Point at the vault card: "And the boring T-bill vault wins: 21 CSPR at 90%
  confidence."

**1:40 – 2:10 — Human in the loop.**
The brass approval banner is showing (threshold set below 21 for the demo).
"Above the approval threshold, Atlas doesn't act — it asks." Click **Approve**.
"Approved. The vault contract re-checks every limit on-chain before a single
mote moves — even a compromised agent can't exceed the mandate."

**2:10 – 2:40 — Proof on Casper.**
Switch to testnet.cspr.live: show the `record_decision` deploys (one per
opportunity, including the rejection) and the `execute_allocation` transfer.
"Every decision — including the ones *not* to invest — is on the
DecisionRegistry. The audit trail is the product."

**2:40 – 3:00 — MCP + close.**
Quick cut to Claude Desktop: ask "Run a treasury analysis and summarize what
Atlas decided." Tool call fires, summary appears. "Any model can operate Atlas
over MCP. An autonomous treasury that spends money intelligently *before*
investing money intelligently — on Casper. Thanks."

## Fallbacks

- If a live deploy is slow on camera, cut to a pre-recorded cspr.live shot.
- If the LLM key is flaky, run deterministic — the chip says so honestly and
  the story is identical.
- Approval threshold for the demo: `POLICY_APPROVAL_THRESHOLD=20 npm run agent`.
