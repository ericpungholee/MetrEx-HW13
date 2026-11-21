//! `create_market()` (spec-v2 §6.4). One market per (round, property); creates both outcome
//! mints (0 decimals, market PDA as mint authority, no freeze authority) and the vault.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, errors::ExchangeError, events::MarketCreated, state::*};

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub round_controller: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = round_controller @ ExchangeError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(seeds = [PROPERTY_SEED, &property.property_id.to_le_bytes()], bump = property.bump)]
    pub property: Box<Account<'info, Property>>,

    #[account(
        init,
        payer = round_controller,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, round.key().as_ref(), &property.property_id.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = round_controller,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = SHARE_DECIMALS,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = round_controller,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = SHARE_DECIMALS,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(address = config.collateral_mint @ ExchangeError::InvalidMint)]
    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = round_controller,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    round.require_trading(now)?;
    let property = &ctx.accounts.property;
    require!(property.scenario_id == round.scenario_id, ExchangeError::ScenarioMismatch);

    let market = &mut ctx.accounts.market;
    market.round = round.key();
    market.property_id = property.property_id;
    market.scenario_id = property.scenario_id;
    market.lat_e6 = property.lat_e6;
    market.lon_e6 = property.lon_e6;
    market.trigger_distance_m = property.trigger_distance_m;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.outcome = Outcome::Unresolved;
    market.evidence_hash = [0u8; 32];
    market.pairs_outstanding = 0;
    market.next_order_seq = 1;
    market.created_at = now;
    market.resolved_at = 0;
    market.resolution_path = PATH_NONE;
    market.invalid_reason = 0;
    market.bump = ctx.bumps.market;
    market.yes_mint_bump = ctx.bumps.yes_mint;
    market.no_mint_bump = ctx.bumps.no_mint;
    market.vault_bump = ctx.bumps.vault;

    round.market_count = round
        .market_count
        .checked_add(1)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    emit!(MarketCreated {
        market: market.key(),
        round: round.key(),
        property_id: property.property_id,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
    });
    Ok(())
}
