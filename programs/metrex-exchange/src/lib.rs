//! MetrEx Exchange v2: binary outcome tokens and an escrowed order book (docs/spec-v2.md).
//! Instruction names, arguments, account contexts, accounts, seeds, errors and events are FROZEN
//! at Gate V0. The v1.1 program (`programs/metrex`) is separate and untouched.

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

declare_id!("BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko");

#[program]
pub mod metrex_exchange {
    use super::*;

    // ---------------- Setup (§6.1–§6.4) ----------------

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        round_controller: Pubkey,
        oracle_authority: Pubkey,
        resolution_timeout_s: i64,
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, round_controller, oracle_authority, resolution_timeout_s)
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

    pub fn create_round(
        ctx: Context<CreateRound>,
        scenario_id: u16,
        dataset_sha256: [u8; 32],
        label: [u8; 32],
        trading_ends_at: i64,
    ) -> Result<()> {
        instructions::create_round::handler(ctx, scenario_id, dataset_sha256, label, trading_ends_at)
    }

    pub fn create_market(ctx: Context<CreateMarket>) -> Result<()> {
        instructions::create_market::handler(ctx)
    }

    // ---------------- Outcome tokens (§4) ----------------

    pub fn split(ctx: Context<Split>, quantity: u64) -> Result<()> {
        instructions::split::handler(ctx, quantity)
    }

    pub fn merge(ctx: Context<Merge>, quantity: u64) -> Result<()> {
        instructions::merge::handler(ctx, quantity)
    }

    // ---------------- Trading (§5) — bodies at Gate V2 ----------------

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        client_nonce: u64,
        outcome: u8,
        side: u8,
        price_bps: u16,
        quantity: u64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, client_nonce, outcome, side, price_bps, quantity, expires_at)
    }

    pub fn take_order(
        ctx: Context<TakeOrder>,
        quantity: u64,
        limit_price_bps: u16,
        expected_seq: u64,
    ) -> Result<()> {
        instructions::take_order::handler(ctx, quantity, limit_price_bps, expected_seq)
    }

    pub fn match_orders(ctx: Context<MatchOrders>, quantity: u64) -> Result<()> {
        instructions::match_orders::handler(ctx, quantity)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::cancel_order::handler(ctx)
    }

    pub fn sweep_order(ctx: Context<SweepOrder>) -> Result<()> {
        instructions::sweep_order::handler(ctx)
    }

    // ---------------- Lifecycle and settlement (§4.5, §6.6) ----------------

    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        instructions::close_round::handler(ctx)
    }

    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        triggered: bool,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        instructions::resolve_market::handler(ctx, triggered, evidence_hash)
    }

    pub fn invalidate_market(ctx: Context<InvalidateMarket>, reason: u8) -> Result<()> {
        instructions::invalidate_market::handler(ctx, reason)
    }

    pub fn expire_market(ctx: Context<ExpireMarket>) -> Result<()> {
        instructions::expire_market::handler(ctx)
    }

    pub fn redeem(ctx: Context<Redeem>, outcome: u8, quantity: u64) -> Result<()> {
        instructions::redeem::handler(ctx, outcome, quantity)
    }
}
