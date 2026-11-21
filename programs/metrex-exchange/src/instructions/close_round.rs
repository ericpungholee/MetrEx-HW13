//! `close_round()` (spec-v2 §5.9, §6.6): one transition stops trading on every member market.
//! The controller may close at any time; anyone may close once `trading_ends_at` has passed.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::ExchangeError, events::RoundClosed, state::*};

#[derive(Accounts)]
pub struct CloseRound<'info> {
    pub caller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

pub fn handler(ctx: Context<CloseRound>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    require!(round.status == RoundStatus::Open, ExchangeError::RoundNotOpen);
    let by_controller = ctx.accounts.caller.key() == ctx.accounts.config.round_controller;
    require!(
        by_controller || now >= round.trading_ends_at,
        ExchangeError::Unauthorized
    );
    round.status = RoundStatus::Closed;
    round.closed_at = now;
    emit!(RoundClosed {
        round: round.key(),
        closed_at: now,
        by_controller,
    });
    Ok(())
}
