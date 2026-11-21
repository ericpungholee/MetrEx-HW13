//! `close_market()` (spec §6). Signer must be `config.demo_controller`.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, events::MarketClosed, state::*};

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    pub demo_controller: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = demo_controller @ MetrexError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<CloseMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        MetrexError::InvalidMarketStatus
    );
    let now = Clock::get()?.unix_timestamp;
    market.status = MarketStatus::Closed;
    market.closed_at = now;

    emit!(MarketClosed {
        market: market.key(),
        closed_at: now,
    });
    Ok(())
}
