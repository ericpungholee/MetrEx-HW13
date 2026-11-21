//! `resolve_market(triggered, evidence_hash)` (spec §6). Signer must be `config.oracle_authority`.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, events::MarketResolved, state::*};

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

pub fn handler(ctx: Context<ResolveMarket>, triggered: bool, evidence_hash: [u8; 32]) -> Result<()> {
    let market = &mut ctx.accounts.market;
    // Only Closed → Resolved*; a second resolve finds a final status and fails (invariant 9).
    require!(
        market.status == MarketStatus::Closed,
        MetrexError::InvalidMarketStatus
    );
    let now = Clock::get()?.unix_timestamp;
    market.status = if triggered {
        MarketStatus::ResolvedYes
    } else {
        MarketStatus::ResolvedNo
    };
    market.evidence_hash = evidence_hash;
    market.resolved_at = now;

    emit!(MarketResolved {
        market: market.key(),
        triggered,
        evidence_hash,
        resolved_at: now,
    });
    Ok(())
}
