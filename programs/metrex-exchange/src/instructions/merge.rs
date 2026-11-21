//! `merge(quantity)` (spec-v2 §4.3): burn `q` YES + `q` NO and release `q × 1 mUSD`, atomically.
//! Allowed while the market is Unresolved, including after the round closes.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::ExchangeError, events::SharesMerged, state::*};

#[derive(Accounts)]
pub struct Merge<'info> {
    pub holder: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, round.key().as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
        has_one = round @ ExchangeError::Unauthorized,
        has_one = yes_mint @ ExchangeError::InvalidMint,
        has_one = no_mint @ ExchangeError::InvalidMint,
        has_one = vault @ ExchangeError::InvalidTokenAccount,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = config.collateral_mint @ ExchangeError::InvalidMint)]
    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = holder_collateral.mint == collateral_mint.key() @ ExchangeError::InvalidMint,
        constraint = holder_collateral.owner == holder.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub holder_collateral: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_yes.mint == yes_mint.key() @ ExchangeError::InvalidMint,
        constraint = holder_yes.owner == holder.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub holder_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_no.mint == no_mint.key() @ ExchangeError::InvalidMint,
        constraint = holder_no.owner == holder.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub holder_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Merge>, quantity: u64) -> Result<()> {
    let a = &ctx.accounts;
    a.market.require_unresolved()?;
    require!(quantity >= 1, ExchangeError::InvalidQuantity);
    require!(quantity <= a.market.pairs_outstanding, ExchangeError::InsufficientPairs);
    require!(
        a.holder_yes.amount >= quantity && a.holder_no.amount >= quantity,
        ExchangeError::InsufficientFunds
    );
    let amount = checked_mul(quantity, PAYOUT_PER_SHARE)?;
    require!(a.vault.amount >= amount, ExchangeError::InsufficientFunds);

    for (mint, from) in [(&a.yes_mint, &a.holder_yes), (&a.no_mint, &a.holder_no)] {
        token::burn(
            CpiContext::new(
                a.token_program.to_account_info(),
                Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: a.holder.to_account_info(),
                },
            ),
            quantity,
        )?;
    }

    let round_key = a.market.round;
    let pid = a.market.property_id.to_le_bytes();
    let bump = [a.market.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, round_key.as_ref(), &pid, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer {
                from: a.vault.to_account_info(),
                to: a.holder_collateral.to_account_info(),
                authority: a.market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    let market = &mut ctx.accounts.market;
    market.pairs_outstanding = market
        .pairs_outstanding
        .checked_sub(quantity)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    emit!(SharesMerged {
        market: market.key(),
        holder: ctx.accounts.holder.key(),
        quantity,
        amount,
    });
    Ok(())
}
