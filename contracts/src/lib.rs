#![doc = "Atlas Agent — on-chain treasury, policy enforcement and decision audit trail for Casper."]
// Odra wasm contracts run no_std: odra_casper_wasm_env supplies the panic
// handler and global allocator. Modern `wasm32-unknown-unknown` now ships std,
// so without this the crate links std and collides (E0152 duplicate panic_impl).
// Native builds (unit tests, the livenet CLI) keep std.
#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod decision_registry;
pub mod treasury_vault;
