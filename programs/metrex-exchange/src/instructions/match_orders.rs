//! `match_orders(quantity)` (spec-v2 §5.5). Permissionless; executes at the older order's price.
//! Account context FROZEN at V0.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
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

pub fn handler(ctx: Context<MatchOrders>, quantity: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    a.round.require_trading(now)?;
    a.market.require_unresolved()?;
    let (buy, sell) = (&a.buy_order, &a.sell_order);
    require!(buy.side == SIDE_BUY && sell.side == SIDE_SELL, ExchangeError::InvalidSide);
    require!(buy.outcome == sell.outcome, ExchangeError::OrderMismatch);
    require_keys_eq!(
        a.outcome_mint.key(),
        outcome_mint_of(&a.market, buy.outcome)?,
        ExchangeError::InvalidMint
    );
    require_keys_eq!(a.buy_escrow.mint, a.config.collateral_mint, ExchangeError::InvalidMint);
    require_keys_eq!(a.sell_escrow.mint, a.outcome_mint.key(), ExchangeError::InvalidMint);
    require_fillable(buy, now)?;
    require_fillable(sell, now)?;
    require_keys_neq!(buy.maker, sell.maker, ExchangeError::SelfTrade);
    require!(buy.price_bps >= sell.price_bps, ExchangeError::OrdersDoNotCross);
    require!(quantity >= 1, ExchangeError::InvalidQuantity);

    // Execute at the older order's price (lower seq); the buyer is refunded any improvement (I4).
    let buy_is_older = buy.seq < sell.seq;
    let price = if buy_is_older { buy.price_bps } else { sell.price_bps };
    let fill = quantity.min(buy.remaining_qty).min(sell.remaining_qty);
    let quote = quote_amount(fill, price)?;
    let reserved = quote_amount(fill, buy.price_bps)?;
    let refund = reserved
        .checked_sub(quote)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;
    require!(a.sell_escrow.amount >= fill, ExchangeError::InsufficientFunds);
    require!(a.buy_escrow.amount >= reserved, ExchangeError::InsufficientFunds);

    let sell_seeds = OrderSeeds::of(sell);
    transfer(
        &a.token_program,
        &a.sell_escrow,
        &a.buyer_shares,
        sell.to_account_info(),
        Some(&sell_seeds.seeds()),
        fill,
    )?;
    let buy_seeds = OrderSeeds::of(buy);
    transfer(
        &a.token_program,
        &a.buy_escrow,
        &a.seller_collateral,
        buy.to_account_info(),
        Some(&buy_seeds.seeds()),
        quote,
    )?;
    transfer(
        &a.token_program,
        &a.buy_escrow,
        &a.buyer_collateral,
        buy.to_account_info(),
        Some(&buy_seeds.seeds()),
        refund,
    )?;

    let market = a.market.key();
    let maker_order = if buy_is_older { buy.key() } else { sell.key() };
    let buy = &mut ctx.accounts.buy_order;
    buy.remaining_qty = buy
        .remaining_qty
        .checked_sub(fill)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;
    let (buy_key, buyer, outcome) = (buy.key(), buy.maker, buy.outcome);
    let sell = &mut ctx.accounts.sell_order;
    sell.remaining_qty = sell
        .remaining_qty
        .checked_sub(fill)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    emit!(OrderFilled {
        market,
        outcome,
        buy_order: buy_key,
        sell_order: sell.key(),
        buyer,
        seller: sell.maker,
        quantity: fill,
        price_bps: price,
        quote_amount: quote,
        buyer_refund: refund,
        maker_order,
    });
    Ok(())
}
