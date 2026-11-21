//! Constants (spec §4.5) and PDA seeds (spec §5). FROZEN after Gate 0.

use anchor_lang::prelude::*;

// --- mUSD units (§4.1) ---
#[constant]
pub const MUSD_DECIMALS: u8 = 6;
#[constant]
pub const MUSD_UNIT: u64 = 1_000_000;

// --- Offer and market bounds (§4.2, §4.5) ---
#[constant]
pub const MIN_COVERAGE: u64 = 10 * MUSD_UNIT;
#[constant]
pub const MAX_COVERAGE_TARGET: u64 = 1_000_000 * MUSD_UNIT;
#[constant]
pub const MIN_BPS: u16 = 1;
#[constant]
pub const MAX_BPS: u16 = 9_999;
#[constant]
pub const BPS_DENOMINATOR: u64 = 10_000;
#[constant]
pub const DEFAULT_TRIGGER_DISTANCE_M: u32 = 500;

// --- Coordinates, i32 microdegrees (§5.2) ---
#[constant]
pub const MAX_ABS_LAT_E6: i32 = 90_000_000;
#[constant]
pub const MAX_ABS_LON_E6: i32 = 180_000_000;

// --- Listing sides (§5.6) ---
#[constant]
pub const SIDE_PROTECTION: u8 = 0;
#[constant]
pub const SIDE_RISK: u8 = 1;

// --- Scenarios (§1.2, §8.1) ---
#[constant]
pub const SCENARIO_PALISADES_2025: u16 = 1;

// --- PDA seeds (§5). Integers in seeds are little-endian. ---
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const PROPERTY_SEED: &[u8] = b"property";
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const OFFER_SEED: &[u8] = b"offer";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const LISTING_SEED: &[u8] = b"listing";
