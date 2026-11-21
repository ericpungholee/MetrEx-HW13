//! `initialize_config(oracle, controller)` (spec §6). Signer must be the program's upgrade authority.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{constants::*, errors::MetrexError, program::Metrex, state::*};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// The mUSD mint. Stored in Config; every token account is checked against it.
    pub mint: Account<'info, Mint>,

    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ MetrexError::Unauthorized,
    )]
    pub program: Program<'info, Metrex>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ MetrexError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>, oracle: Pubkey, controller: Pubkey) -> Result<()> {
    // §2: the oracle and the demo controller are distinct keys, and neither is the default key.
    require!(oracle != controller, MetrexError::Unauthorized);
    require!(
        oracle != Pubkey::default() && controller != Pubkey::default(),
        MetrexError::Unauthorized
    );
    // §4.1: mUSD has 6 decimals.
    require!(
        ctx.accounts.mint.decimals == MUSD_DECIMALS,
        MetrexError::WrongMint
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle;
    config.demo_controller = controller;
    config.mint = ctx.accounts.mint.key();
    config.bump = ctx.bumps.config;
    Ok(())
}
