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
    ctx: Context<RegisterProperty>,
    property_id: u16,
    label: [u8; 32],
    lat_e6: i32,
    lon_e6: i32,
    scenario_id: u16,
    trigger_distance_m: u32,
) -> Result<()> {
    // `unsigned_abs` avoids the overflow of `i32::MIN.abs()`.
    require!(
        lat_e6.unsigned_abs() <= MAX_ABS_LAT_E6.unsigned_abs(),
        MetrexError::InvalidCoordinates
    );
    require!(
        lon_e6.unsigned_abs() <= MAX_ABS_LON_E6.unsigned_abs(),
        MetrexError::InvalidCoordinates
    );
    require!(trigger_distance_m > 0, MetrexError::InvalidCoordinates);

    require!(scenario_id == SCENARIO_PALISADES_2025, MetrexError::InvalidScenario);
    let property = &mut ctx.accounts.property;
    property.property_id = property_id;
    property.label = label;
    property.lat_e6 = lat_e6;
    property.lon_e6 = lon_e6;
    property.scenario_id = scenario_id;
    property.trigger_distance_m = trigger_distance_m;
    property.bump = ctx.bumps.property;
    Ok(())
}
