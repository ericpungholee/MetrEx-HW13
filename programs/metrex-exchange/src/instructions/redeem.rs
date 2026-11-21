//! `redeem(outcome, quantity)` (spec-v2 §4.4): burn the signer's own shares and pay the signer's
//! own mUSD account. Yes/No pay 1 mUSD per winning share; Invalid pays 0.5 mUSD per share of either.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::ExchangeError, events::SharesRedeemed, state::*};

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub holder: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [MARKET_SEED, market.round.as_ref(), &market.property_id.to_le_bytes()],
        bump = market.bump,
        has_one = vault @ ExchangeError::InvalidTokenAccount,
    )]
    pub market: Box<Account<'info, Market>>,

    /// The market's YES or NO mint, matching `outcome` (checked in the handler).
    #[account(mut)]
    pub outcome_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_shares.mint == outcome_mint.key() @ ExchangeError::InvalidMint,
        constraint = holder_shares.owner == holder.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub holder_shares: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_collateral.mint == config.collateral_mint @ ExchangeError::InvalidMint,
        constraint = holder_collateral.owner == holder.key() @ ExchangeError::InvalidTokenAccount,
    )]
    pub holder_collateral: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Redeem>, outcome: u8, quantity: u64) -> Result<()> {
    let a = &ctx.accounts;
    let market = &a.market;
    let expected_mint = match outcome {
        OUTCOME_YES => market.yes_mint,
        OUTCOME_NO => market.no_mint,
        _ => return err!(ExchangeError::InvalidOutcome),
    };
    require_keys_eq!(a.outcome_mint.key(), expected_mint, ExchangeError::InvalidMint);

    let per_share = match (market.outcome, outcome) {
        (Outcome::Unresolved, _) => return err!(ExchangeError::MarketNotResolved),
        (Outcome::Yes, OUTCOME_YES) | (Outcome::No, OUTCOME_NO) => PAYOUT_PER_SHARE,
        (Outcome::Invalid, _) => INVALID_PAYOUT_PER_SHARE,
        _ => return err!(ExchangeError::LosingOutcome),
    };
    require!(quantity >= 1, ExchangeError::InvalidQuantity);
    require!(a.holder_shares.amount >= quantity, ExchangeError::InsufficientFunds);
    let payout = checked_mul(quantity, per_share)?;
    require!(a.vault.amount >= payout, ExchangeError::InsufficientFunds);

    token::burn(
        CpiContext::new(
            a.token_program.to_account_info(),
            Burn {
                mint: a.outcome_mint.to_account_info(),
                from: a.holder_shares.to_account_info(),
                authority: a.holder.to_account_info(),
            },
        ),
        quantity,
    )?;

    let round_key = market.round;
    let pid = market.property_id.to_le_bytes();
    let bump = [market.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, round_key.as_ref(), &pid, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer {
                from: a.vault.to_account_info(),
                to: a.holder_collateral.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        payout,
    )?;

    emit!(SharesRedeemed {
        market: market.key(),
        holder: a.holder.key(),
        outcome,
        quantity,
        payout,
    });
    Ok(())
}
