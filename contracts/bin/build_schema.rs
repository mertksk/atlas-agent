#![doc = "Binary for building schema definitions from Odra contracts."]
#![allow(unused_imports, clippy::single_component_path_imports)]
use atlas_contracts;

// The schema blueprints are generated in the library by the `#[odra::module]`
// macro; odra_build::schema (2.8) takes both the legacy and current schema.
#[cfg(not(target_arch = "wasm32"))]
extern "Rust" {
    fn module_schema() -> odra::contract_def::ContractBlueprint;
    fn casper_contract_schema() -> odra::schema::casper_contract_schema::ContractSchema;
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    odra_build::schema(unsafe { module_schema() }, unsafe { casper_contract_schema() });
}
