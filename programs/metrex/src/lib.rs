//! MetrEx: on-chain underwriting exchange for parametric wildfire risk.
//! Spec: docs/spec.md. Instruction names, arguments and account contexts are FROZEN after Gate 0.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X");

#[program]
pub mod metrex {
    use super::*;

    // ---------------- Core (§6) ----------------

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle: Pubkey,
        controller: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, oracle, controller)
    }

    pub fn register_property(
        ctx: Context<RegisterProperty>,
        property_id: u16,
        label: [u8; 32],
        lat_e6: i32,
        lon_e6: i32,
        scenario_id: u16,
        trigger_distance_m: u32,
    ) -> Result<()> {
        instructions::register_property::handler(
            ctx,
            property_id,
            label,
            lat_e6,
            lon_e6,
            scenario_id,
            trigger_distance_m,
        )
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_nonce: u64,
        property_id: u16,
        coverage_target: u64,
    ) -> Result<()> {
        instructions::create_market::handler(ctx, market_nonce, property_id, coverage_target)
    }

    pub fn place_offer(
        ctx: Context<PlaceOffer>,
        offer_nonce: u64,
        coverage: u64,
        premium_bps: u16,
    ) -> Result<()> {
        instructions::place_offer::handler(ctx, offer_nonce, coverage, premium_bps)
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        instructions::cancel_offer::handler(ctx)
    }

    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        instructions::accept_offer::handler(ctx)
    }

    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        instructions::close_market::handler(ctx)
    }

    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        triggered: bool,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        instructions::resolve_market::handler(ctx, triggered, evidence_hash)
    }

    pub fn claim_payout<'info>(ctx: Context<'_, '_, '_, 'info, ClaimPayout<'info>>) -> Result<()> {
        instructions::claim_payout::handler(ctx)
    }

    // ---------------- Safety valve (P0.5) ----------------

    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        instructions::void_market::handler(ctx)
    }

    pub fn refund_offer(ctx: Context<RefundOffer>) -> Result<()> {
        instructions::refund_offer::handler(ctx)
    }

    // ---------------- Tier 2: position trading (§5.6) ----------------

    pub fn list_position(ctx: Context<ListPosition>, side: u8, price: u64) -> Result<()> {
        instructions::list_position::handler(ctx, side, price)
    }

    pub fn buy_position(ctx: Context<BuyPosition>) -> Result<()> {
        instructions::buy_position::handler(ctx)
    }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        instructions::cancel_listing::handler(ctx)
    }
}
