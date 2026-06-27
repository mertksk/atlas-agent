//! Odra contracts build script.
//!
//! Reads the `ODRA_MODULE` env var and sets the `odra_module` cfg flag, which
//! selects which contract's `#[no_mangle]` wasm entry points compile into the
//! artifact. Build one contract at a time:
//!   ODRA_MODULE=TreasuryVault   cargo build --release --target wasm32-unknown-unknown --bin atlas_contracts_build_contract
//!   ODRA_MODULE=DecisionRegistry cargo build --release --target wasm32-unknown-unknown --bin atlas_contracts_build_contract
pub fn main() {
    odra_build::build();
}
