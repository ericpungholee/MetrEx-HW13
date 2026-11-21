//! `expire_market()` (spec-v2 §4.5, liveness). Anyone, once `now ≥ T`. The oracle can no longer
//! resolve at that point, so the two windows are disjoint.

use anchor_lang::prelude::*;

use crate::{
    constants::*, errors::ExchangeError, instructions::resolve_market::finish, state::*,
};

#[derive(Accounts)]
pub struct ExpireMarket<'info> {
    pub caller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
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

pub fn handler(ctx: Context<ExpireMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    round.require_closed()?;
    let market = &mut ctx.accounts.market;
    market.require_unresolved()?;
    require!(
        now >= round.resolution_deadline(ctx.accounts.config.resolution_timeout_s)?,
        ExchangeError::ResolutionWindowOpen
    );
    market.outcome = Outcome::Invalid;
    market.resolved_at = now;
    market.resolution_path = PATH_EXPIRY;
    finish(round, market, 0)
}
