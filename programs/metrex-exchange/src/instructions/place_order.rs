//! `place_order(client_nonce, outcome, side, price_bps, quantity, expires_at)` (spec-v2 §5.6).
//! Account context FROZEN at V0.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constants::*,
    errors::ExchangeError,
    events::{OrderPlaced},
    instructions::order_common::*,
    state::*,
};

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
    ctx: Context<PlaceOrder>,
    client_nonce: u64,
    outcome: u8,
    side: u8,
    price_bps: u16,
    quantity: u64,
    expires_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    a.round.require_trading(now)?;
    a.market.require_unresolved()?;
    let (escrow_mint, receive_mint) = order_mints(&a.config, &a.market, outcome, side)?;
    require!(
        (MIN_PRICE_BPS..=MAX_PRICE_BPS).contains(&price_bps),
        ExchangeError::InvalidPrice
    );
    require!(
        (MIN_ORDER_QTY..=MAX_ORDER_QTY).contains(&quantity),
        ExchangeError::InvalidQuantity
    );
    require!(expires_at == 0 || expires_at > now, ExchangeError::InvalidExpiry);
    require_keys_eq!(a.escrow_mint.key(), escrow_mint, ExchangeError::InvalidMint);
    require_keys_eq!(a.receive_mint.key(), receive_mint, ExchangeError::InvalidMint);

    let amount = escrow_reserve(side, quantity, price_bps)?;
    require!(a.maker_source.amount >= amount, ExchangeError::InsufficientFunds);
    transfer(
        &a.token_program,
        &a.maker_source,
        &a.escrow,
        a.maker.to_account_info(),
        None,
        amount,
    )?;

    let market = &mut ctx.accounts.market;
    let seq = market.next_order_seq;
    market.next_order_seq = seq
        .checked_add(1)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    let order = &mut ctx.accounts.order;
    order.market = market.key();
    order.maker = ctx.accounts.maker.key();
    order.client_nonce = client_nonce;
    order.outcome = outcome;
    order.side = side;
    order.price_bps = price_bps;
    order.original_qty = quantity;
    order.remaining_qty = quantity;
    order.seq = seq;
    order.expires_at = expires_at;
    order.created_at = now;
    order.bump = ctx.bumps.order;
    order.escrow_bump = ctx.bumps.escrow;

    emit!(OrderPlaced {
        market: order.market,
        order: order.key(),
        maker: order.maker,
        outcome,
        side,
        price_bps,
        quantity,
        seq,
        expires_at,
    });
    Ok(())
}
