//! `buy_position()` (spec §6, Tier 2). Atomic: `price` buyer → seller and holder change in one
//! instruction; Listing closed (rent → seller). Never touches the vault (invariant 17).

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
pub struct BuyPosition<'info> {
    pub buyer: Signer<'info>,

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
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [LISTING_SEED, offer.key().as_ref(), &listing.side.to_le_bytes()],
        bump = listing.bump,
        has_one = offer @ MetrexError::OfferMarketMismatch,
        has_one = seller @ MetrexError::Unauthorized,
        close = seller,
    )]
    pub listing: Box<Account<'info, Listing>>,

    /// CHECK: the listing's seller; receives the listing rent. Must equal `listing.seller` (has_one above).
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = buyer_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = buyer_token.owner == buyer.key() @ MetrexError::WrongTokenOwner,
    )]
    pub buyer_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = seller_token.owner == seller.key() @ MetrexError::WrongTokenOwner,
    )]
    pub seller_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(_ctx: Context<BuyPosition>) -> Result<()> {
    msg!("Position trading is disabled");
    err!(MetrexError::Unauthorized)
}
