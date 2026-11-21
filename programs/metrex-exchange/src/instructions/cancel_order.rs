//! `cancel_order()` (spec-v2 §5.8). Maker only, any state. Escrow and rent return to the maker.
//! Account context FROZEN at V0.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constants::*,
    errors::ExchangeError,
    events::{OrderCancelled},
    instructions::order_common::*,
    state::*,
};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [MARKET_SEED, market.round.as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        has_one = market @ ExchangeError::OrderMismatch,
        has_one = maker @ ExchangeError::Unauthorized,
        close = maker,
    )]
    pub order: Box<Account<'info, Order>>,

    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump = order.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,

    #[account(address = escrow.mint @ ExchangeError::InvalidMint)]
    pub escrow_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = escrow_mint,
        associated_token::authority = maker,
    )]
    pub maker_refund: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelOrder>) -> Result<()> {
    let a = &ctx.accounts;
    let returned = return_escrow(
        &a.token_program,
        &a.order,
        &a.escrow,
        &a.maker_refund,
        a.maker.to_account_info(),
    )?;
    emit!(OrderCancelled {
        market: a.market.key(),
        order: a.order.key(),
        maker: a.maker.key(),
        swept: false,
        remaining_qty: a.order.remaining_qty,
        returned_amount: returned,
    });
    // `close = maker` returns the Order's rent to the maker.
    Ok(())
}
