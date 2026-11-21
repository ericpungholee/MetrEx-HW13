//! `list_position(side, price)` (spec §6, Tier 2). Signer must be the current holder of `side`.
//! One active listing per side, enforced by the Listing PDA.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct ListPosition<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
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
        init,
        payer = seller,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, offer.key().as_ref(), &side.to_le_bytes()],
        bump,
    )]
    pub listing: Box<Account<'info, Listing>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<ListPosition>, _side: u8, _price: u64) -> Result<()> {
    msg!("Position trading is disabled");
    err!(MetrexError::Unauthorized)
}
