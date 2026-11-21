//! `accept_offer()` (spec §6). Premium P moves homeowner → vault; the vault must cover C.
//! Sets `protection_holder = homeowner`, `risk_holder = underwriter`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::*, errors::MetrexError, events::OfferAccepted, state::*};

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    pub homeowner: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.homeowner.as_ref(), &market.market_nonce.to_le_bytes()],
        bump = market.bump,
        has_one = homeowner @ MetrexError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [
            OFFER_SEED,
            offer.market.as_ref(),
            offer.underwriter.as_ref(),
            &offer.offer_nonce.to_le_bytes(),
        ],
        bump = offer.bump,
        has_one = market @ MetrexError::OfferMarketMismatch,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, offer.key().as_ref()],
        bump = offer.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = homeowner_token.mint == config.mint @ MetrexError::WrongMint,
        constraint = homeowner_token.owner == homeowner.key() @ MetrexError::WrongTokenOwner,
    )]
    pub homeowner_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<AcceptOffer>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.scenario_id == SCENARIO_PALISADES_2025, MetrexError::InvalidScenario);
    let offer = &ctx.accounts.offer;
    require!(
        market.status == MarketStatus::Open,
        MetrexError::InvalidMarketStatus
    );
    require!(
        offer.status == OfferStatus::Open,
        MetrexError::InvalidOfferStatus
    );
    let vault = &ctx.accounts.vault;
    require!(vault.mint == ctx.accounts.config.mint, MetrexError::WrongMint);
    require!(vault.owner == offer.key(), MetrexError::WrongTokenOwner);

    let coverage = offer.coverage;
    let premium = offer.premium;
    let new_activated = market
        .coverage_activated
        .checked_add(coverage)
        .ok_or(MetrexError::MathOverflow)?;
    require!(
        new_activated <= market.coverage_target,
        MetrexError::CoverageExceedsRemaining
    );
    require!(
        ctx.accounts.homeowner_token.amount >= premium,
        MetrexError::InsufficientFunds
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.homeowner_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.homeowner.to_account_info(),
            },
        ),
        premium,
    )?;

    // §4.4: booked coverage must be backed even if the vault holds surplus.
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount >= coverage,
        MetrexError::VaultBalanceMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let homeowner_key = ctx.accounts.homeowner.key();

    let market = &mut ctx.accounts.market;
    market.coverage_activated = new_activated;
    market.accepted_count = market
        .accepted_count
        .checked_add(1)
        .ok_or(MetrexError::MathOverflow)?;
    let market_key = market.key();

    let offer = &mut ctx.accounts.offer;
    offer.status = OfferStatus::Accepted;
    offer.protection_holder = homeowner_key;
    offer.risk_holder = offer.underwriter;
    offer.accepted_at = now;

    emit!(OfferAccepted {
        market: market_key,
        offer: offer.key(),
        homeowner: homeowner_key,
        underwriter: offer.underwriter,
        coverage,
        premium,
        coverage_activated: new_activated,
    });
    Ok(())
}
