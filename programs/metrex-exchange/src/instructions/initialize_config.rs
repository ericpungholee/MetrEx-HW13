//! `initialize_config(round_controller, oracle_authority, resolution_timeout_s)` (spec-v2 §6.6).
//! The signer must be the program's upgrade authority (v1.1 pattern).

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{constants::*, errors::ExchangeError, program::MetrexExchange, state::*};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,

    /// mUSD. Every collateral token account is checked against it.
    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ ExchangeError::Unauthorized,
    )]
    pub program: Program<'info, MetrexExchange>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ ExchangeError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    round_controller: Pubkey,
    oracle_authority: Pubkey,
    resolution_timeout_s: i64,
) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    require!(
        round_controller != Pubkey::default()
            && oracle_authority != Pubkey::default()
            && round_controller != oracle_authority
            && round_controller != admin
            && oracle_authority != admin,
        ExchangeError::RoleConflict
    );
    let mint = &ctx.accounts.collateral_mint;
    require!(
        mint.decimals == MUSD_DECIMALS && mint.freeze_authority.is_none(),
        ExchangeError::InvalidMintConfig
    );
    require!(
        (MIN_RESOLUTION_TIMEOUT_S..=MAX_RESOLUTION_TIMEOUT_S).contains(&resolution_timeout_s),
        ExchangeError::InvalidTimeout
    );

    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.round_controller = round_controller;
    config.oracle_authority = oracle_authority;
    config.collateral_mint = mint.key();
    config.latest_round = Pubkey::default();
    config.next_round_id = 1;
    config.resolution_timeout_s = resolution_timeout_s;
    config.version = PROGRAM_VERSION;
    config.bump = ctx.bumps.config;
    Ok(())
}
