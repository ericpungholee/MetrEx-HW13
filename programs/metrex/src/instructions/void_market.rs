//! `void_market()` (spec §6, P0.5). Signer must be `config.admin`; market `Open` or `Closed`.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ MetrexError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(_ctx: Context<VoidMarket>) -> Result<()> {
    // Workstream A (P0.5).
    Ok(())
}
