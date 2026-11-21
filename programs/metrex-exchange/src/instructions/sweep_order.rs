//! `sweep_order()` (spec-v2 §5.8). Anyone, once the round is closed, the deadline passed, the order
//! expired or it is fully filled. Escrow and rent always return to the maker; the caller pays any ATA.
//! Account context FROZEN at V0. Body lands at Gate V2; until then it returns `NotImplemented`.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::*, errors::ExchangeError, state::*};

#[derive(Accounts)]
pub struct SweepOrder<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(
        seeds = [MARKET_SEED, round.key().as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
        has_one = round @ ExchangeError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, has_one = market @ ExchangeError::OrderMismatch, close = maker)]
    pub order: Box<Account<'info, Order>>,

    /// CHECK: bound to `order.maker`; receives the order's rent and escrow.
    #[account(mut, address = order.maker @ ExchangeError::InvalidTokenAccount)]
    pub maker: UncheckedAccount<'info>,

    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump = order.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,

    #[account(address = escrow.mint @ ExchangeError::InvalidMint)]
    pub escrow_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = escrow_mint,
        associated_token::authority = maker,
    )]
    pub maker_refund: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<SweepOrder>) -> Result<()> {
    err!(ExchangeError::NotImplemented)
}
