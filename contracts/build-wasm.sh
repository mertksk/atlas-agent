#!/usr/bin/env bash
# Build each Odra contract to its own wasm artifact.
#
# cargo-odra 0.1.6 (the only version on crates.io) predates Odra 2.x's
# ODRA_MODULE/odra_module-cfg build flow and produced byte-identical wasm for
# every contract. This script does what a modern cargo-odra would: build the
# `atlas_contracts_build_contract` bin once per contract with ODRA_MODULE set,
# then strip + sign-extension-lower for Casper compatibility.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p wasm
TARGET=target/wasm32-unknown-unknown/release/atlas_contracts_build_contract.wasm

build_one() {
  local module="$1" out="wasm/$2"
  echo ">>> building $module -> $out"
  ODRA_MODULE="$module" cargo build --release --target wasm32-unknown-unknown \
    --bin atlas_contracts_build_contract
  cp "$TARGET" "$out"
  wasm-strip "$out"
  # Casper's wasm engine rejects sign-extension opcodes that modern rustc emits;
  # lower them to MVP instructions (binaryen >= 116), and -Oz to shrink install
  # gas cost. Older binaryen lacks the flag — fall back to -Oz only so the build
  # still completes (deploy artifacts MUST use a binaryen that supports it).
  if wasm-opt --help 2>&1 | grep -q -- '--signext-lowering'; then
    wasm-opt -Oz --signext-lowering "$out" -o "$out"
  else
    echo "    WARN: wasm-opt lacks --signext-lowering — running -Oz only (NOT deploy-ready)." >&2
    wasm-opt -Oz "$out" -o "$out"
  fi
  echo "    $(wc -c < "$out") bytes  $(shasum -a256 "$out" | cut -d' ' -f1)"
}

build_one TreasuryVault    TreasuryVault.wasm
build_one DecisionRegistry DecisionRegistry.wasm

echo ">>> artifacts:"
ls -la wasm/
if cmp -s wasm/TreasuryVault.wasm wasm/DecisionRegistry.wasm; then
  echo "ERROR: wasm files are identical — module selection failed" >&2
  exit 1
fi
echo ">>> OK: distinct contract wasm produced"
