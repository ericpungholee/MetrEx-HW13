//! `cancel_offer()` (spec §6). Works in every market status for an `Open` offer.
//! Vault → underwriter; vault closed (rent → underwriter).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::MetrexError, events::OfferCancelled, state::*};

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub underwriter: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [
            OFFER_SEED,
            offer.market.as_ref(),
            offer.underwriter.as_ref(),
            &offer.offer_nonce.to_le_bytes(),
        ],
        bump = offer.bump,
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
        constraint = underwriter_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = underwriter_token.owner == underwriter.key() @ MetrexError::WrongTokenOwner,
    )]
    pub underwriter_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelOffer>) -> Result<()> {
    let offer = &ctx.accounts.offer;
    require!(
        offer.status == OfferStatus::Open,
        MetrexError::InvalidOfferStatus
    );
    let vault = &ctx.accounts.vault;
    require!(vault.mint == ctx.accounts.config.mint, MetrexError::WrongMint);
    require!(vault.owner == offer.key(), MetrexError::WrongTokenOwner);

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
    // Normally exactly K; the whole balance leaves so the vault can close.
    let refunded = vault.amount;

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
        refunded,
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
    offer.status = OfferStatus::Cancelled;

    emit!(OfferCancelled {
        market: market_key,
        offer: offer.key(),
        underwriter: underwriter_key,
        refunded,
    });
    Ok(())
}
