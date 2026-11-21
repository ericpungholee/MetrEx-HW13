//! `place_offer(offer_nonce, coverage, premium_bps)` (spec §6). Premium and collateral are
//! computed on-chain (§4.2); collateral K moves underwriter → vault.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::MetrexError, events::OfferPlaced, state::*};

#[derive(Accounts)]
#[instruction(offer_nonce: u64)]
pub struct PlaceOffer<'info> {
    #[account(mut)]
    pub underwriter: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = underwriter,
        space = 8 + Offer::INIT_SPACE,
        seeds = [
            OFFER_SEED,
            market.key().as_ref(),
            underwriter.key().as_ref(),
            &offer_nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub offer: Box<Account<'info, Offer>>,

    /// Declared before `vault` because the vault's `init` reads it.
    #[account(address = config.mint @ MetrexError::WrongMint)]
    pub mint: Box<Account<'info, Mint>>,

    /// Escrow for this offer. Token authority is the Offer PDA (§5.5).
    #[account(
        init,
        payer = underwriter,
        seeds = [VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = offer,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = underwriter_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = underwriter_token.owner == underwriter.key() @ MetrexError::WrongTokenOwner,
    )]
    pub underwriter_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<PlaceOffer>,
    offer_nonce: u64,
    coverage: u64,
    premium_bps: u16,
) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        MetrexError::InvalidMarketStatus
    );
    require!(
        ctx.accounts.underwriter.key() != market.homeowner,
        MetrexError::SelfUnderwriting
    );
    require!(
        (MIN_BPS..=MAX_BPS).contains(&premium_bps),
        MetrexError::InvalidBps
    );
    require!(coverage >= MIN_COVERAGE, MetrexError::CoverageTooSmall);
    require!(
        coverage <= market.coverage_target,
        MetrexError::CoverageExceedsTarget
    );

    // §4.2: P = floor(C × b / 10_000) with a u128 intermediate; K = C − P.
    let premium_u128 = (coverage as u128)
        .checked_mul(premium_bps as u128)
        .ok_or(MetrexError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(MetrexError::MathOverflow)?;
    let premium = u64::try_from(premium_u128).map_err(|_| MetrexError::MathOverflow)?;
    require!(premium >= 1, MetrexError::PremiumRoundsToZero);
    let collateral = coverage
        .checked_sub(premium)
        .ok_or(MetrexError::MathOverflow)?;

    require!(
        ctx.accounts.underwriter_token.amount >= collateral,
        MetrexError::InsufficientFunds
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.underwriter_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.underwriter.to_account_info(),
            },
        ),
        collateral,
    )?;

    // §4.4: an Open offer's vault holds exactly K.
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount == collateral,
        MetrexError::VaultBalanceMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let underwriter_key = ctx.accounts.underwriter.key();
    let offer = &mut ctx.accounts.offer;
    offer.market = market_key;
    offer.underwriter = underwriter_key;
    offer.offer_nonce = offer_nonce;
    offer.coverage = coverage;
    offer.premium_bps = premium_bps;
    offer.premium = premium;
    offer.collateral = collateral;
    offer.protection_holder = Pubkey::default();
    offer.risk_holder = Pubkey::default();
    offer.status = OfferStatus::Open;
    offer.created_at = now;
    offer.accepted_at = 0;
    offer.bump = ctx.bumps.offer;
    offer.vault_bump = ctx.bumps.vault;

    emit!(OfferPlaced {
        market: market_key,
        offer: offer.key(),
        underwriter: underwriter_key,
        coverage,
        premium_bps,
        premium,
        collateral,
    });
    Ok(())
}
