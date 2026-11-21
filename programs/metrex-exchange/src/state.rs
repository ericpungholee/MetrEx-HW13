//! Account layouts (spec-v2 §6.1–§6.5). FROZEN at Gate V0.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::ExchangeError};

/// Seeds `["config"]` (§6.1).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub round_controller: Pubkey,
    pub oracle_authority: Pubkey,
    pub collateral_mint: Pubkey,
    /// `Pubkey::default()` until the first round. The frontend features this round.
    pub latest_round: Pubkey,
    pub next_round_id: u64,
    pub resolution_timeout_s: i64,
    pub version: u8,
    pub bump: u8,
}

/// Seeds `["property", property_id: u16 LE]` (§6.2). Same layout as v1.1.
#[account]
#[derive(InitSpace)]
pub struct Property {
    pub property_id: u16,
    /// UTF-8, zero-padded.
    pub label: [u8; 32],
    pub lat_e6: i32,
    pub lon_e6: i32,
    pub scenario_id: u16,
    pub trigger_distance_m: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundStatus {
    Open,
    Closed,
}

/// Seeds `["round", round_id: u64 LE]` (§6.3).
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub scenario_id: u16,
    pub dataset_sha256: [u8; 32],
    pub label: [u8; 32],
    pub status: RoundStatus,
    pub created_at: i64,
    pub trading_ends_at: i64,
    pub closed_at: i64,
    pub market_count: u16,
    pub resolved_count: u16,
    pub bump: u8,
}

impl Round {
    /// Trading is allowed only while Open and before the deadline (§5.9).
    pub fn require_trading(&self, now: i64) -> Result<()> {
        require!(self.status == RoundStatus::Open, ExchangeError::RoundNotOpen);
        require!(now < self.trading_ends_at, ExchangeError::TradingEnded);
        Ok(())
    }

    pub fn require_closed(&self) -> Result<()> {
        require!(self.status == RoundStatus::Closed, ExchangeError::RoundNotClosed);
        Ok(())
    }

    /// `T = closed_at + resolution_timeout_s` (§4.5).
    pub fn resolution_deadline(&self, timeout_s: i64) -> Result<i64> {
        self.closed_at
            .checked_add(timeout_s)
            .ok_or_else(|| error!(ExchangeError::MathOverflow))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    Unresolved,
    Yes,
    No,
    Invalid,
}

impl Outcome {
    /// Event code: 1 Yes, 2 No, 3 Invalid.
    pub fn code(self) -> u8 {
        match self {
            Outcome::Unresolved => 0,
            Outcome::Yes => 1,
            Outcome::No => 2,
            Outcome::Invalid => 3,
        }
    }
}

/// Seeds `["market", round, property_id: u16 LE]` (§6.4).
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub round: Pubkey,
    pub property_id: u16,
    pub scenario_id: u16,
    pub lat_e6: i32,
    pub lon_e6: i32,
    pub trigger_distance_m: u32,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub outcome: Outcome,
    pub evidence_hash: [u8; 32],
    /// `split` adds, `merge` subtracts. Booked backing before resolution (§4.6).
    pub pairs_outstanding: u64,
    pub next_order_seq: u64,
    pub created_at: i64,
    pub resolved_at: i64,
    pub resolution_path: u8,
    pub invalid_reason: u8,
    pub bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
    pub vault_bump: u8,
}

impl Market {
    pub fn require_unresolved(&self) -> Result<()> {
        require!(self.outcome == Outcome::Unresolved, ExchangeError::MarketResolved);
        Ok(())
    }
}

/// Seeds `["order", market, maker, client_nonce: u64 LE]` (§6.5). Escrow: `["escrow", order]`.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub client_nonce: u64,
    /// `OUTCOME_YES` or `OUTCOME_NO`.
    pub outcome: u8,
    /// `SIDE_BUY` or `SIDE_SELL`.
    pub side: u8,
    pub price_bps: u16,
    pub original_qty: u64,
    pub remaining_qty: u64,
    /// Priority; lower is older. Not a seed.
    pub seq: u64,
    /// 0 = no expiry.
    pub expires_at: i64,
    pub created_at: i64,
    pub bump: u8,
    pub escrow_bump: u8,
}

/// Checked `a × b` through `u128`.
pub fn checked_mul(a: u64, b: u64) -> Result<u64> {
    let p = (a as u128)
        .checked_mul(b as u128)
        .ok_or_else(|| error!(ExchangeError::MathOverflow))?;
    u64::try_from(p).map_err(|_| error!(ExchangeError::MathOverflow))
}

/// `quote = quantity × price_bps × 100` (§3).
pub fn quote_amount(quantity: u64, price_bps: u16) -> Result<u64> {
    checked_mul(checked_mul(quantity, price_bps as u64)?, QUOTE_PER_SHARE_BPS)
}
