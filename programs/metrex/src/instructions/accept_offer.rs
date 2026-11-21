//! `accept_offer()` (spec §6). Premium P moves homeowner → vault; vault must then hold C.
//! Sets `protection_holder = homeowner`, `risk_holder = underwriter`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    pub homeowner: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
        has_one = homeowner @ MetrexError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [
            OFFER_SEED,
            offer.market.as_ref(),
            offer.underwriter.as_ref(),
            &offer.offer_nonce.to_le_bytes(),
        ],
        bump = offer.bump,
        has_one = market @ MetrexError::OfferMarketMismatch,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, offer.key().as_ref()],
        bump = offer.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = homeowner_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = homeowner_token.owner == homeowner.key() @ MetrexError::WrongTokenOwner,
    )]
    pub homeowner_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(_ctx: Context<AcceptOffer>) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
