//! `refund_offer()` (spec §6, P0.5). Anyone can crank. Market `Voided`, Offer `Accepted`.
//! P → original homeowner, K → original underwriter (regardless of current holders); vault closed.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::MetrexError, events::OfferRefunded, state::*};

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

pub fn handler(ctx: Context<RefundOffer>) -> Result<()> {
    let market = &ctx.accounts.market;
    let offer = &ctx.accounts.offer;
    require!(
        market.status == MarketStatus::Voided,
        MetrexError::InvalidMarketStatus
    );
    require!(
        offer.status == OfferStatus::Accepted,
        MetrexError::InvalidOfferStatus
    );
    let vault = &ctx.accounts.vault;
    require!(vault.mint == ctx.accounts.config.mint, MetrexError::WrongMint);
    require!(vault.owner == offer.key(), MetrexError::WrongTokenOwner);

    let premium = offer.premium;
    // Normally exactly K. Anything sent to the vault from outside also goes back to the
    // underwriter (who funded the vault), so the vault always empties and can close.
    let collateral = vault
        .amount
        .checked_sub(premium)
        .ok_or(MetrexError::MathOverflow)?;
    let homeowner_key = market.homeowner;

    let market_key = offer.market;
    let underwriter_key = offer.underwriter;
    let nonce_bytes = offer.offer_nonce.to_le_bytes();
    let bump = [offer.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        OFFER_SEED,
        market_key.as_ref(),
        underwriter_key.as_ref(),
        &nonce_bytes,
        &bump,
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.homeowner_token.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer_seeds,
        ),
        premium,
    )?;
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.underwriter_token.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer_seeds,
        ),
        collateral,
    )?;
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.underwriter.to_account_info(),
            authority: ctx.accounts.offer.to_account_info(),
        },
        signer_seeds,
    ))?;

    let offer = &mut ctx.accounts.offer;
    offer.status = OfferStatus::Refunded;

    emit!(OfferRefunded {
        market: market_key,
        offer: offer.key(),
        homeowner: homeowner_key,
        underwriter: underwriter_key,
        premium,
        collateral,
    });
    Ok(())
}
