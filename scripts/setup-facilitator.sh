#!/usr/bin/env bash
# Reproducibly fetch + build the official Casper x402 facilitator into vendor/,
# pinned to a known-good commit, and write its .env (fee-payer key + testnet RPC).
# After this, `npm run stack` supervises it under pm2 on :4022.
#
# Required (funded testnet PEM that pays settlement gas):
#   FACILITATOR_KEY_PATH=/path/to/secret_key.pem   (falls back to
#   ODRA_CASPER_LIVENET_SECRET_KEY_PATH from your environment / .env)
set -euo pipefail

PIN="14c364bb30838003302074423b7500b4360df889"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/vendor/casper-x402"
RPC="${ODRA_CASPER_LIVENET_NODE_ADDRESS:-https://node.testnet.casper.network/rpc}"
KEY="${FACILITATOR_KEY_PATH:-${ODRA_CASPER_LIVENET_SECRET_KEY_PATH:-}}"
ALGO="${FACILITATOR_KEY_ALGO:-ed25519}"

# bundled corepack is too old to fetch pnpm reliably; use a direct global install.
command -v pnpm >/dev/null 2>&1 || npm i -g pnpm@10

if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$ROOT/vendor"
  git clone https://github.com/make-software/casper-x402.git "$DIR"
fi
cd "$DIR"
git fetch origin "$PIN" 2>/dev/null || git fetch origin
git checkout -q "$PIN"

cd "$DIR/js"
pnpm install --config.manage-package-manager-versions=false
pnpm build

if [ -n "$KEY" ] && [ -f "$KEY" ]; then
  PEM=$(awk 'BEGIN{ORS="\\n"}{print}' "$KEY")
  cat > "$DIR/js/.env" <<EOF
LOG_LEVEL=info
PORT=4022
CASPER_NETWORKS=casper:casper-test
TRANSACTION_PAYMENT_MOTES=7000000000
RPCURL_CASPER_CASPER_TEST=$RPC
SECRET_KEY_ALGO_CASPER_CASPER_TEST=$ALGO
SECRET_KEY_PEM_CASPER_CASPER_TEST="$PEM"
EOF
  echo "wrote $DIR/js/.env (fee-payer from $KEY)"
else
  echo "WARN: no key found. Set FACILITATOR_KEY_PATH to a funded testnet PEM and re-run,"
  echo "      or write vendor/casper-x402/js/.env manually (see .env.testnet in the repo)."
fi
echo "Facilitator ready. Run 'npm run stack' to start it under pm2 on :4022."
