//! `create_market(market_nonce, property_id, coverage_target)` (spec §6).
//! Coordinates are copied from the registered Property only (invariant 3).

use anchor_lang::prelude::*;

use crate::{constants::*, state::*};

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
    _ctx: Context<CreateMarket>,
    _market_nonce: u64,
    _property_id: u16,
    _coverage_target: u64,
) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
