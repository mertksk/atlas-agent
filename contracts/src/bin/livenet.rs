//! Casper Testnet deploy & call CLI, built on Odra's livenet backend.
//! The TypeScript agent shells out to this binary for every on-chain write,
//! so one Rust toolchain handles deploys AND entry-point calls.
//!
//! Required env vars (see .env.example at repo root):
//!   ODRA_CASPER_LIVENET_NODE_ADDRESS   e.g. https://node.testnet.casper.network/rpc
//!   ODRA_CASPER_LIVENET_CHAIN_NAME     casper-test
//!   ODRA_CASPER_LIVENET_SECRET_KEY_PATH  path to the agent's ed25519 PEM
//!
//! Usage:
//!   cargo run --bin atlas_livenet --features livenet -- deploy
//!   cargo run --bin atlas_livenet --features livenet -- fund-vault <vault_addr> <amount_motes>
//!   cargo run --bin atlas_livenet --features livenet -- set-agent <vault_addr> <agent_addr>
//!   cargo run --bin atlas_livenet --features livenet -- set-recipient <vault_addr> <recipient_addr> [true|false]
//!   cargo run --bin atlas_livenet --features livenet -- set-recorder <registry_addr> <recorder_addr> [true|false]
//!   cargo run --bin atlas_livenet --features livenet -- record-decision \
//!       <registry_addr> <opportunity_id> <action> <confidence_bps> <risk_score> \
//!       <amount_motes> <data_cost_motes> <data_sources> <reason>
//!   cargo run --bin atlas_livenet --features livenet -- execute-allocation \
//!       <vault_addr> <opportunity_id> <amount_motes> <recipient> <risk_score> <confidence_bps>
//!   cargo run --bin atlas_livenet --features livenet -- vault-status <vault_addr>

use std::str::FromStr;

use atlas_contracts::decision_registry::{DecisionRegistry, DecisionRegistryHostRef};
use atlas_contracts::treasury_vault::{TreasuryVault, TreasuryVaultHostRef, TreasuryVaultInitArgs};
use odra::casper_types::U512;
use odra::host::{Deployer, HostRef, HostRefLoader, NoArgs};
use odra::prelude::*; // Address + Addressable (.address())

