//! `place_order(client_nonce, outcome, side, price_bps, quantity, expires_at)` (spec-v2 §5.6).
//! Account context FROZEN at V0. Body lands at Gate V2; until then it returns `NotImplemented`.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{constants::*, errors::ExchangeError, state::*};

#[derive(Accounts)]
#[instruction(client_nonce: u64)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, round.key().as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
        has_one = round @ ExchangeError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = maker,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, market.key().as_ref(), maker.key().as_ref(), &client_nonce.to_le_bytes()],
        bump,
    )]
    pub order: Box<Account<'info, Order>>,

    /// Collateral for BUY, the outcome mint for SELL (side/outcome match checked in the handler).
    #[account(
        constraint = escrow_mint.key() == config.collateral_mint
            || escrow_mint.key() == market.yes_mint
            || escrow_mint.key() == market.no_mint @ ExchangeError::InvalidMint,
    )]
    pub escrow_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = maker,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = escrow_mint,
        token::authority = order,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = maker_source.mint == escrow_mint.key() @ ExchangeError::InvalidMint,
        constraint = maker_source.owner == maker.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub maker_source: Box<Account<'info, TokenAccount>>,

    /// The outcome mint for BUY, collateral for SELL.
    #[account(
        constraint = receive_mint.key() == config.collateral_mint
            || receive_mint.key() == market.yes_mint
            || receive_mint.key() == market.no_mint @ ExchangeError::InvalidMint,
    )]
    pub receive_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = receive_mint,
        associated_token::authority = maker,
    )]
    pub maker_receive: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    _ctx: Context<PlaceOrder>,
    _client_nonce: u64,
    _outcome: u8,
    _side: u8,
    _price_bps: u16,
    _quantity: u64,
    _expires_at: i64,
) -> Result<()> {
    err!(ExchangeError::NotImplemented)
}
