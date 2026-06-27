#!/usr/bin/env bash
# Deploy the EIP-3009 CEP-18 "X402" token (transfer_with_authorization) to Casper
# Testnet from a funded key. The deployer account receives the full initial supply
# and becomes the x402 PAYER. Prints the resulting package hash for .env
# (X402_ASSET_PACKAGE) once the deploy executes.
#
#   DEPLOYER_KEY_PATH=/path/to/secret_key.pem bash scripts/deploy-x402-token.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$ROOT/vendor/casper-x402/infra/local/deployer/Cep18X402.wasm"
NODE="${ODRA_CASPER_LIVENET_NODE_ADDRESS:-https://node.testnet.casper.network/rpc}"
CHAIN="${ODRA_CASPER_LIVENET_CHAIN_NAME:-casper-test}"
KEY="${DEPLOYER_KEY_PATH:-${ODRA_CASPER_LIVENET_SECRET_KEY_PATH:-}}"
NAME="${X402_TOKEN_NAME:-Casper X402 Token}"
SYMBOL="${X402_TOKEN_SYMBOL:-X402}"
DECIMALS="${X402_TOKEN_DECIMALS:-9}"
SUPPLY="${X402_TOKEN_SUPPLY:-1000000000000000}"   # 1e15 base units
GAS="${TOKEN_DEPLOY_GAS_MOTES:-700000000000}"     # 700 CSPR limit

[ -f "$WASM" ] || { echo "ERROR: $WASM missing — run scripts/setup-facilitator.sh first."; exit 1; }
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "ERROR: set DEPLOYER_KEY_PATH to a funded testnet PEM."; exit 1; }
command -v casper-client >/dev/null || { echo "ERROR: casper-client not found."; exit 1; }

echo "Deploying CEP-18 '$NAME' ($SYMBOL, $DECIMALS dp, supply $SUPPLY) on $CHAIN ..."
DH=$(casper-client put-deploy \
  --node-address "$NODE" --chain-name "$CHAIN" --secret-key "$KEY" --payment-amount "$GAS" \
  --session-path "$WASM" \
  --session-arg "name:string='$NAME'" \
  --session-arg "symbol:string='$SYMBOL'" \
  --session-arg "decimals:u8='$DECIMALS'" \
  --session-arg "initial_supply:u256='$SUPPLY'" \
  --session-arg "chain_id:string='casper:$CHAIN'" \
  --session-arg "odra_cfg_is_upgradable:bool='true'" \
  --session-arg "odra_cfg_is_upgrade:bool='false'" \
  --session-arg "odra_cfg_allow_key_override:bool='true'" \
  --session-arg "odra_cfg_package_hash_key_name:string='X402_package_hash'" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["deploy_hash"])')
echo "deploy_hash: $DH"
echo "https://testnet.cspr.live/deploy/$DH"

# Resolve the package hash from the deployer account's named keys (wait for execution).
echo "Waiting ~90s for execution, then resolving X402_package_hash ..."
sleep 90
SRH=$(curl -s -m10 -X POST "$NODE" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"chain_get_state_root_hash"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["state_root_hash"])')
ACCT=$(casper-client account-address --public-key "$(dirname "$KEY")/public_key_hex" 2>/dev/null || casper-client account-address --public-key "$KEY" 2>/dev/null || echo "")
if [ -n "$ACCT" ]; then
  curl -s -m12 -X POST "$NODE" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query_global_state\",\"params\":{\"state_identifier\":{\"StateRootHash\":\"$SRH\"},\"key\":\"$ACCT\",\"path\":[]}}" \
    | python3 -c 'import sys,json
sv=json.load(sys.stdin).get("result",{}).get("stored_value",{})
ent=sv.get("Account") or sv.get("AddressableEntity") or {}
nk=ent.get("named_keys",[])
hit=[k for k in nk if isinstance(nk,list) and k.get("name")=="X402_package_hash"]
print("X402_ASSET_PACKAGE=", (hit[0]["key"].replace("hash-","") if hit else "<not found yet; query the account named keys>"))'
else
  echo "Could not derive account; look up X402_package_hash under the deployer account on cspr.live."
fi
echo "Set X402_ASSET_PACKAGE (above) + X402_PAYER_KEY_PATH=$KEY in .env."
