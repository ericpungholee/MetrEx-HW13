//! `invalidate_market(reason)` (spec-v2 §4.5, emergency recovery). Requires BOTH the admin and the
//! oracle, and a Closed round. Separate from normal settlement; one insider cannot trigger it.

use anchor_lang::prelude::*;

use crate::{
    constants::*, errors::ExchangeError, instructions::resolve_market::finish, state::*,
};

#[derive(Accounts)]
pub struct InvalidateMarket<'info> {
    pub admin: Signer<'info>,
    pub oracle_authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ExchangeError::Unauthorized,
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

pub fn handler(ctx: Context<InvalidateMarket>, reason: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    round.require_closed()?;
    let market = &mut ctx.accounts.market;
    market.require_unresolved()?;
    market.outcome = Outcome::Invalid;
    market.resolved_at = now;
    market.resolution_path = PATH_EMERGENCY;
    market.invalid_reason = reason;
    finish(round, market, reason)
}
