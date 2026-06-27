//! DecisionRegistry — append-only, on-chain audit trail of every decision the
//! Atlas agent makes: which data it bought, what it cost, what it recommended,
//! with what confidence, and why.
//!
//! This is what makes the agent NOT a black box: judges (and DAO members) can
//! replay the agent's financial reasoning straight from chain state.

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::odra_type]
pub struct Decision {
    /// Marketplace opportunity this decision refers to.
    pub opportunity_id: String,
    /// ALLOCATE | REJECT | HOLD | QUEUE_FOR_APPROVAL
    pub action: String,
    /// Agent confidence in basis points (0..=10000).
    pub confidence_bps: u32,
    /// Composite risk score (0..=100) derived from purchased data.
    pub risk_score: u32,
    /// Amount recommended/executed, in motes.
    pub amount: U512,
    /// Total paid for x402 data services for this decision, in motes.
    pub data_cost: U512,
    /// Comma-separated list of purchased data sources, e.g. "risk-score,liquidity".
    pub data_sources: String,
    /// Short human-readable rationale produced by the reasoning engine.
    pub reason: String,
    /// Block time at recording.
    pub timestamp: u64,
    /// Account that recorded the decision.
    pub recorded_by: Address,
}

#[odra::event]
pub struct DecisionRecorded {
    pub id: u64,
    pub opportunity_id: String,
    pub action: String,
    pub confidence_bps: u32,
    pub risk_score: u32,
    pub amount: U512,
    pub data_cost: U512,
}

#[odra::event]
pub struct RecorderChanged {
    pub recorder: Address,
    pub allowed: bool,
}

#[odra::odra_error]
pub enum Error {
    /// Caller is not the owner.
    NotOwner = 1,
    /// Caller is not an authorized recorder.
    NotAuthorized = 2,
    /// Confidence must be <= 10000 bps.
    InvalidConfidence = 3,
    /// Risk score must be <= 100.
    InvalidRiskScore = 4,
}

#[odra::module(events = [DecisionRecorded, RecorderChanged], errors = Error)]
pub struct DecisionRegistry {
    owner: Var<Address>,
    recorders: Mapping<Address, bool>,
    decisions: Mapping<u64, Decision>,
    count: Var<u64>,
}

#[odra::module]
impl DecisionRegistry {
    pub fn init(&mut self) {
        let caller = self.env().caller();
        self.owner.set(caller);
        self.recorders.set(&caller, true);
        self.count.set(0);
    }

    /// Owner grants/revokes recorder rights (the agent account).
    pub fn set_recorder(&mut self, recorder: Address, allowed: bool) {
        if self.env().caller() != self.owner.get().unwrap_or_revert(&self.env()) {
            self.env().revert(Error::NotOwner);
        }
        self.recorders.set(&recorder, allowed);
        self.env().emit_event(RecorderChanged { recorder, allowed });
    }

    /// Append a decision. Returns its id.
    #[allow(clippy::too_many_arguments)]
    pub fn record_decision(
        &mut self,
        opportunity_id: String,
        action: String,
        confidence_bps: u32,
        risk_score: u32,
        amount: U512,
        data_cost: U512,
        data_sources: String,
        reason: String,
    ) -> u64 {
        let caller = self.env().caller();
        if !self.recorders.get_or_default(&caller) {
            self.env().revert(Error::NotAuthorized);
        }
        if confidence_bps > 10_000 {
            self.env().revert(Error::InvalidConfidence);
        }
        if risk_score > 100 {
            self.env().revert(Error::InvalidRiskScore);
        }

        let id = self.count.get_or_default();
        self.decisions.set(
            &id,
            Decision {
                opportunity_id: opportunity_id.clone(),
                action: action.clone(),
                confidence_bps,
                risk_score,
                amount,
                data_cost,
                data_sources,
                reason,
                timestamp: self.env().get_block_time(),
                recorded_by: caller,
            },
        );
        self.count.set(id + 1);
        self.env().emit_event(DecisionRecorded {
            id,
            opportunity_id,
            action,
            confidence_bps,
            risk_score,
            amount,
            data_cost,
        });
        id
    }

    pub fn decision_count(&self) -> u64 {
        self.count.get_or_default()
    }

    pub fn get_decision(&self, id: u64) -> Option<Decision> {
        self.decisions.get(&id)
    }

    pub fn is_recorder(&self, account: Address) -> bool {
        self.recorders.get_or_default(&account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostRef, NoArgs};

    #[test]
    fn record_and_read_back() {
        let env = odra_test::env();
        let mut registry = DecisionRegistry::deploy(&env, NoArgs);

        let id = registry.record_decision(
            "rwa-vault-001".into(),
            "ALLOCATE".into(),
            8_200,
            41,
            U512::from(20_000_000_000u64),
            U512::from(1_600_000_000u64),
            "risk-score,liquidity,rwa-doc".into(),
            "Yield moderate, liquidity acceptable, risk within policy.".into(),
        );
        assert_eq!(id, 0);
        assert_eq!(registry.decision_count(), 1);

        let d = registry.get_decision(0).unwrap();
        assert_eq!(d.action, "ALLOCATE");
        assert_eq!(d.confidence_bps, 8_200);
        assert_eq!(d.recorded_by, env.get_account(0));
    }

    #[test]
    fn unauthorized_cannot_record() {
        let env = odra_test::env();
        let mut registry = DecisionRegistry::deploy(&env, NoArgs);
        env.set_caller(env.get_account(1));
        let res = registry.try_record_decision(
            "x".into(),
            "REJECT".into(),
            9_000,
            90,
            U512::zero(),
            U512::zero(),
            "".into(),
            "nope".into(),
        );
        assert_eq!(res, Err(Error::NotAuthorized.into()));
    }

    #[test]
    fn owner_grants_agent_recording_rights() {
        let env = odra_test::env();
        let mut registry = DecisionRegistry::deploy(&env, NoArgs);
        let agent = env.get_account(1);
        registry.set_recorder(agent, true);
        assert!(registry.is_recorder(agent));

        env.set_caller(agent);
        let id = registry.record_decision(
            "sus-apy-005".into(),
            "REJECT".into(),
            9_400,
            88,
            U512::zero(),
            U512::from(500_000_000u64),
            "risk-score".into(),
            "Unverifiable collateral, anomalous APY, fails policy max risk.".into(),
        );
        assert_eq!(id, 0);
    }
}
