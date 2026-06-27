//! TreasuryVault — holds CSPR for a DAO/team and lets a registered AI agent
//! execute allocations ONLY within an owner-defined, on-chain policy.
//!
//! The policy is enforced by the contract itself, not by the off-chain agent.
//! Even a fully compromised agent cannot exceed these limits.

use odra::casper_types::U512;
use odra::prelude::*;

/// Owner-defined guardrails for the agent. All enforced on-chain.
#[odra::odra_type]
pub struct Policy {
    /// Max CSPR (motes) the agent may allocate to a single opportunity.
    pub max_allocation_per_op: U512,
    /// Max CSPR (motes) the agent may move per 24h window.
    pub max_daily_spend: U512,
    /// Minimum agent confidence, in basis points (0..=10000).
    pub min_confidence_bps: u32,
    /// Maximum acceptable risk score (0..=100).
    pub max_risk_score: u32,
    /// Allocations >= this amount (motes) require the OWNER to call
    /// `execute_allocation` (human approval), the agent alone cannot.
    pub approval_threshold: U512,
}

#[odra::odra_type]
pub struct AllocationRecord {
    pub opportunity_id: String,
    pub amount: U512,
    pub recipient: Address,
    pub risk_score: u32,
    pub confidence_bps: u32,
    pub timestamp: u64,
}

#[odra::event]
pub struct Deposited {
    pub from: Address,
    pub amount: U512,
}

#[odra::event]
pub struct Withdrawn {
    pub to: Address,
    pub amount: U512,
}

#[odra::event]
pub struct AgentChanged {
    pub agent: Address,
}

#[odra::event]
pub struct PolicyChanged {
    pub max_allocation_per_op: U512,
    pub max_daily_spend: U512,
    pub min_confidence_bps: u32,
    pub max_risk_score: u32,
    pub approval_threshold: U512,
}

#[odra::event]
pub struct AllocationExecuted {
    pub opportunity_id: String,
    pub amount: U512,
    pub recipient: Address,
    pub risk_score: u32,
    pub confidence_bps: u32,
    pub executed_by: Address,
}

#[odra::event]
pub struct PausedChanged {
    pub paused: bool,
}

#[odra::event]
pub struct RecipientChanged {
    pub recipient: Address,
    pub approved: bool,
}

#[odra::odra_error]
pub enum Error {
    /// Caller is not the owner.
    NotOwner = 1,
    /// Caller is neither the registered agent nor the owner.
    NotAgentOrOwner = 2,
    /// Vault is paused (emergency stop).
    Paused = 3,
    /// Allocation exceeds `max_allocation_per_op`.
    ExceedsPerOpportunityLimit = 4,
    /// Allocation would exceed `max_daily_spend` for the current window.
    ExceedsDailyLimit = 5,
    /// Risk score above `max_risk_score`.
    RiskTooHigh = 6,
    /// Confidence below `min_confidence_bps`.
    ConfidenceTooLow = 7,
    /// Amount requires human approval; only the owner can execute it.
    RequiresHumanApproval = 8,
    /// Vault does not hold enough CSPR.
    InsufficientFunds = 9,
    /// Confidence must be expressed in basis points (<= 10000).
    InvalidConfidence = 10,
    /// Risk score must be <= 100.
    InvalidRiskScore = 11,
    /// Recipient is not on the owner-approved allowlist (agent calls only).
    RecipientNotApproved = 12,
}

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[odra::module(events = [Deposited, Withdrawn, AgentChanged, PolicyChanged, AllocationExecuted, PausedChanged, RecipientChanged], errors = Error)]
pub struct TreasuryVault {
    owner: Var<Address>,
    agent: Var<Address>,
    paused: Var<bool>,
    policy: Var<Policy>,
    /// Motes spent inside the current 24h window.
    daily_spent: Var<U512>,
    /// Index of the 24h window (`block_time / DAY_MS`) `daily_spent` refers to.
    day_index: Var<u64>,
    /// Total motes allocated per opportunity id (cumulative, lifetime).
    allocated: Mapping<String, U512>,
    /// Recipients the owner has approved for agent-initiated allocations.
    approved_recipients: Mapping<Address, bool>,
    /// Append-only allocation log.
    allocations: Mapping<u64, AllocationRecord>,
    allocation_count: Var<u64>,
}

