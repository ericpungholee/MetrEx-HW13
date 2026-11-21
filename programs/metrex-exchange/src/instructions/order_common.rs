//! Shared order logic (spec-v2 §5). Not an instruction; no account context.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::ExchangeError, state::*};

/// The outcome mint an order trades (`OUTCOME_YES` → YES mint, `OUTCOME_NO` → NO mint).
pub(crate) fn outcome_mint_of(market: &Market, outcome: u8) -> Result<Pubkey> {
    match outcome {
        OUTCOME_YES => Ok(market.yes_mint),
        OUTCOME_NO => Ok(market.no_mint),
        _ => err!(ExchangeError::InvalidOutcome),
    }
}

/// `(escrow mint, counter-asset mint)` for an order: BUY escrows mUSD and receives shares,
/// SELL escrows shares and receives mUSD (§5.2).
pub(crate) fn order_mints(config: &Config, market: &Market, outcome: u8, side: u8) -> Result<(Pubkey, Pubkey)> {
    let shares = outcome_mint_of(market, outcome)?;
    match side {
        SIDE_BUY => Ok((config.collateral_mint, shares)),
        SIDE_SELL => Ok((shares, config.collateral_mint)),
        _ => err!(ExchangeError::InvalidSide),
    }
}

/// Escrow required to back `qty` remaining shares of an order (I3).
pub(crate) fn escrow_reserve(side: u8, qty: u64, price_bps: u16) -> Result<u64> {
    match side {
        SIDE_BUY => quote_amount(qty, price_bps),
        SIDE_SELL => Ok(qty),
        _ => err!(ExchangeError::InvalidSide),
    }
}

/// Active for filling (§5.2): exists, `remaining > 0`, not expired. The round and market checks
/// are done by the caller once per instruction.
pub(crate) fn require_fillable(order: &Order, now: i64) -> Result<()> {
    require!(order.remaining_qty > 0, ExchangeError::OrderNotActive);
    require!(
        order.expires_at == 0 || now < order.expires_at,
        ExchangeError::OrderExpired
    );
    Ok(())
}

/// Seeds of the order PDA, which is the escrow authority.
pub(crate) struct OrderSeeds {
    market: Pubkey,
    maker: Pubkey,
    nonce: [u8; 8],
    bump: [u8; 1],
}

impl OrderSeeds {
    pub(crate) fn of(order: &Order) -> Self {
        Self {
            market: order.market,
            maker: order.maker,
            nonce: order.client_nonce.to_le_bytes(),
            bump: [order.bump],
        }
    }

    pub(crate) fn seeds(&self) -> [&[u8]; 5] {
        [ORDER_SEED, self.market.as_ref(), self.maker.as_ref(), &self.nonce, &self.bump]
    }
}

/// SPL transfer; `signer` is the order PDA's seeds when the escrow pays. Zero amounts are skipped.
pub(crate) fn transfer<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    signer: Option<&[&[u8]]>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer {
        from: from.to_account_info(),
        to: to.to_account_info(),
        authority,
    };
    match signer {
        Some(seeds) => token::transfer(
            CpiContext::new_with_signer(token_program.to_account_info(), accounts, &[seeds]),
            amount,
        ),
        None => token::transfer(CpiContext::new(token_program.to_account_info(), accounts), amount),
    }
}

/// Cancel and sweep (§5.8, I11): move the **entire** escrow balance (including any unsolicited
/// surplus) to the maker's ATA, then close the escrow with its rent to the maker. Returns the amount.
pub(crate) fn return_escrow<'info>(
    token_program: &Program<'info, Token>,
    order: &Account<'info, Order>,
    escrow: &Account<'info, TokenAccount>,
    maker_refund: &Account<'info, TokenAccount>,
    maker: AccountInfo<'info>,
) -> Result<u64> {
    let returned = escrow.amount;
    let s = OrderSeeds::of(order);
    let seeds = s.seeds();
    transfer(token_program, escrow, maker_refund, order.to_account_info(), Some(&seeds), returned)?;
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: escrow.to_account_info(),
            destination: maker,
            authority: order.to_account_info(),
        },
        &[&seeds[..]],
    ))?;
    Ok(returned)
}
