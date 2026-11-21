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

pub fn handler(_ctx: Context<InitializeConfig>, _oracle: Pubkey, _controller: Pubkey) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
