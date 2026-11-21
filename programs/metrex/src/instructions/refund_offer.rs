//! `refund_offer()` (spec §6, P0.5). Anyone can crank. Market `Voided`, Offer `Accepted`.
//! P → original homeowner, K → original underwriter (regardless of current holders); vault closed.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
pub struct RefundOffer<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
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
        has_one = underwriter @ MetrexError::Unauthorized,
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
        constraint = homeowner_token.owner == market.homeowner @ MetrexError::WrongTokenOwner,
    )]
    pub homeowner_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = underwriter_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = underwriter_token.owner == offer.underwriter @ MetrexError::WrongTokenOwner,
    )]
    pub underwriter_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: receives the vault's rent on close; must equal `offer.underwriter` (has_one above).
    #[account(mut)]
    pub underwriter: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(_ctx: Context<RefundOffer>) -> Result<()> {
    // Workstream A (P0.5).
    Ok(())
}
