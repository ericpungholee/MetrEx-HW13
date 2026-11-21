//! Admin can void unfunded markets. Funded recovery requires prior closure and controller co-signature.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, events::MarketVoided, state::*};

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

pub fn handler(ctx: Context<VoidMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        matches!(market.status, MarketStatus::Open | MarketStatus::Closed),
        MetrexError::InvalidMarketStatus
    );
    if market.accepted_count > 0 || market.coverage_activated > 0 {
        require!(market.status == MarketStatus::Closed, MetrexError::InvalidMarketStatus);
        let controller = ctx.accounts.config.demo_controller;
        require_keys_neq!(controller, ctx.accounts.admin.key(), MetrexError::Unauthorized);
        require!(
            ctx.remaining_accounts.iter().any(|account| account.key() == controller && account.is_signer),
            MetrexError::Unauthorized
        );
    }
    market.status = MarketStatus::Voided;

    emit!(MarketVoided {
        market: market.key(),
    });
    Ok(())
}
