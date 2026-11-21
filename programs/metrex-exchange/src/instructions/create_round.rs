//! `create_round(scenario_id, dataset_sha256, label, trading_ends_at)` (spec-v2 §6.3, §12).
//! Writes only Config and the new Round: earlier rounds are never touched.
//! Multi-peril (docs/spec-multiperil.md §2.2): several rounds may be Open at once, one per scenario
//! by operator policy. `previous_round` is still accepted (and still must be `config.latest_round`
//! when passed) so the instruction's accounts are unchanged, but it is no longer required.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::ExchangeError, events::RoundCreated, state::*};

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub round_controller: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = round_controller @ ExchangeError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = round_controller,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, &config.next_round_id.to_le_bytes()],
        bump,
    )]
    pub round: Box<Account<'info, Round>>,

    /// `config.latest_round` when passed. Optional and unused since multi-peril. Read-only.
    #[account(constraint = previous_round.key() == config.latest_round @ ExchangeError::PreviousRoundOpen)]
    pub previous_round: Option<Box<Account<'info, Round>>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateRound>,
    scenario_id: u16,
    dataset_sha256: [u8; 32],
    label: [u8; 32],
    trading_ends_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;

    require!(is_supported_scenario(scenario_id), ExchangeError::UnsupportedScenario);
    require!(dataset_sha256 != [0u8; 32], ExchangeError::InvalidEvidenceHash);
    let max_end = now
        .checked_add(MAX_ROUND_DURATION_S)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;
    require!(
        trading_ends_at > now && trading_ends_at <= max_end,
        ExchangeError::InvalidDeadline
    );

    let round = &mut ctx.accounts.round;
    round.round_id = config.next_round_id;
    round.scenario_id = scenario_id;
    round.dataset_sha256 = dataset_sha256;
    round.label = label;
    round.status = RoundStatus::Open;
    round.created_at = now;
    round.trading_ends_at = trading_ends_at;
    round.closed_at = 0;
    round.market_count = 0;
    round.resolved_count = 0;
    round.bump = ctx.bumps.round;

    config.latest_round = round.key();
    config.next_round_id = config
        .next_round_id
        .checked_add(1)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;

    emit!(RoundCreated {
        round: round.key(),
        round_id: round.round_id,
        scenario_id,
        dataset_sha256,
        trading_ends_at,
    });
    Ok(())
}
