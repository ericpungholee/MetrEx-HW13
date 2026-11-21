//! `buy_position()` (spec §6, Tier 2). Atomic: `price` buyer → seller and holder change in one
//! instruction; Listing closed (rent → seller). Never touches the vault (invariant 17).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::MetrexError, events::PositionBought, state::*};

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

pub fn handler(ctx: Context<BuyPosition>) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        MetrexError::InvalidMarketStatus
    );
    let offer = &mut ctx.accounts.offer;
    require!(offer.status == OfferStatus::Accepted, MetrexError::InvalidOfferStatus);
    let listing = &ctx.accounts.listing;
    let protection_holder = offer.protection_holder;
    let risk_holder = offer.risk_holder;
    let (holder, opposite_holder) = match listing.side {
        0 => (&mut offer.protection_holder, risk_holder),
        1 => (&mut offer.risk_holder, protection_holder),
        _ => return err!(MetrexError::InvalidSide),
    };
    let seller = listing.seller;
    let buyer = ctx.accounts.buyer.key();
    require_keys_eq!(seller, *holder, MetrexError::StaleListing);
    require!(buyer != seller && buyer != opposite_holder, MetrexError::SelfTrade);
    let price = listing.price;
    require!(price > 0, MetrexError::InvalidPrice);
    require!(ctx.accounts.buyer_token.amount >= price, MetrexError::InsufficientFunds);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_token.to_account_info(),
                to: ctx.accounts.seller_token.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        price,
    )?;
    *holder = buyer;
    emit!(PositionBought {
        offer: offer.key(), listing: listing.key(), side: listing.side, seller, buyer, price,
    });
    Ok(())
}