const CSPR: u64 = 1_000_000_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = odra_casper_livenet_env::env();

    match args.first().map(String::as_str) {
        Some("deploy") => {
            // Deploy both contracts with a sensible demo policy:
            // per-op cap 30 CSPR, daily cap 50 CSPR, min confidence 70%,
            // max risk 60, human approval at >= 25 CSPR.
            env.set_gas(600 * CSPR);
            let vault = TreasuryVault::deploy(
                &env,
                TreasuryVaultInitArgs {
                    max_allocation_per_op: U512::from(30 * CSPR),
                    max_daily_spend: U512::from(50 * CSPR),
                    min_confidence_bps: 7_000,
                    max_risk_score: 60,
                    approval_threshold: U512::from(25 * CSPR),
                },
            );
            env.set_gas(600 * CSPR);
            let registry = DecisionRegistry::deploy(&env, NoArgs);
            // Machine-readable for the TS agent to capture.
            println!(
                "{{\"vault\":\"{}\",\"registry\":\"{}\"}}",
                vault.address().to_string(),
                registry.address().to_string()
            );
        }
        Some("fund-vault") => {
            let vault_addr = addr(arg(&args, 1, "vault_addr"));
            let amount = motes(arg(&args, 2, "amount_motes"));
            let mut vault = TreasuryVault::load(&env, vault_addr);
            env.set_gas(10 * CSPR);
            vault.with_tokens(amount).deposit();
            println!("{{\"ok\":true,\"action\":\"deposit\",\"amount\":\"{}\"}}", amount);
        }
        Some("set-agent") => {
            let vault_addr = addr(arg(&args, 1, "vault_addr"));
            let agent = addr(arg(&args, 2, "agent_addr"));
            let mut vault = TreasuryVault::load(&env, vault_addr);
            env.set_gas(5 * CSPR);
            vault.set_agent(agent);
            println!("{{\"ok\":true}}");
        }
        Some("set-recipient") => {
            // Allowlist (or, with `false`, revoke) a recipient the agent may pay.
            let vault_addr = addr(arg(&args, 1, "vault_addr"));
            let recipient = addr(arg(&args, 2, "recipient_addr"));
            let approved = args.get(3).map(|s| parse_bool(s)).unwrap_or(true);
            let mut vault = TreasuryVault::load(&env, vault_addr);
            env.set_gas(5 * CSPR);
            vault.set_recipient(recipient, approved);
            println!("{{\"ok\":true,\"approved\":{}}}", approved);
        }
        Some("set-recorder") => {
            // Grant (default) or, with `false`, revoke a registry recorder.
            let registry_addr = addr(arg(&args, 1, "registry_addr"));
            let recorder = addr(arg(&args, 2, "recorder_addr"));
            let allowed = args.get(3).map(|s| parse_bool(s)).unwrap_or(true);
            let mut registry = DecisionRegistry::load(&env, registry_addr);
            env.set_gas(5 * CSPR);
            registry.set_recorder(recorder, allowed);
            println!("{{\"ok\":true,\"allowed\":{}}}", allowed);
        }
        Some("record-decision") => {
            let registry_addr = addr(arg(&args, 1, "registry_addr"));
            let mut registry: DecisionRegistryHostRef = DecisionRegistry::load(&env, registry_addr);
            env.set_gas(10 * CSPR);
            let id = registry.record_decision(
                arg(&args, 2, "opportunity_id").to_string(),
                arg(&args, 3, "action").to_string(),
                u32_arg(&args, 4, "confidence_bps"),
                u32_arg(&args, 5, "risk_score"),
                motes(arg(&args, 6, "amount_motes")),
                motes(arg(&args, 7, "data_cost_motes")),
                arg(&args, 8, "data_sources").to_string(),
                arg(&args, 9, "reason").to_string(),
            );
            println!("{{\"ok\":true,\"decisionId\":{}}}", id);
        }
        Some("execute-allocation") => {
            let vault_addr = addr(arg(&args, 1, "vault_addr"));
            let mut vault: TreasuryVaultHostRef = TreasuryVault::load(&env, vault_addr);
            env.set_gas(15 * CSPR);
            vault.execute_allocation(
                arg(&args, 2, "opportunity_id").to_string(),
                motes(arg(&args, 3, "amount_motes")),
                addr(arg(&args, 4, "recipient")),
                u32_arg(&args, 5, "risk_score"),
                u32_arg(&args, 6, "confidence_bps"),
            );
            println!("{{\"ok\":true}}");
        }
        Some("vault-status") => {
            let vault_addr = addr(arg(&args, 1, "vault_addr"));
            let vault = TreasuryVault::load(&env, vault_addr);
            let p = vault.policy();
            println!(
                "{{\"balance\":\"{}\",\"spentToday\":\"{}\",\"paused\":{},\"allocations\":{},\"policy\":{{\"maxPerOp\":\"{}\",\"maxDaily\":\"{}\",\"minConfidenceBps\":{},\"maxRisk\":{},\"approvalThreshold\":\"{}\"}}}}",
                vault.balance(),
                vault.spent_today(),
                vault.is_paused(),
                vault.allocation_count(),
                p.max_allocation_per_op,
                p.max_daily_spend,
                p.min_confidence_bps,
                p.max_risk_score,
                p.approval_threshold
            );
        }
        _ => {
            eprintln!("unknown command. see file header for usage.");
            std::process::exit(2);
        }
    }
}

/// Fetch a required positional argument or exit(2) with a clear message
/// (instead of panicking on an out-of-bounds index).
fn arg<'a>(args: &'a [String], i: usize, name: &str) -> &'a str {
    match args.get(i) {
        Some(s) => s.as_str(),
        None => {
            eprintln!("missing required argument <{}> at position {}", name, i);
            std::process::exit(2);
        }
    }
}

fn u32_arg(args: &[String], i: usize, name: &str) -> u32 {
    arg(args, i, name).parse::<u32>().unwrap_or_else(|_| {
        eprintln!("argument <{}> must be a u32", name);
        std::process::exit(2);
    })
}

fn motes(s: &str) -> U512 {
    U512::from_dec_str(s).unwrap_or_else(|_| {
        eprintln!("amount must be an integer number of motes, got \"{}\"", s);
        std::process::exit(2);
    })
}

fn parse_bool(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "y")
}

fn addr(s: &str) -> Address {
    Address::from_str(s).unwrap_or_else(|_| {
        eprintln!("invalid address \"{}\" (expected hash-... or account public key)", s);
        std::process::exit(2);
    })
}
