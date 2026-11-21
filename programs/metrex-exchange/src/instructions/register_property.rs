//! `register_property(property_id, label, lat_e6, lon_e6, scenario_id, trigger_distance_m)` (spec-v2 §6.2).

use anchor_lang::prelude::*;

use crate::{constants::*, errors::ExchangeError, state::*};

#[derive(Accounts)]
#[instruction(property_id: u16)]
pub struct RegisterProperty<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ExchangeError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Property::INIT_SPACE,
        seeds = [PROPERTY_SEED, &property_id.to_le_bytes()],
        bump,
    )]
    pub property: Box<Account<'info, Property>>,

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
        lat_e6.unsigned_abs() <= MAX_ABS_LAT_E6.unsigned_abs()
            && lon_e6.unsigned_abs() <= MAX_ABS_LON_E6.unsigned_abs(),
        ExchangeError::InvalidCoordinates
    );
    require!(is_supported_scenario(scenario_id), ExchangeError::UnsupportedScenario);
    if is_point_scenario(scenario_id) {
        require!(trigger_distance_m == 0, ExchangeError::InvalidTriggerDistance);
    } else {
        require!(trigger_distance_m > 0, ExchangeError::InvalidTriggerDistance);
    }

    let p = &mut ctx.accounts.property;
    p.property_id = property_id;
    p.label = label;
    p.lat_e6 = lat_e6;
    p.lon_e6 = lon_e6;
    p.scenario_id = scenario_id;
    p.trigger_distance_m = trigger_distance_m;
    p.bump = ctx.bumps.property;
    Ok(())
}
