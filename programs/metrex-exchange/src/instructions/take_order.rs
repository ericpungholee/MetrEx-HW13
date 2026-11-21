//! `take_order(quantity, limit_price_bps, expected_seq)` (spec-v2 §5.7).
//! Account context FROZEN at V0. Body lands at Gate V2; until then it returns `NotImplemented`.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::*, errors::ExchangeError, state::*};

#[derive(Accounts)]
pub struct TakeOrder<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// Read-only: fills never write Round (§6.6).
    #[account(seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    /// Read-only: fills never write Market (§6.6).
    #[account(
        seeds = [MARKET_SEED, round.key().as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
        has_one = round @ ExchangeError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, has_one = market @ ExchangeError::OrderMismatch)]
    pub order: Box<Account<'info, Order>>,

    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump = order.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,

    #[account(address = escrow.mint @ ExchangeError::InvalidMint)]
    pub escrow_mint: Box<Account<'info, Mint>>,

    /// The counter-asset (checked against the order's side and outcome in the handler).
    #[account(
        constraint = receive_mint.key() == config.collateral_mint
            || receive_mint.key() == market.yes_mint
            || receive_mint.key() == market.no_mint @ ExchangeError::InvalidMint,
    )]
    pub receive_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = get_associated_token_address(&order.maker, &receive_mint.key())
            @ ExchangeError::InvalidTokenAccount,
    )]
    pub maker_receive: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = taker_source.mint == receive_mint.key() @ ExchangeError::InvalidMint,
        constraint = taker_source.owner == taker.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub taker_source: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = escrow_mint,
        associated_token::authority = taker,
    )]
    pub taker_receive: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    _ctx: Context<TakeOrder>,
    _quantity: u64,
    _limit_price_bps: u16,
    _expected_seq: u64,
) -> Result<()> {
    err!(ExchangeError::NotImplemented)
}
