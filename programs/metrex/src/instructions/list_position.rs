//! `list_position(side, price)` (spec §6, Tier 2). Signer must be the current holder of `side`.
//! One active listing per side, enforced by the Listing PDA.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, events::PositionListed, state::*};

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

pub fn handler(ctx: Context<ListPosition>, side: u8, price: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    let offer = &ctx.accounts.offer;
    require!(
        matches!(market.status, MarketStatus::Open | MarketStatus::Closed),
        MetrexError::InvalidMarketStatus
    );
    require!(offer.status == OfferStatus::Accepted, MetrexError::InvalidOfferStatus);
    let holder = match side {
        0 => offer.protection_holder,
        1 => offer.risk_holder,
        _ => return err!(MetrexError::InvalidSide),
    };
    let seller = ctx.accounts.seller.key();
    require_keys_eq!(seller, holder, MetrexError::NotHolder);
    require!(price > 0, MetrexError::InvalidPrice);

    let listing = &mut ctx.accounts.listing;
    listing.offer = offer.key();
    listing.side = side;
    listing.seller = seller;
    listing.price = price;
    listing.created_at = Clock::get()?.unix_timestamp;
    listing.bump = ctx.bumps.listing;

    emit!(PositionListed { offer: listing.offer, listing: listing.key(), side, seller, price });
    Ok(())
}
