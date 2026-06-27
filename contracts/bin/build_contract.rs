#![doc = "Binary for building wasm files from Odra contracts."]
// A thin no_std/no_main shell: it only forces the library (which holds the
// `#[no_mangle]` contract entry points, gated on the `odra_module` cfg set by
// build.rs) to be linked into the wasm artifact. The actual module is selected
// via the ODRA_MODULE env var at build time.
#![no_std]
#![no_main]
#![allow(unused_imports, clippy::single_component_path_imports)]
use atlas_contracts;
