//! `create_market(market_nonce, property_id, coverage_target)` (spec §6).
//! Coordinates are copied from the registered Property only (invariant 3).

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, events::MarketCreated, state::*};

#[derive(Accounts)]
#[instruction(market_nonce: u64, property_id: u16)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub homeowner: Signer<'info>,

    #[account(
        seeds = [PROPERTY_SEED, &property_id.to_le_bytes()],
        bump = property.bump,
    )]
    pub property: Account<'info, Property>,

    #[account(
        init,
        payer = homeowner,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, homeowner.key().as_ref(), &market_nonce.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateMarket>,
    market_nonce: u64,
    _property_id: u16,
    coverage_target: u64,
) -> Result<()> {
    require!(coverage_target >= MIN_COVERAGE, MetrexError::CoverageTooSmall);
    require!(
        coverage_target <= MAX_COVERAGE_TARGET,
        MetrexError::CoverageExceedsTarget
    );

    // The Property PDA seeds bind `property` to `property_id`; all coordinates come from it.
    let property = &ctx.accounts.property;
    let now = Clock::get()?.unix_timestamp;

    let market = &mut ctx.accounts.market;
    market.homeowner = ctx.accounts.homeowner.key();
    market.market_nonce = market_nonce;
    market.property_id = property.property_id;
    market.lat_e6 = property.lat_e6;
    market.lon_e6 = property.lon_e6;
    market.scenario_id = property.scenario_id;
    market.trigger_distance_m = property.trigger_distance_m;
    market.coverage_target = coverage_target;
    market.coverage_activated = 0;
    market.accepted_count = 0;
    market.status = MarketStatus::Open;
    market.evidence_hash = [0u8; 32];
    market.created_at = now;
    market.closed_at = 0;
    market.resolved_at = 0;
    market.bump = ctx.bumps.market;

    emit!(MarketCreated {
        market: market.key(),
        homeowner: market.homeowner,
        property_id: market.property_id,
        coverage_target,
        created_at: now,
    });
    Ok(())
}
