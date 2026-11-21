//! `resolve_market(triggered, evidence_hash)` (spec-v2 §4.5, normal settlement).
//! Oracle only; round Closed; strictly before `T = closed_at + resolution_timeout_s`.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::ExchangeError, events::MarketResolved, state::*};

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub oracle_authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle_authority @ ExchangeError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, round.key().as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
        has_one = round @ ExchangeError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,
}

pub fn handler(ctx: Context<ResolveMarket>, triggered: bool, evidence_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    round.require_closed()?;
    let market = &mut ctx.accounts.market;
    market.require_unresolved()?;
    require!(
        now < round.resolution_deadline(ctx.accounts.config.resolution_timeout_s)?,
        ExchangeError::ResolutionWindowClosed
    );
    require!(evidence_hash != [0u8; 32], ExchangeError::InvalidEvidenceHash);

    market.outcome = if triggered { Outcome::Yes } else { Outcome::No };
    market.evidence_hash = evidence_hash;
    market.resolved_at = now;
    market.resolution_path = PATH_ORACLE;
    finish(round, market, 0)
}

/// Shared by all three settlement paths: count the resolution and emit the event.
pub(crate) fn finish(round: &mut Account<Round>, market: &mut Account<Market>, reason: u8) -> Result<()> {
    round.resolved_count = round
        .resolved_count
        .checked_add(1)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;
    emit!(MarketResolved {
        market: market.key(),
        round: round.key(),
        outcome: market.outcome.code(),
        path: market.resolution_path,
        evidence_hash: market.evidence_hash,
        reason,
    });
    Ok(())
}
