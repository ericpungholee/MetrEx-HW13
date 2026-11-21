//! `match_orders(quantity)` (spec-v2 §5.5). Permissionless; executes at the older order's price.
//! Account context FROZEN at V0. Body lands at Gate V2; until then it returns `NotImplemented`.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::*, errors::ExchangeError, state::*};

#[derive(Accounts)]
pub struct MatchOrders<'info> {
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

    #[account(
        constraint = outcome_mint.key() == market.yes_mint
            || outcome_mint.key() == market.no_mint @ ExchangeError::InvalidMint,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,

    #[account(address = config.collateral_mint @ ExchangeError::InvalidMint)]
    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(mut, has_one = market @ ExchangeError::OrderMismatch)]
    pub buy_order: Box<Account<'info, Order>>,

    #[account(mut, seeds = [ESCROW_SEED, buy_order.key().as_ref()], bump = buy_order.escrow_bump)]
    pub buy_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, has_one = market @ ExchangeError::OrderMismatch)]
    pub sell_order: Box<Account<'info, Order>>,

    #[account(mut, seeds = [ESCROW_SEED, sell_order.key().as_ref()], bump = sell_order.escrow_bump)]
    pub sell_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = get_associated_token_address(&buy_order.maker, &outcome_mint.key())
            @ ExchangeError::InvalidTokenAccount,
    )]
    pub buyer_shares: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = get_associated_token_address(&buy_order.maker, &collateral_mint.key())
            @ ExchangeError::InvalidTokenAccount,
    )]
    pub buyer_collateral: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = get_associated_token_address(&sell_order.maker, &collateral_mint.key())
            @ ExchangeError::InvalidTokenAccount,
    )]
    pub seller_collateral: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(_ctx: Context<MatchOrders>, _quantity: u64) -> Result<()> {
    err!(ExchangeError::NotImplemented)
}
