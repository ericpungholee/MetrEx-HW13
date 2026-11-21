//! `place_offer(offer_nonce, coverage, premium_bps)` (spec §6). Premium and collateral are
//! computed on-chain (§4.2); collateral K moves underwriter → vault.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
#[instruction(offer_nonce: u64)]
pub struct PlaceOffer<'info> {
    #[account(mut)]
    pub underwriter: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = underwriter,
        space = 8 + Offer::INIT_SPACE,
        seeds = [
            OFFER_SEED,
            market.key().as_ref(),
            underwriter.key().as_ref(),
            &offer_nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub offer: Box<Account<'info, Offer>>,

    /// Declared before `vault` because the vault's `init` reads it.
    #[account(address = config.mint @ MetrexError::WrongMint)]
    pub mint: Box<Account<'info, Mint>>,

    /// Escrow for this offer. Token authority is the Offer PDA (§5.5).
    #[account(
        init,
        payer = underwriter,
        seeds = [VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = offer,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = underwriter_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = underwriter_token.owner == underwriter.key() @ MetrexError::WrongTokenOwner,
    )]
    pub underwriter_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    _ctx: Context<PlaceOffer>,
    _offer_nonce: u64,
    _coverage: u64,
    _premium_bps: u16,
) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
