//! `take_order(quantity, limit_price_bps, expected_seq)` (spec-v2 §5.7).
//! Account context FROZEN at V0.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constants::*,
    errors::ExchangeError,
    events::{OrderFilled},
    instructions::order_common::*,
    state::*,
};

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
    ctx: Context<TakeOrder>,
    quantity: u64,
    limit_price_bps: u16,
    expected_seq: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    a.round.require_trading(now)?;
    a.market.require_unresolved()?;
    let order = &a.order;
    require!(order.seq == expected_seq, ExchangeError::OrderSeqMismatch);
    require_fillable(order, now)?;
    require_keys_neq!(a.taker.key(), order.maker, ExchangeError::SelfTrade);
    require!(quantity >= 1, ExchangeError::InvalidQuantity);

    let (escrow_mint, receive_mint) = order_mints(&a.config, &a.market, order.outcome, order.side)?;
    require_keys_eq!(a.escrow_mint.key(), escrow_mint, ExchangeError::InvalidMint);
    require_keys_eq!(a.receive_mint.key(), receive_mint, ExchangeError::InvalidMint);

    // The taker trades at the resting order's price, never outside its own limit (I4).
    let price = order.price_bps;
    let taker_buys = order.side == SIDE_SELL;
    if taker_buys {
        require!(price <= limit_price_bps, ExchangeError::PriceLimitExceeded);
    } else {
        require!(price >= limit_price_bps, ExchangeError::PriceLimitExceeded);
    }

    let fill = quantity.min(order.remaining_qty);
    let quote = quote_amount(fill, price)?;
    // Taker pays the maker in the counter-asset; the escrow pays the taker.
    let (to_maker, from_escrow) = if taker_buys { (quote, fill) } else { (fill, quote) };
    require!(a.taker_source.amount >= to_maker, ExchangeError::InsufficientFunds);
    require!(a.escrow.amount >= from_escrow, ExchangeError::InsufficientFunds);

    transfer(
        &a.token_program,
        &a.taker_source,
        &a.maker_receive,
        a.taker.to_account_info(),
        None,
        to_maker,
    )?;
    let s = OrderSeeds::of(order);
    transfer(
        &a.token_program,
        &a.escrow,
        &a.taker_receive,
        order.to_account_info(),
        Some(&s.seeds()),
        from_escrow,
    )?;

    let taker = a.taker.key();
    let market = a.market.key();
    let order = &mut ctx.accounts.order;
    order.remaining_qty = order
        .remaining_qty
        .checked_sub(fill)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    let (buy_order, sell_order, buyer, seller) = if taker_buys {
        (Pubkey::default(), order.key(), taker, order.maker)
    } else {
        (order.key(), Pubkey::default(), order.maker, taker)
    };
    emit!(OrderFilled {
        market,
        outcome: order.outcome,
        buy_order,
        sell_order,
        buyer,
        seller,
        quantity: fill,
        price_bps: price,
        quote_amount: quote,
        buyer_refund: 0,
        maker_order: order.key(),
    });
    Ok(())
}
