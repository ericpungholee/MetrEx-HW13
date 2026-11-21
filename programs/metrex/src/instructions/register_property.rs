//! `register_property(property_id, label, lat_e6, lon_e6, scenario_id, trigger_distance_m)` (spec §6).

use anchor_lang::prelude::*;

use crate::{constants::*, errors::MetrexError, state::*};

#[derive(Accounts)]
#[instruction(property_id: u16)]
pub struct RegisterProperty<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ MetrexError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + Property::INIT_SPACE,
        seeds = [PROPERTY_SEED, &property_id.to_le_bytes()],
        bump,
    )]
    pub property: Account<'info, Property>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    _ctx: Context<RegisterProperty>,
    _property_id: u16,
    _label: [u8; 32],
    _lat_e6: i32,
    _lon_e6: i32,
    _scenario_id: u16,
    _trigger_distance_m: u32,
) -> Result<()> {
    // Workstream A (Gate 1).
    Ok(())
}
