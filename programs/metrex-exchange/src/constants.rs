//! Constants (spec-v2 §3) and PDA seeds (§6). FROZEN at Gate V0.

use anchor_lang::prelude::*;

// --- Units (§3) ---
#[constant]
pub const MUSD_DECIMALS: u8 = 6;
#[constant]
pub const MUSD_UNIT: u64 = 1_000_000;
#[constant]
pub const SHARE_DECIMALS: u8 = 0;
/// Base units paid per winning share.
#[constant]
pub const PAYOUT_PER_SHARE: u64 = 1_000_000;
/// Base units paid per share of either outcome when the market is Invalid.
#[constant]
pub const INVALID_PAYOUT_PER_SHARE: u64 = 500_000;
/// `quote = quantity × price_bps × QUOTE_PER_SHARE_BPS`.
#[constant]
pub const QUOTE_PER_SHARE_BPS: u64 = 100;

// --- Bounds (§3) ---
#[constant]
pub const MIN_PRICE_BPS: u16 = 1;
#[constant]
pub const MAX_PRICE_BPS: u16 = 9_999;
#[constant]
pub const MIN_ORDER_QTY: u64 = 1;
#[constant]
pub const MAX_ORDER_QTY: u64 = 1_000_000;
#[constant]
pub const MAX_SPLIT_QTY: u64 = 1_000_000;
#[constant]
pub const DEFAULT_TRIGGER_DISTANCE_M: u32 = 500;
#[constant]
pub const MAX_ABS_LAT_E6: i32 = 90_000_000;
#[constant]
pub const MAX_ABS_LON_E6: i32 = 180_000_000;
#[constant]
pub const MIN_RESOLUTION_TIMEOUT_S: i64 = 10;
#[constant]
pub const MAX_RESOLUTION_TIMEOUT_S: i64 = 30 * 24 * 60 * 60;
#[constant]
pub const MAX_ROUND_DURATION_S: i64 = 30 * 24 * 60 * 60;

// --- Client limits, frozen with the interface (§3) ---
#[constant]
pub const MAX_TAKE_LEVELS: u8 = 4;
#[constant]
pub const MAX_MATCH_LEVELS: u8 = 3;

// --- Codes ---
#[constant]
pub const OUTCOME_YES: u8 = 0;
#[constant]
pub const OUTCOME_NO: u8 = 1;
#[constant]
pub const SIDE_BUY: u8 = 0;
#[constant]
pub const SIDE_SELL: u8 = 1;
#[constant]
pub const PATH_NONE: u8 = 0;
#[constant]
pub const PATH_ORACLE: u8 = 1;
#[constant]
pub const PATH_EMERGENCY: u8 = 2;
#[constant]
pub const PATH_EXPIRY: u8 = 3;

// --- Scenarios ---
#[constant]
pub const SCENARIO_PALISADES_2025: u16 = 1;

#[constant]
pub const PROGRAM_VERSION: u8 = 2;

// --- PDA seeds (§6). Integers in seeds are little-endian. ---
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const PROPERTY_SEED: &[u8] = b"property";
#[constant]
pub const ROUND_SEED: &[u8] = b"round";
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const YES_MINT_SEED: &[u8] = b"yes_mint";
#[constant]
pub const NO_MINT_SEED: &[u8] = b"no_mint";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const ORDER_SEED: &[u8] = b"order";
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";