#[odra::module]
impl TreasuryVault {
    /// Deploys the vault. The deployer becomes owner AND the initial agent
    /// (call `set_agent` to hand control to the autonomous agent account).
    pub fn init(
        &mut self,
        max_allocation_per_op: U512,
        max_daily_spend: U512,
        min_confidence_bps: u32,
        max_risk_score: u32,
        approval_threshold: U512,
    ) {
        let caller = self.env().caller();
        self.owner.set(caller);
        self.agent.set(caller);
        self.paused.set(false);
        self.daily_spent.set(U512::zero());
        self.day_index.set(self.env().get_block_time() / DAY_MS);
        self.allocation_count.set(0);
        self.policy.set(Policy {
            max_allocation_per_op,
            max_daily_spend,
            min_confidence_bps,
            max_risk_score,
            approval_threshold,
        });
    }

    // ---------------------------------------------------------------- funding

    /// Anyone can fund the treasury.
    #[odra(payable)]
    pub fn deposit(&mut self) {
        let amount = self.env().attached_value();
        self.env().emit_event(Deposited {
            from: self.env().caller(),
            amount,
        });
    }

    /// Owner-only withdrawal (e.g. winding down the treasury).
    pub fn withdraw(&mut self, to: Address, amount: U512) {
        self.assert_owner();
        if self.env().self_balance() < amount {
            self.env().revert(Error::InsufficientFunds);
        }
        self.env().transfer_tokens(&to, &amount);
        self.env().emit_event(Withdrawn { to, amount });
    }

    // ------------------------------------------------------------ governance

    pub fn set_agent(&mut self, agent: Address) {
        self.assert_owner();
        self.agent.set(agent);
        self.env().emit_event(AgentChanged { agent });
    }

    pub fn set_policy(
        &mut self,
        max_allocation_per_op: U512,
        max_daily_spend: U512,
        min_confidence_bps: u32,
        max_risk_score: u32,
        approval_threshold: U512,
    ) {
        self.assert_owner();
        self.policy.set(Policy {
            max_allocation_per_op,
            max_daily_spend,
            min_confidence_bps,
            max_risk_score,
            approval_threshold,
        });
        self.env().emit_event(PolicyChanged {
            max_allocation_per_op,
            max_daily_spend,
            min_confidence_bps,
            max_risk_score,
            approval_threshold,
        });
    }

