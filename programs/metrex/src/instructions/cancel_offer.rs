//! `cancel_offer()` (spec §6). Works in every market status for an `Open` offer.
//! Vault → underwriter; vault closed (rent → underwriter).

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{constants::*, errors::MetrexError, state::*};

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

pub fn handler(_ctx: Context<CancelOffer>) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
