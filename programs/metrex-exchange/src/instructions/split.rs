//! `split(quantity)` (spec-v2 §4.1): lock `q × 1 mUSD` in the vault and mint `q` YES + `q` NO, atomically.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::{constants::*, errors::ExchangeError, events::SharesSplit, state::*};

#[derive(Accounts)]
pub struct Split<'info> {
    #[account(mut)]
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
        init_if_needed,
        payer = holder,
        associated_token::mint = yes_mint,
        associated_token::authority = holder,
    )]
    pub holder_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = holder,
        associated_token::mint = no_mint,
        associated_token::authority = holder,
    )]
    pub holder_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Split>, quantity: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.round.require_trading(now)?;
    ctx.accounts.market.require_unresolved()?;
    require!(
        (1..=MAX_SPLIT_QTY).contains(&quantity),
        ExchangeError::InvalidQuantity
    );
    let amount = checked_mul(quantity, PAYOUT_PER_SHARE)?;
    require!(
        ctx.accounts.holder_collateral.amount >= amount,
        ExchangeError::InsufficientFunds
    );

    let a = &ctx.accounts;
    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.holder_collateral.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.holder.to_account_info(),
            },
        ),
        amount,
    )?;

    let round_key = a.market.round;
    let pid = a.market.property_id.to_le_bytes();
    let bump = [a.market.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, round_key.as_ref(), &pid, &bump];
    let signer = &[seeds];
    for (mint, to) in [
        (&a.yes_mint, &a.holder_yes),
        (&a.no_mint, &a.holder_no),
    ] {
        token::mint_to(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                MintTo {
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: a.market.to_account_info(),
                },
                signer,
            ),
            quantity,
        )?;
    }

    let market = &mut ctx.accounts.market;
    market.pairs_outstanding = market
        .pairs_outstanding
        .checked_add(quantity)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    emit!(SharesSplit {
        market: market.key(),
        holder: ctx.accounts.holder.key(),
        quantity,
        amount,
    });
    Ok(())
}