    /// Emergency stop. Owner-only.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused.set(paused);
        self.env().emit_event(PausedChanged { paused });
    }

    /// Approve or revoke a recipient the agent may allocate to. Owner-only.
    /// A compromised agent therefore cannot send funds to an arbitrary
    /// (attacker-controlled) address — only to strategy addresses the owner has
    /// vetted. The owner itself is exempt from this allowlist.
    pub fn set_recipient(&mut self, recipient: Address, approved: bool) {
        self.assert_owner();
        self.approved_recipients.set(&recipient, approved);
        self.env().emit_event(RecipientChanged { recipient, approved });
    }

    // ------------------------------------------------------------- execution

    /// Move funds to an opportunity (vault/strategy address). Callable by the
    /// registered agent or the owner — but the POLICY decides what passes:
    ///
    /// 1. vault must not be paused
    /// 2. agent calls may only pay an owner-approved recipient (owner exempt)
    /// 3. confidence/risk inputs must be sane and within policy
    /// 4. CUMULATIVE allocation to the opportunity <= max_allocation_per_op
    /// 5. amount + spent_today <= max_daily_spend (fixed 24h epoch bucket)
    /// 6. amount >= approval_threshold  =>  owner only (human approval)
    pub fn execute_allocation(
        &mut self,
        opportunity_id: String,
        amount: U512,
        recipient: Address,
        risk_score: u32,
        confidence_bps: u32,
    ) {
        let caller = self.env().caller();
        let owner = self.owner.get().unwrap_or_revert(&self.env());
        let agent = self.agent.get().unwrap_or_revert(&self.env());
        if caller != agent && caller != owner {
            self.env().revert(Error::NotAgentOrOwner);
        }
        if self.paused.get_or_default() {
            self.env().revert(Error::Paused);
        }
        // The agent may only pay recipients the owner has vetted; the owner is
        // exempt. This is the primary guard against a compromised agent draining
        // the vault to an address it controls.
        if caller != owner && !self.approved_recipients.get(&recipient).unwrap_or(false) {
            self.env().revert(Error::RecipientNotApproved);
        }
        if confidence_bps > 10_000 {
            self.env().revert(Error::InvalidConfidence);
        }
        if risk_score > 100 {
            self.env().revert(Error::InvalidRiskScore);
        }

        let policy = self.policy.get().unwrap_or_revert(&self.env());
        if risk_score > policy.max_risk_score {
            self.env().revert(Error::RiskTooHigh);
        }
        if confidence_bps < policy.min_confidence_bps {
            self.env().revert(Error::ConfidenceTooLow);
        }
        // The per-opportunity cap is CUMULATIVE over the opportunity's lifetime,
        // not per call — otherwise it is trivially bypassed by chunking.
        let prev_allocated = self.allocated.get_or_default(&opportunity_id);
        let new_allocated = prev_allocated + amount;
        if new_allocated > policy.max_allocation_per_op {
            self.env().revert(Error::ExceedsPerOpportunityLimit);
        }
        if amount >= policy.approval_threshold && caller != owner {
            self.env().revert(Error::RequiresHumanApproval);
        }
        if self.env().self_balance() < amount {
            self.env().revert(Error::InsufficientFunds);
        }

        // Fixed 24h epoch spend bucket (resets when the day index advances).
        let now_day = self.env().get_block_time() / DAY_MS;
        let mut spent = self.daily_spent.get_or_default();
        if now_day != self.day_index.get_or_default() {
            self.day_index.set(now_day);
            spent = U512::zero();
        }
        let new_spent = spent + amount;
        if new_spent > policy.max_daily_spend {
            self.env().revert(Error::ExceedsDailyLimit);
        }
        self.daily_spent.set(new_spent);

        // Effects.
        self.allocated.set(&opportunity_id, new_allocated);
        let idx = self.allocation_count.get_or_default();
        self.allocations.set(
            &idx,
            AllocationRecord {
                opportunity_id: opportunity_id.clone(),
                amount,
                recipient,
                risk_score,
                confidence_bps,
                timestamp: self.env().get_block_time(),
            },
        );
        self.allocation_count.set(idx + 1);

        // Interaction last.
        self.env().transfer_tokens(&recipient, &amount);
        self.env().emit_event(AllocationExecuted {
            opportunity_id,
            amount,
            recipient,
            risk_score,
            confidence_bps,
            executed_by: caller,
        });
    }

    // --------------------------------------------------------------- getters

    pub fn balance(&self) -> U512 {
        self.env().self_balance()
    }

    pub fn owner(&self) -> Address {
        self.owner.get().unwrap_or_revert(&self.env())
    }

    pub fn agent(&self) -> Address {
        self.agent.get().unwrap_or_revert(&self.env())
    }

    pub fn is_paused(&self) -> bool {
        self.paused.get_or_default()
    }

    pub fn policy(&self) -> Policy {
        self.policy.get().unwrap_or_revert(&self.env())
    }

    pub fn allocated_of(&self, opportunity_id: String) -> U512 {
        self.allocated.get_or_default(&opportunity_id)
    }

    pub fn is_approved_recipient(&self, recipient: Address) -> bool {
        self.approved_recipients.get(&recipient).unwrap_or(false)
    }

    pub fn spent_today(&self) -> U512 {
        let now_day = self.env().get_block_time() / DAY_MS;
        if now_day != self.day_index.get_or_default() {
            return U512::zero();
        }
        self.daily_spent.get_or_default()
    }

    pub fn allocation_count(&self) -> u64 {
        self.allocation_count.get_or_default()
    }

    pub fn allocation_at(&self, index: u64) -> Option<AllocationRecord> {
        self.allocations.get(&index)
    }

    // --------------------------------------------------------------- private

    fn assert_owner(&self) {
        if self.env().caller() != self.owner.get().unwrap_or_revert(&self.env()) {
            self.env().revert(Error::NotOwner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostRef};

    const CSPR: u64 = 1_000_000_000; // motes per CSPR

    fn setup() -> (odra::host::HostEnv, TreasuryVaultHostRef) {
        let env = odra_test::env();
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
        (env, vault)
    }

    #[test]
    fn deposit_and_balance() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(100 * CSPR)).deposit();
        assert_eq!(vault.balance(), U512::from(100 * CSPR));
        assert_eq!(vault.owner(), env.get_account(0));
    }

    #[test]
    fn agent_allocation_within_policy_succeeds() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(100 * CSPR)).deposit();
        let agent = env.get_account(1);
        let strategy = env.get_account(2);
        vault.set_agent(agent);
        vault.set_recipient(strategy, true);

        env.set_caller(agent);
        vault.execute_allocation("rwa-vault-001".to_string(), U512::from(20 * CSPR), strategy, 40, 8_200);

        assert_eq!(vault.balance(), U512::from(80 * CSPR));
        assert_eq!(vault.allocated_of("rwa-vault-001".to_string()), U512::from(20 * CSPR));
        assert_eq!(vault.allocation_count(), 1);
    }

    #[test]
    fn policy_blocks_risk_confidence_and_size() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(100 * CSPR)).deposit();
        let agent = env.get_account(1);
        let strategy = env.get_account(2);
        vault.set_agent(agent);
        vault.set_recipient(strategy, true);
        env.set_caller(agent);

        // Risk too high (61 > 60)
        assert_eq!(
            vault.try_execute_allocation("x".into(), U512::from(10 * CSPR), strategy, 61, 9_000),
            Err(Error::RiskTooHigh.into())
        );
        // Confidence too low (6900 < 7000)
        assert_eq!(
            vault.try_execute_allocation("x".into(), U512::from(10 * CSPR), strategy, 40, 6_900),
            Err(Error::ConfidenceTooLow.into())
        );
        // Per-opportunity cap (31 > 30) — also below approval threshold? 31 >= 25 triggers approval first?
        // Order: per-op limit checked before approval threshold, so use 31 via owner to isolate.
        env.set_caller(env.get_account(0));
        assert_eq!(
            vault.try_execute_allocation("x".into(), U512::from(31 * CSPR), strategy, 40, 9_000),
            Err(Error::ExceedsPerOpportunityLimit.into())
        );
    }

    #[test]
    fn human_approval_threshold_enforced() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(100 * CSPR)).deposit();
        let agent = env.get_account(1);
        let strategy = env.get_account(2);
        vault.set_agent(agent);
        vault.set_recipient(strategy, true);

        // Agent cannot move >= 25 CSPR alone.
        env.set_caller(agent);
        assert_eq!(
            vault.try_execute_allocation("big".into(), U512::from(25 * CSPR), strategy, 40, 9_000),
            Err(Error::RequiresHumanApproval.into())
        );
        // Owner can.
        env.set_caller(env.get_account(0));
        vault.execute_allocation("big".into(), U512::from(25 * CSPR), strategy, 40, 9_000);
        assert_eq!(vault.balance(), U512::from(75 * CSPR));
    }

    #[test]
    fn daily_spend_cap_enforced() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(200 * CSPR)).deposit();
        let agent = env.get_account(1);
        let strategy = env.get_account(2);
        vault.set_agent(agent);
        vault.set_recipient(strategy, true);
        env.set_caller(agent);

        vault.execute_allocation("a".into(), U512::from(20 * CSPR), strategy, 30, 9_000);
        vault.execute_allocation("b".into(), U512::from(20 * CSPR), strategy, 30, 9_000);
        // 40 spent, cap 50 — next 20 must fail.
        assert_eq!(
            vault.try_execute_allocation("c".into(), U512::from(20 * CSPR), strategy, 30, 9_000),
            Err(Error::ExceedsDailyLimit.into())
        );
        // Next day the window resets.
        env.advance_block_time(super::DAY_MS + 1);
        vault.execute_allocation("c".into(), U512::from(20 * CSPR), strategy, 30, 9_000);
        assert_eq!(vault.spent_today(), U512::from(20 * CSPR));
    }

    #[test]
    fn pause_blocks_everything_but_owner_can_withdraw() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(100 * CSPR)).deposit();
        let agent = env.get_account(1);
        vault.set_agent(agent);
        vault.set_paused(true);

        env.set_caller(agent);
        assert_eq!(
            vault.try_execute_allocation("x".into(), U512::from(1 * CSPR), env.get_account(2), 10, 9_900),
            Err(Error::Paused.into())
        );
        env.set_caller(env.get_account(0));
        vault.withdraw(env.get_account(0), U512::from(100 * CSPR));
        assert_eq!(vault.balance(), U512::zero());
    }

    #[test]
    fn only_owner_governs() {
        let (env, mut vault) = setup();
        env.set_caller(env.get_account(3));
        assert_eq!(vault.try_set_paused(true), Err(Error::NotOwner.into()));
        assert_eq!(vault.try_set_agent(env.get_account(3)), Err(Error::NotOwner.into()));
        assert_eq!(
            vault.try_set_recipient(env.get_account(2), true),
            Err(Error::NotOwner.into())
        );
    }

    #[test]
    fn recipient_allowlist_blocks_unapproved_and_owner_is_exempt() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(100 * CSPR)).deposit();
        let agent = env.get_account(1);
        let strategy = env.get_account(2);
        vault.set_agent(agent);

        // Agent cannot pay a recipient the owner has not approved.
        env.set_caller(agent);
        assert_eq!(
            vault.try_execute_allocation("op".into(), U512::from(10 * CSPR), strategy, 30, 9_000),
            Err(Error::RecipientNotApproved.into())
        );

        // Owner approves the recipient; the agent can now pay it.
        env.set_caller(env.get_account(0));
        vault.set_recipient(strategy, true);
        env.set_caller(agent);
        vault.execute_allocation("op".into(), U512::from(10 * CSPR), strategy, 30, 9_000);
        assert_eq!(vault.balance(), U512::from(90 * CSPR));

        // Revoking blocks the agent again.
        env.set_caller(env.get_account(0));
        vault.set_recipient(strategy, false);
        env.set_caller(agent);
        assert_eq!(
            vault.try_execute_allocation("op".into(), U512::from(5 * CSPR), strategy, 30, 9_000),
            Err(Error::RecipientNotApproved.into())
        );

        // The owner is exempt: it can pay an address the allowlist never approved.
        env.set_caller(env.get_account(0));
        vault.execute_allocation("op".into(), U512::from(5 * CSPR), env.get_account(4), 30, 9_000);
        assert_eq!(vault.balance(), U512::from(85 * CSPR));
    }

    #[test]
    fn cumulative_per_opportunity_cap_blocks_chunking() {
        let (env, mut vault) = setup();
        vault.with_tokens(U512::from(200 * CSPR)).deposit();
        let agent = env.get_account(1);
        let strategy = env.get_account(2);
        vault.set_agent(agent);
        vault.set_recipient(strategy, true);
        env.set_caller(agent);

        // First 20 to "op1" is fine (cumulative 20 <= 30).
        vault.execute_allocation("op1".into(), U512::from(20 * CSPR), strategy, 30, 9_000);
        // A further 15 would push op1's lifetime total to 35 > 30, even though
        // 15 is itself under both the per-op cap and the approval threshold.
        assert_eq!(
            vault.try_execute_allocation("op1".into(), U512::from(15 * CSPR), strategy, 30, 9_000),
            Err(Error::ExceedsPerOpportunityLimit.into())
        );
        // A different opportunity still has its own headroom.
        vault.execute_allocation("op2".into(), U512::from(10 * CSPR), strategy, 30, 9_000);
        assert_eq!(vault.allocated_of("op1".into()), U512::from(20 * CSPR));
        assert_eq!(vault.allocated_of("op2".into()), U512::from(10 * CSPR));
    }
}
