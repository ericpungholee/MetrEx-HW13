//! `resolve_market(triggered, evidence_hash)` (spec §6). Signer must be `config.oracle_authority`.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub oracle_authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle_authority @ MetrexError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(_ctx: Context<ResolveMarket>, _triggered: bool, _evidence_hash: [u8; 32]) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
