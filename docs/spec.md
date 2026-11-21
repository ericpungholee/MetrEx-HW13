# MetrEx — Hackathon Specification v1.1

**Hackathon:** Hack Western 2026 · **Track:** MLH Best Use of Solana
**Network:** Solana Devnet · **Stage:** MVP prototype
**Supersedes:** v1.0. This document is self-contained; build from this one.
**Amendments v1.1.1 (2026-11-20, approved before the Gate 0 freeze):** single holder fields on `Offer` (§5.4); `initialize_config` bound to the upgrade authority (§6); `InsufficientFunds` and `InvalidSide` errors (§6.4); Tier 2 events (§6.5); faucet and evidence as route handlers and build-plan layout (§9.3, §15).

> **MetrEx is Kalshi for insurance.** Individuals list risks they want covered, traders compete to underwrite them, and a Solana program holds the collateral and settles payouts.

> **Who it's for:** homeowners whom traditional insurers have dropped or refused. MetrEx gives them fast, fully collateralized gap coverage priced by an open market.

**Guiding principle:** Build the exchange first. Everything else exists to show that the exchange works.

---

## 0. What changed from v1.0

| # | Problem in v1.0 | v1.1 decision | Section |
|---|---|---|---|
| 1 | Oracle authority, close controller and mint could be supplied by the market creator, so a homeowner could name themselves oracle and take every vault | A global `Config` account, set once by an admin, holds `oracle_authority`, `demo_controller`, `admin`, and `mint`. Instructions check against Config only | 5.1, 6 |
| 2 | Homeowner could choose any coordinates, including ones known to have burned | Properties are registered by the admin in `Property` accounts. A market references a property ID; coordinates are copied from the registry | 5.2, 6 |
| 3 | Offer addresses keyed by a shared counter on the market would collide when bots offer at the same time | Offer address = `["offer", market, underwriter, nonce]`, nonce chosen by the client. No shared counter | 5.4 |
| 4 | Coverage cap ambiguous (checked at offer or at acceptance?) | `place_offer` checks `coverage ≤ target`. `accept_offer` checks `activated + coverage ≤ target`. Total offers may exceed the target | 6 |
| 5 | Rounding rule undefined; premium passed by caller | Program computes `premium = floor(coverage × bps / 10_000)` in u128. Caller passes only coverage and bps. Escrow = coverage by construction | 4.2 |
| 6 | Coordinate type undefined | `i32` microdegrees (`lat_e6`, `lon_e6`) | 5.2 |
| 7 | Evidence hash described but not stored | `Market.evidence_hash: [u8; 32]`, written by `resolve_market`; evidence JSON has a canonical form so anyone can recompute it | 5.3, 8.4 |
| 8 | Unaccepted offers could get stuck after close/resolve | `cancel_offer` works in every market state for an offer in `Open` status | 6 |
| 9 | No way out if the oracle never resolves | `void_market` (admin) + `refund_offer` (anyone can crank), returning premium and collateral to their sources | 6 |
| 10 | Fire perimeter holes (unburned islands) not considered | Trigger evaluation respects holes and measures distance to every ring. Explicit hole test required | 8.2 |
| 11 | NO-outcome property assumed to be in the Palisades | NO property may lie outside the Palisades; chosen with a ≥ 2 km margin from the perimeter | 8.3 |
| 12 | Six wallet pop-ups during a 2-minute demo | "Accept selected" and "Claim all" batch several instructions into one transaction | 10.3 |
| 13 | Judge wallets have no SOL or mUSD | Backend faucet endpoint sends devnet SOL and mints mUSD | 9.3 |
| 14 | Missing tests: loser claims, offers on closed markets, cancel after close, bad bps | Added to the test list | 12.1 |
| 15 | Self-dealing (homeowner underwriting own market) unaddressed | `place_offer` rejects `underwriter == homeowner` | 6 |
| 16 | "Funded" state undefined | Display-only label when `activated == target`; on-chain status stays `Open` | 10.2 |
| 17 | Disaster sensitivity | Fictional home labels, approximate coordinates, explicit "historical replay" framing | 8.5 |
| 18 | Target user not defined | Homeowners dropped or refused by traditional insurers; MetrEx is gap coverage alongside (not instead of) the FAIR Plan or other insurance | 1.1 |
| 19 | Number of geographies unclear | Exactly one scenario (Palisades Fire, January 2025). The oracle picks its dataset by `scenario_id`, so adding a fire is data, not a redeploy | 1.2, 8.1 |
| 20 | Basis risk (home in the fire zone that didn't burn, or burned just outside it) unaddressed | Trigger is explicitly parametric: pays on fire proximity, not damage. Stated in market terms, UI, and pitch | 8.6 |
| 21 | Underwriter concentration risk invisible | Portfolio shows exposure per scenario | 3.1 |
| 22 | No pitch narrative | Problem → mechanism → demo → honest limits | 11.1 |
| 23 | Claim rights hard-wired to roles, blocking any future trading | Offers carry `protection_holder` and `risk_holder`; claims check holders | 5.4, 6 |
| 24 | Exchange had almost no on-chain activity for a "Best Use of Solana" DEX track | **Tier 2 (Solana track):** secondary trading of positions via on-chain listings with atomic swaps | 5.6, 6, 10.4 |
| 25 | Static bot offers | Tier 2: bots requote continuously (cancel/replace when undercut), within floors and rate limits | 7.1 |
| 26 | Solana's speed and cost advantages asserted, not shown | Tier 2: live network panel (transaction count, total fees paid, measured confirmation time) | 10.5 |

---

## 1. Product summary

A homeowner creates a market asking for wildfire protection on a property. Underwriters (three bots plus any connected wallet) post offers stating how much coverage they will provide and at what premium rate, locking collateral as they do. The homeowner accepts offers until the requested coverage is filled, paying each underwriter's premium into that offer's escrow. Each escrow now holds exactly the promised coverage.

The demo then replays the January 2025 Palisades Fire. An oracle checks whether the fire's final mapped footprint came within 500 m of the property and posts the result on-chain. The winning side of each position claims the escrow.

### 1.1 Who it's for

**Primary user:** a homeowner in a high-wildfire-risk area who has been non-renewed or refused by private insurers. They are on California's FAIR Plan (the insurer of last resort, with higher premiums, narrower coverage, and a $3M residential cap) or have no coverage at all.

**Why Pacific Palisades is the case study:**
- State Farm announced non-renewals for 1,626 residential policies in the 90272 ZIP code, starting July 2024, about six months before the fire.
- Roughly 1,400 of the town's ~9,000 homes were on the FAIR Plan in 2024, more than four times the 2020 figure.

**What MetrEx offers them:** a parametric gap-coverage contract. If the fire reaches them, they receive a fixed cash payout as soon as the outcome is posted, with no adjuster and no claims dispute. The payout is guaranteed because it is already sitting in escrow.

**What MetrEx is not:** a replacement for home insurance. It does not measure damage, rebuild costs, or contents loss. See 8.6.

**Why underwriters would take risk that insurers walked away from:**
1. **Free pricing.** Regulated insurers often drop risk rather than charge for it. On MetrEx, the premium is whatever the market clears at.
2. **No solvency risk.** Every position is fully collateralized up front. An underwriter can't sell coverage it can't pay.
3. **Distributed capital.** Any wallet can take a slice of one home's risk, so no single balance sheet carries a whole town.

**Pricing honesty:** risk that insurers refuse will not be cheap. MetrEx's claim is that coverage is *available* and transparently priced, not that it is cheaper. Demo bot rates (4–5%) are illustrative only.

Sources: California Department of Insurance figures as reported by CBS MoneyWatch (https://www.cbsnews.com/texas/news/fires-california-palisades-fire-homeowners-insurance-state-farm-fair-losses) and the Los Angeles Times (https://www.yahoo.com/news/state-farm-offer-renewals-policyholders-232216166.html); FAIR Plan cap per HousingWire (https://www.housingwire.com/articles/california-home-insurance-premiums-los-angeles-wildfires-state-farm/).

### 1.2 Locked scope

| Dimension | Decision |
|---|---|
| Risk | Residential wildfire, trigger = final fire footprint within 500 m of the property |
| Scenario | **Exactly one:** January 2025 Palisades Fire, final perimeter, packaged locally. Properties may lie outside the town (e.g. the NO property) but all belong to this scenario |
| Positioning | Gap coverage for homeowners dropped by traditional insurers |
| Chain | Solana Devnet, Rust + Anchor, classic SPL Token program |
| Currency | `mUSD`, 6 decimals, visibly labelled valueless test currency |
| Mechanism | Primary underwriting auction; each offer filled whole or not at all |
| Liquidity | 3 deterministic bot wallets |
| Oracle | Trusted backend signer + on-chain evidence hash |
| Collateral | Fully collateralized; no leverage |

### 1.3 Out of scope

Real money or policies, mainnet, other risk types, additional fire scenarios (Eaton Fire is the first candidate, P5 only), damage-based triggers, a continuous order-matching engine (secondary trading uses fixed-price listings, 5.6), fungible position tokens, AMMs or pools, partial fills, leverage/margin, complex orders, general prediction markets, actuarial or ML pricing, LLM trading, decentralized oracles, live fire monitoring, KYC, mobile apps, governance tokens, production infrastructure, arbitrary address geocoding.

**Scope rule:** if it doesn't directly help demonstrate market creation, competitive underwriting, escrow, or settlement, it's off the critical path.

---

## 2. Roles

| Role | Wallet | Can |
|---|---|---|
| Admin | Team keypair, kept local | Initialize Config, register properties, void a market |
| Homeowner | Any wallet | Create a market on a registered property, accept offers, claim on YES |
| Underwriter | Any wallet except the market's homeowner | Place and cancel offers, claim on NO |
| Demo controller | Backend keypair | Close an open market |
| Oracle | Backend keypair, distinct from the controller | Resolve a closed market once, with an evidence hash |

No role can move escrowed funds except through the rules in section 6. In particular the admin, controller, and oracle can never withdraw from a vault.

---

## 3. Core experience

### 3.1 Pages

1. **Exchange (`/`)**: market cards showing property label, area, risk, coverage requested, coverage funded, best open premium, offer count, status.
2. **Create (`/create`)**: choose a registered property from a list (with a small map), enter coverage. That's the whole form.
3. **Market (`/market/[id]`)**: header, risk info, order book (open offers, sorted by ascending bps), positions (accepted offers), offer form, homeowner actions, activity feed, Explorer links.
4. **Portfolio (`/portfolio`)**: mUSD balance, open offers, locked collateral, active positions, total exposure, **exposure per scenario** (one fire hits every home in its footprint at once, so many positions in one scenario are effectively one bet), premiums, claimable amounts, realized P&L.
5. **Settlement (`/demo`)**: operator view. Close market, show the fire perimeter against the property's 500 m circle, run oracle, show the evidence record.

### 3.2 Design direction

Modern financial exchange, dark theme, dense tables, clear status pills, prominent transaction confirmations with Explorer links. Not an insurance quote form.

### 3.3 Example card

> **Palisades · Home #1042** — Wildfire within 500 m
> Requested $10,000 · Funded $6,000 · Best premium 4.2% · 3 offers · **Accepting offers**

Every market page carries the trigger in plain words: *"Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage."*

---

## 4. Financial mechanics

### 4.1 Units

- `mUSD` has 6 decimals. 1 mUSD = 1_000_000 base units. $10,000 = 10_000_000_000.
- All amounts are `u64` base units. Intermediate products use `u128`.
- Rates are `u16` basis points. 400 bps = 4.00%.
- No floating point anywhere in the program.

### 4.2 Offer math (computed on-chain)

The underwriter supplies `coverage` (C) and `premium_bps` (b). The program computes:

```
premium    P = floor(C × b / 10_000)        // u128 intermediate, checked
collateral K = C − P                        // checked_sub
```

Validity:
- `1 ≤ b ≤ 9_999`
- `MIN_COVERAGE ≤ C ≤ market.coverage_target`
- `P ≥ 1` (rejects offers whose premium rounds to zero)

Because `K + P = C` by definition, every accepted vault backs exactly C in booked coverage. The program never rejects an offer for rounding; floor rounding is the rule and it slightly favours the homeowner.

### 4.3 Worked example

Homeowner requests 10,000 mUSD.

| Underwriter | Coverage | bps | Premium | Collateral |
|---|---:|---:|---:|---:|
| Bot A | 4,000 | 400 | 160 | 3,840 |
| Bot B | 3,000 | 450 | 135 | 2,865 |
| Bot C | 3,000 | 500 | 150 | 2,850 |
| **Total** | **10,000** | | **445** | **9,555** |

- **YES:** homeowner claims 10,000 across three positions (net +9,555). Underwriters lose their collateral.
- **NO:** each underwriter claims its coverage (collateral + premium). Homeowner is out 445.

### 4.4 Conservation invariant

The booked vault obligation is collateral (K) for an Open offer, coverage (C) for an Accepted offer, and zero after cancellation, claim or refund. A live vault's raw SPL balance must cover that obligation. Any excess is unsolicited surplus. Surplus never changes booked amounts, holder rights or market coverage. Acceptance transfers exactly P and can proceed when the resulting vault balance is at least C.

- **Cancellation.** Return K and any surplus to the original underwriter.
- **Payout.** Transfer exactly C to the winning holder. Send any surplus to the original underwriter, or to the original homeowner when the original underwriter is the claimant. The surplus recipient is always a different wallet from the claimant.
- **Void refund.** Return P to the original homeowner and K plus any surplus to the original underwriter.

For a surplus-bearing payout, the caller supplies the recipient's writable classic SPL token account as the first remaining account. The program validates its token program, mint and wallet owner. The caller can create it without the recipient's signature. The frozen IDL, instruction arguments and named account contexts remain unchanged. Claims with zero surplus may omit this account. Clients should supply it on every claim so deposits after a balance read cannot invalidate a correctly prepared claim.

Each terminal instruction drains and closes the vault atomically, with rent returning to the original underwriter. Lifecycle events report booked contractual amounts. MetrEx neither mints nor burns mUSD.

### 4.5 Constants

| Constant | Value |
|---|---|
| `MIN_COVERAGE` | 10 mUSD |
| `MAX_COVERAGE_TARGET` | 1,000,000 mUSD |
| `MAX_BPS` | 9,999 |
| `TRIGGER_DISTANCE_M` | 500 (stored per property) |

---

## 5. On-chain accounts

All PDAs. Seeds shown with byte encodings; `u64`/`u16` are little-endian.

### 5.1 `Config` — seeds `["config"]`

| Field | Type | Notes |
|---|---|---|
| `admin` | Pubkey | Signer of `initialize_config` |
| `oracle_authority` | Pubkey | Only key allowed to resolve |
| `demo_controller` | Pubkey | Only key allowed to close |
| `mint` | Pubkey | The mUSD mint; every token account is checked against it |
| `bump` | u8 | |

Created once. No update instruction in the MVP; to rotate a key, redeploy and reinitialize.

### 5.2 `Property` — seeds `["property", property_id: u16]`

| Field | Type | Notes |
|---|---|---|
| `property_id` | u16 | |
| `label` | [u8; 32] | e.g. "Palisades · Home #1042", UTF-8, zero-padded |
| `lat_e6` | i32 | Latitude × 10⁶, rounded |
| `lon_e6` | i32 | Longitude × 10⁶, rounded |
| `scenario_id` | u16 | 1 = Palisades Fire, January 2025 |
| `trigger_distance_m` | u32 | 500 |
| `bump` | u8 | |

### 5.3 `Market` — seeds `["market", homeowner, market_nonce: u64]`

| Field | Type | Notes |
|---|---|---|
| `homeowner` | Pubkey | |
| `market_nonce` | u64 | Client-chosen (e.g. timestamp ms) |
| `property_id` | u16 | |
| `lat_e6`, `lon_e6` | i32 | Copied from Property at creation |
| `scenario_id` | u16 | Copied |
| `trigger_distance_m` | u32 | Copied |
| `coverage_target` | u64 | |
| `coverage_activated` | u64 | Sum of accepted offers' coverage |
| `accepted_count` | u16 | |
| `status` | enum | `Open`, `Closed`, `ResolvedYes`, `ResolvedNo`, `Voided` |
| `evidence_hash` | [u8; 32] | Zero until resolved |
| `created_at`, `closed_at`, `resolved_at` | i64 | Unix seconds, from `Clock` |
| `bump` | u8 | |

Copying the property data into the market means the oracle evaluates exactly what was on-chain when the market opened.

### 5.4 `Offer` — seeds `["offer", market, underwriter, offer_nonce: u64]`

| Field | Type | Notes |
|---|---|---|
| `market` | Pubkey | |
| `underwriter` | Pubkey | |
| `offer_nonce` | u64 | Client-chosen; random u64 or timestamp |
| `coverage` | u64 | C |
| `premium_bps` | u16 | b |
| `premium` | u64 | P, computed |
| `collateral` | u64 | K, computed |
| `protection_holder` | Pubkey | Default until accepted; then the homeowner. Receives the vault on YES |
| `risk_holder` | Pubkey | Default until accepted; then the underwriter. Receives the vault on NO |
| `status` | enum | `Open`, `Accepted`, `Cancelled`, `Claimed`, `Refunded` |
| `created_at`, `accepted_at` | i64 | |
| `bump`, `vault_bump` | u8 | |

Offer accounts are kept after settlement so the UI has history. Their vaults are closed.

### 5.5 Vault — seeds `["vault", offer]`

An SPL token account for `config.mint`, with the Offer PDA as its token authority. The underwriter pays its rent and gets that rent back when the vault is closed.

### 5.6 `Listing` (Tier 2) — seeds `["listing", offer, side: u8]`

One active listing per side of an accepted position. `side`: 0 = Protection, 1 = Risk.

| Field | Type | Notes |
|---|---|---|
| `offer` | Pubkey | The position being sold |
| `side` | u8 | 0 Protection, 1 Risk |
| `seller` | Pubkey | Must equal the current holder of that side when listed and when bought |
| `price` | u64 | mUSD base units the buyer pays the seller |
| `created_at` | i64 | |
| `bump` | u8 | |

A listing sells the *right to claim* one side of a position; the escrowed coverage never leaves the vault. The listing account is closed on purchase or cancel (rent back to seller).

---

## 6. Instructions

Every instruction that touches tokens checks: `token_account.mint == config.mint`, the account owner matches the intended party, and uses checked arithmetic. Every status transition is listed below; anything else fails.

| Instruction | Signer | Preconditions | Effects |
|---|---|---|---|
| `initialize_config(oracle, controller)` | admin | Config doesn't exist; mint account provided; **signer == the program's upgrade authority** (read from its `ProgramData` account) | Create Config |
| `register_property(id, label, lat_e6, lon_e6, scenario_id, trigger_m)` | `config.admin` | Property ID unused; lat in ±90°, lon in ±180° | Create Property |
| `create_market(nonce, property_id, coverage_target)` | homeowner | Property exists; `MIN_COVERAGE ≤ target ≤ MAX_COVERAGE_TARGET` | Create Market (`Open`), copy property data |
| `place_offer(nonce, coverage, bps)` | underwriter | Market `Open`; `underwriter ≠ homeowner`; bps and coverage valid (4.2); P ≥ 1; balance ≥ K | Create Offer (`Open`) + vault; transfer K underwriter → vault |
| `cancel_offer()` | `offer.underwriter` | Offer `Open` (any market status) | Transfer vault → underwriter; close vault; Offer → `Cancelled` |
| `accept_offer()` | `market.homeowner` | Market `Open`; Offer `Open`; `offer.market == market`; `activated + C ≤ target` | Transfer P homeowner → vault; assert `vault.amount ≥ C`; Offer → `Accepted`; set `protection_holder = homeowner`, `risk_holder = underwriter`; `activated += C`; `accepted_count += 1` |
| `close_market()` | `config.demo_controller` | Market `Open` | Market → `Closed`; set `closed_at` |
| `resolve_market(triggered: bool, evidence_hash)` | `config.oracle_authority` | Market `Closed` | Market → `ResolvedYes` / `ResolvedNo`; store hash; set `resolved_at` |
| `claim_payout()` | winner | Market resolved; Offer `Accepted`; YES ⇒ signer == `protection_holder`, NO ⇒ signer == `risk_holder`; destination owned by signer | Transfer C → signer and route any surplus (§4.4); close vault (rent → underwriter); Offer → `Claimed` |
| `list_position(side, price)` *(Tier 2)* | current holder of `side` | Market `Open` or `Closed`; Offer `Accepted`; `price ≥ 1`; no listing for this side exists | Create Listing |
| `buy_position()` *(Tier 2)* | buyer | Market `Open` or `Closed`; Offer `Accepted`; `listing.seller ==` current holder of that side; buyer ≠ seller; buyer ≠ holder of the opposite side | Transfer `price` buyer → seller; set that side's holder = buyer; close Listing. All in one instruction |
| `cancel_listing()` *(Tier 2)* | `listing.seller` | Listing exists | Close Listing |
| `void_market()` | `config.admin` | Market `Open` or `Closed` | Market → `Voided` |
| `refund_offer()` | anyone | Market `Voided`; Offer `Accepted` | Transfer P → homeowner and K plus surplus → underwriter; close vault; Offer → `Refunded` |

`void_market` / `refund_offer` are a safety valve, built after the core lifecycle passes its tests (P0.5). Open offers on a voided market use `cancel_offer` as usual.

### 6.1 Market state machine

```
            close_market            resolve_market
  OPEN ──────────────────▶ CLOSED ──────────────────▶ RESOLVED_YES | RESOLVED_NO   (final)
    │                         │
    └──── void_market ────────┴──────▶ VOIDED   (final)
```

| | Open | Closed | Resolved | Voided |
|---|:-:|:-:|:-:|:-:|
| place_offer | ✓ | | | |
| accept_offer | ✓ | | | |
| cancel_offer (Open offers) | ✓ | ✓ | ✓ | ✓ |
| resolve_market | | ✓ | | |
| claim_payout | | | ✓ | |
| refund_offer | | | | ✓ |
| list_position / buy_position (Tier 2) | ✓ | ✓ | | |
| cancel_listing (Tier 2) | ✓ | ✓ | ✓ | ✓ |

Trading positions is allowed while `Closed` because that is the coverage period: no new coverage is written, but existing claims can change hands until the oracle reports. Once resolved, trading stops.

`refund_offer` on a voided market pays P to the original homeowner and K plus any surplus to the original underwriter regardless of current holders. Document this; a holder who bought a side can lose their purchase price on a void. (Void is an emergency path only.)

### 6.2 Offer state machine

```
 Open ──accept──▶ Accepted ──claim──▶ Claimed
  │                  └──────refund──▶ Refunded
  └──cancel──▶ Cancelled
```

### 6.3 Security invariants (each maps to a test in 12.1)

1. Only `config.oracle_authority` resolves; only `config.demo_controller` closes; only `config.admin` registers and voids.
2. No instruction takes an oracle, controller, or mint as a caller-supplied value.
3. Market coordinates come only from a registered Property.
4. Only the homeowner accepts; only the offer's underwriter cancels.
5. Underwriter cannot be the market's homeowner.
6. Accepted offers cannot be cancelled.
7. `coverage_activated ≤ coverage_target` always.
8. `premium + collateral == coverage` for every offer.
9. A market resolves at most once; final states are immutable.
10. Each offer pays out at most once (`Claimed`/`Refunded`/`Cancelled` are terminal).
11. Only the winning side can claim.
12. Every token account's mint equals `config.mint`.
13. All arithmetic is checked; all transfers use the Token program CPI with PDA signer seeds.
14. Claims go only to the current holder of the winning side.
15. (Tier 2) Only the current holder of a side can list it; a listing whose seller no longer holds that side cannot be bought.
16. (Tier 2) A purchase moves the price and the holder change atomically; one cannot happen without the other.
17. (Tier 2) Secondary trading never moves vault funds.

### 6.4 Error codes

`Unauthorized`, `InvalidMarketStatus`, `InvalidOfferStatus`, `InvalidBps`, `CoverageTooSmall`, `CoverageExceedsTarget`, `CoverageExceedsRemaining`, `PremiumRoundsToZero`, `SelfUnderwriting`, `WrongMint`, `WrongTokenOwner`, `OfferMarketMismatch`, `NotWinner`, `InvalidCoordinates`, `MathOverflow`, `VaultBalanceMismatch`, and for Tier 2: `NotHolder`, `StaleListing`, `SelfTrade`, `InvalidPrice`. Added in v1.1.1 (appended, so earlier codes keep their numbers): `InsufficientFunds` (`place_offer` balance < K, `accept_offer` balance < P, `buy_position` balance < price), `InvalidSide` (`list_position` side not 0 or 1).

### 6.5 Events

Emit an Anchor event per instruction (`MarketCreated`, `OfferPlaced`, `OfferCancelled`, `OfferAccepted`, `MarketClosed`, `MarketResolved`, `PayoutClaimed`, `MarketVoided`, `OfferRefunded`, and for Tier 2: `PositionListed`, `PositionBought`, `ListingCancelled`). The activity feed reads these from transaction logs; account state remains the source of truth.

---

## 7. Automated underwriters

Three deterministic bots, each with its own keypair and mUSD balance, in one TypeScript service.

| Bot | bps | Size | Per-market cap | Total exposure cap |
|---|---:|---|---:|---:|
| A — Aggressive | 400 | 40% of target | 50,000 mUSD | 200,000 mUSD |
| B — Balanced | 450 | 30% of target | 30,000 mUSD | 150,000 mUSD |
| C — Conservative | 500 | 30% of target | 20,000 mUSD | 100,000 mUSD |

Rules:
- Poll `getProgramAccounts` (Market discriminator, status `Open`) every 3 s.
- For each market a bot hasn't offered on, offer `min(size, per-market cap, remaining exposure cap)`, rounded down to whole mUSD and ≥ `MIN_COVERAGE`.
- Skip if wallet balance < required collateral or SOL < 0.01. Log the skip.
- Idempotent: before submitting, check for an existing Offer from this bot on the market. Use a random u64 nonce.
- Cleanup: after a market leaves `Open`, cancel the bot's unaccepted offers to recover collateral.
- Pricing ignores property location. This is intentional; bots exist to show real collateralized offers from independent wallets, not to price risk.

No LLMs, no learned models, no RL.

### 7.1 Continuous requoting (Tier 2)

Bots compete visibly instead of posting once:

| Bot | Floor bps | Step |
|---|---:|---:|
| A | 350 | 10 |
| B | 400 | 10 |
| C | 450 | 10 |

- When another wallet's open offer on an `Open`, not-yet-funded market undercuts a bot's best open offer, the bot cancels and re-places at `undercut − step`, never below its floor.
- At most one requote per bot per market every 5 s, and at most 20 per market. Each requote is a real `cancel_offer` + `place_offer` (one transaction, two instructions).
- Bots also list the Risk side of their accepted positions at `collateral + 50% of premium` (configurable), so a buyer gets a fully funded NO claim and the bot locks in part of its premium. Bots don't buy positions; bids are out of scope.
- Every requote shows in the activity feed and counts toward the network panel (10.5).

---

## 8. Historical oracle

### 8.1 Dataset

1. Download the final Palisades Fire perimeter from an authoritative source (CAL FIRE / NIFC perimeter data).
2. Record the source URL, retrieval date, and SHA-256 of the raw file in `data/DATASET.md`.
3. Normalize to GeoJSON, WGS84, a single `MultiPolygon` feature, keeping inner rings (holes). Save as `data/palisades-2025.geojson` and record its SHA-256 as `dataset_sha256`.
4. Never fetch live data during the demo.
5. Keep a scenario registry in `data/scenarios.json` mapping `scenario_id` → dataset file, name, and SHA-256. The oracle loads the dataset by the Market's `scenario_id` and refuses unknown IDs. The MVP registry has one entry (`1` → Palisades). Adding a fire = add a file and a registry entry, then register properties; no program change.

### 8.2 Trigger evaluation

Input: `lat_e6`, `lon_e6`, `trigger_distance_m` from the **on-chain Market**, plus the packaged perimeter.

```
point    = (lon_e6 / 1e6, lat_e6 / 1e6)
inside   = point lies in any polygon's outer ring AND in none of that polygon's holes
distance = minimum geodesic distance (m) from point to ANY ring (outer or inner) of any polygon
triggered = inside OR distance ≤ trigger_distance_m
```

Implementation: Turf.js — `booleanPointInPolygon` (respects holes) and `pointToLineDistance` over every ring via `polygonToLine`, `units: 'meters'`. Report `distance_m` as an integer (floor).

A point inside a hole is **not** inside the footprint; it triggers only if it is within 500 m of the hole's edge or of any other ring.

Required unit tests (synthetic geometry, plus the real file):
- point deep inside → true
- point 400 m outside → true; 600 m outside → false
- point inside a hole, > 500 m from every ring → false
- point inside a hole, < 500 m from the hole edge → true
- all registered demo properties match their expected outcomes

### 8.3 Demo properties

Pick coordinates from the actual data, not assumptions. Use wide margins so nothing depends on edge precision.

| ID | Label | Expected | Selection rule |
|---|---|---|---|
| 1 | Palisades · Home #1042 | YES | ≥ 300 m inside the perimeter, not in a hole |
| 2 | Westside · Home #2210 | NO | ≥ 2 km from every ring; may lie outside Pacific Palisades |
| 3 | Palisades · Home #1187 | YES | Second open market for judges to underwrite |

Record the computed `distance_m` for each in `data/DATASET.md`.

### 8.4 Evidence record

Canonical JSON: UTF-8, keys sorted lexicographically at every level, no insignificant whitespace, integers only.

```json
{"computed":{"distance_m":0,"inside":true},"dataset":{"name":"palisades-2025","retrieved":"2026-11-21","sha256":"<hex>","source":"<url>"},"market":"<base58>","program_id":"<base58>","property":{"id":1,"lat_e6":34045000,"lon_e6":-118526000},"scenario_id":1,"trigger_distance_m":500,"triggered":true,"version":1}
```

`evidence_hash = SHA-256(canonical bytes)`. The oracle saves the file to `data/evidence/<market>.json` and serves it at `GET /api/evidence/:market`. The settlement view recomputes the hash in the browser and shows it matches the on-chain value.

(Coordinates above are placeholders.)

### 8.5 Framing and sensitivity

- Every market is tagged "Historical replay — outcome already known".
- Labels are fictional; coordinates are approximate points, not real street addresses.
- In the pitch, acknowledge the real fire and its impact in one sentence before the demo, and say the replay demonstrates settlement mechanics, not prospective pricing.
- Prepared answer to "why underwrite a known outcome?": *Replay lets us show the full lifecycle in two minutes; with live markets the same program settles future risk.*

### 8.6 Trigger semantics and basis risk

The trigger is **parametric**: it pays on whether the fire came within 500 m of the property's registered point, not on whether the home was damaged. The gap between the payout and the actual loss is *basis risk*, and it runs both ways:

| Case | Outcome | Why we accept it |
|---|---|---|
| Home inside the footprint, survived | Pays in full | Objective, instant, no adjuster. Underwriters price the trigger, not the damage |
| Home burned by embers > 500 m beyond the mapped edge | Pays nothing | Same reason; the trigger is disclosed up front |
| Home inside an unburned island in the perimeter | Pays only if within 500 m of a ring (8.2) | Follows the geometry exactly |
| Large lot partly within 500 m, registered point outside | Pays nothing | The registered point is the trigger, stated in market terms |
| Perimeter later revised by the agency | No effect | The dataset is frozen and fingerprinted (8.1) |
| Property exactly 500 m away | Pays (rule is ≤ 500) | Demo properties keep wide margins so this never arises on stage |

Why parametric is right for this user: someone with no coverage, or with capped FAIR Plan coverage, gains more from a guaranteed fast payout than from an indemnity claim they can't get. Real parametric products (earthquake, hurricane, crop) make the same trade.

Damage data: CAL FIRE publishes per-structure damage inspection (DINS) records for the Palisades Fire, graded from No Damage to Destroyed and covering structures inside or within 100 m of the perimeter. It is **not** used as a trigger in the MVP. Reasons: it misses structures far outside the perimeter, it reflects external walk-arounds only, it arrives weeks after the fire, and every record is a real, identifiable home. It may be used **in aggregate only** (for example, the share of inspected structures inside the perimeter with no damage) on a pitch slide about basis risk. Never use a real inspected home as a demo property.

---

## 9. Backend

One Node.js/TypeScript service with four modules. No database; in-memory cache over on-chain reads.

### 9.1 Keys

| Key | Holder | Purpose |
|---|---|---|
| admin | Local machine only | Config, properties, void |
| mint authority | Backend | Faucet minting |
| demo_controller | Backend | Close |
| oracle_authority | Backend | Resolve (separate from controller) |
| bot A/B/C | Backend | Offers |
| faucet SOL wallet | Backend | Funds judge wallets |

Keys load from env/keyfiles, never from the repo.

### 9.2 Modules

- **bots/**: section 7.
- **oracle/**: `POST /api/oracle/resolve/:market` → read Market, check `Closed`, load the dataset for `market.scenario_id` from the scenario registry (8.1), evaluate, write evidence, sign `resolve_market`. Refuses if already resolved or if the scenario is unknown.
- **controller/**: `POST /api/demo/close/:market`. The settlement page triggers it; protect it with a shared demo password header.
- **faucet/**: section 9.3.

### 9.3 Faucet

`POST /api/faucet { wallet }` (a Next.js route handler at `app/app/api/faucet/`, server-only keys) → sends 0.05 devnet SOL (from the pre-funded faucet wallet) and mints 25,000 mUSD. One request per wallet per 10 minutes; hard cap of 100 wallets. The frontend shows a "Get demo funds" button when the connected wallet is low.

### 9.4 Scripts

- `setup-devnet.ts`: create mint, initialize Config, register properties 1–3.
- `fund-bots.ts`: SOL + mUSD to bots and the faucet wallet.
- `seed-demo.ts`: create a fallback market with bot offers already accepted.
- `find-properties.ts`: evaluate candidate coordinates against the perimeter and print distances.

---

## 10. Frontend

Next.js, TypeScript, Tailwind, Solana wallet adapter, Anchor TS client from the program IDL.

### 10.1 Rules

- Every displayed trade corresponds to on-chain state; nothing is simulated locally.
- Poll market and offer accounts every 3 s.
- Every transaction shows pending → confirmed → Explorer link (`?cluster=devnet`), or a readable error mapped from the error codes.

### 10.2 Derived display states

| Display | Condition |
|---|---|
| Accepting offers | `Open` and `activated < target` |
| Funded | `Open` and `activated == target` |
| Closed — awaiting oracle | `Closed` |
| Resolved: triggered / not triggered | `ResolvedYes` / `ResolvedNo` |
| Voided | `Voided` |

### 10.3 Batched transactions

- **Accept selected:** the homeowner ticks offers (UI prevents exceeding the target); one transaction with one `accept_offer` instruction per offer.
- **Claim all:** one transaction with every claimable `claim_payout` for the connected wallet.
- If a batch exceeds the transaction size limit, split it automatically into the fewest transactions. Verify early that three instructions fit in one.

### 10.4 Position trading (Tier 2)

On the market page, a "Positions" table shows every accepted position with its current Protection and Risk holders and any active listing. A holder can list either side at a price; any other wallet can buy with one click (one signature, atomic). The portfolio shows bought positions with entry price. The app funds a temporary token account with the displayed listing price and closes it in the same purchase transaction. A price change before execution makes the transaction roll back.

### 10.5 Network panel (Tier 2)

A compact strip on the exchange homepage and the settlement page, computed by the backend from this program's transactions:
- program transactions (total, last 10 min)
- total network fees paid, in SOL, from transaction metadata
- median client-measured send→confirm latency for the connected wallet's own transactions

This makes the "why Solana" case with real numbers from the demo itself rather than claims.

### 10.6 Wallet compatibility

Use the Wallet Standard via the Solana wallet adapter so any compliant wallet works, including hardware-backed signers. Large underwriting deposits are the natural place to show self-custody; mention it in the pitch only if you test it with a real device.

---

## 11. Pitch and demo

### 11.1 Pitch narrative (≈ 1 minute before the demo)

1. **Problem (15 s).** In mid-2024, State Farm began non-renewing about 1,600 homes in Pacific Palisades. By 2024, about 1,400 of the town's 9,000 homes relied on the FAIR Plan, California's insurer of last resort. In January 2025 the fire came. (One sentence acknowledging the human cost; no dramatization.)
2. **Insight (15 s).** Insurers didn't leave because the risk can't be priced. They left because they couldn't price it freely or carry it on one balance sheet. An open market can do both.
3. **Mechanism (20 s).** A homeowner lists their risk. Traders compete to underwrite it, each locking full collateral on Solana. An oracle reports whether the fire reached the property, and the program pays out from escrow.
4. **Demo (2 min).** Section 11.2.
5. **Honest limits (10 s).** Parametric: it pays on the fire reaching you, not on damage, and it complements insurance rather than replacing it. The demo is a replay of a known event. One scenario today; adding another is a data file, not a redeploy.

### 11.2 Demo script (≈ 2 minutes)

Preconditions: program deployed, Config and properties registered, bots funded, homeowner wallet funded, fallback market seeded.

1. **Create:** homeowner connects, picks Home #1042, requests 10,000 mUSD. One signature.
2. **Competition:** within seconds three bot offers appear (4.0%, 4.5%, 5.0%), each with an Explorer link showing collateral locked. (Tier 2: a judge undercuts at 3.9%; bots requote down to their floors in real time, and the network panel ticks up.)
3. **Activate:** homeowner clicks "Accept selected" on all three. One signature. Panel shows 10,000 activated, 445 premium, 9,555 collateral, 10,000 escrow.
4. **Open participation (optional):** a judge clicks "Get demo funds" and places an offer on Home #1187.
4b. **Secondary trade (Tier 2):** a bot lists its Risk side; a judge wallet buys it in one click. The positions table shows the new holder.
5. **Replay:** operator closes the market on `/demo`. The map shows the perimeter and the 500 m circle. Oracle resolves; evidence hash shown and verified.
6. **Claim:** status `Resolved: triggered`. Homeowner clicks "Claim all". One signature. Balance rises by 10,000.

The NO path (Home #2210) must be implemented and tested. Show it if time allows.

---

## 12. Testing

### 12.1 Program tests (Anchor, local validator)

Setup and config
- [ ] Config initializes once; a second init fails
- [ ] Non-admin cannot register a property; invalid coordinates rejected

Market and offers
- [ ] Market creation copies property data; unknown property rejected; target bounds enforced
- [ ] Offer locks exactly K; premium is floor(C×b/10⁴); `P + K == C`
- [ ] bps 0 and 10,000 rejected; premium rounding to zero rejected; C < MIN or C > target rejected
- [ ] Insufficient balance rejects offer
- [ ] Homeowner cannot underwrite own market
- [ ] Wrong mint rejected on every token-moving instruction
- [ ] Two offers from different wallets in the same slot both succeed
- [ ] Offers on non-`Open` markets rejected

Acceptance
- [ ] Non-homeowner cannot accept
- [ ] Cancelled or already-accepted offer cannot be accepted
- [ ] Offer from another market rejected
- [ ] Acceptance that would exceed the target rejected; offers summing past the target can still all be placed
- [ ] Vault equals C after acceptance
- [ ] Accepted offer cannot be cancelled
- [ ] Acceptance after close rejected

Lifecycle
- [ ] Only controller closes; only oracle resolves; resolve before close rejected; second resolve rejected
- [ ] Unaccepted offers can be cancelled in `Closed`, resolved, and `Voided` markets

Settlement
- [ ] YES pays the homeowner exactly C per position; underwriter claim rejected
- [ ] NO pays the underwriter exactly C per position; homeowner claim rejected
- [ ] Double claim rejected
- [ ] Claim to a token account not owned by the signer rejected
- [ ] Sum of all balances (wallets + vaults) is unchanged across the full lifecycle

Holders and trading (Tier 2)
- [ ] After a Protection-side purchase on a YES market, the buyer can claim and the original homeowner cannot
- [ ] After a Risk-side purchase on a NO market, the buyer can claim and the original underwriter cannot
- [ ] Non-holder cannot list; a stale listing (seller sold elsewhere / no longer holder) cannot be bought
- [ ] Buyer cannot be the seller or the opposite-side holder
- [ ] Purchase moves exactly `price` and leaves the vault unchanged
- [ ] No listing or purchase after resolution; cancel_listing still works

Void (P0.5)
- [ ] Only admin voids; resolved market cannot be voided
- [ ] Refund returns P to homeowner and K to underwriter; double refund rejected

### 12.2 Oracle tests

Section 8.2 list, plus: evidence JSON is byte-identical across runs; hash matches the on-chain value; a market with an unknown `scenario_id` is refused.

### 12.3 End-to-end (Devnet)

1. Wallet connects; faucet funds a fresh wallet.
2. Market creation produces a Devnet transaction.
3. Three bot offers appear within 10 s.
4. Batch accept changes on-chain state; metrics match.
5. Close → resolve → claim succeeds for the YES property.
6. Same flow for the NO property pays underwriters.
7. Explorer amounts match the UI.
8. Repeated or invalid actions fail with readable errors.

### 12.4 Definition of done

A user creates a market, another wallet supplies collateralized coverage, the oracle resolves from packaged historical data, and the correct party claims, entirely through the deployed program on Devnet, for both a YES and a NO property.

---

## 13. Build order

Vertical slices. Don't start the next phase until the current exit criterion passes.

| Phase | Build | Exit criterion |
|---|---|---|
| **P0** | Program: Config, Property, Market, Offer, vaults, all core instructions; full 12.1 suite except Void | All tests green on a local validator |
| **P0.5** | `void_market`, `refund_offer` + tests | Tests green |
| **P1** | Devnet deploy, setup scripts, wallet connect, create/offer/accept/claim UI, faucet | A human completes the YES lifecycle on Devnet |
| **P2** | Bot service | New market gets three real offers automatically |
| **P3** | Dataset, `find-properties.ts`, oracle module, evidence endpoint, settlement page | YES and NO properties resolve correctly from packaged data |
| **T2** | Tier 2 Solana track: listings + `buy_position` + tests, requoting bots, positions table, network panel | A position changes hands on Devnet and the new holder claims; bots visibly requote; network panel shows live numbers |
| **P4** | Exchange polish: cards, order book, funding bar, portfolio, map, batched txs | A judge follows the demo without reading code |
| **P5** | Optional: price history, extra bots, animations | Only if P0–P4 are solid |

Parallelizable from the start: P3's dataset work and `find-properties.ts`, and the frontend shell against a mocked client, can begin alongside P0.

---

## 14. Demo-day checklist

- [ ] Program deployed and verified; program ID in `.env` for frontend and backend
- [ ] Config initialized; properties 1–3 registered
- [ ] Bots hold ≥ 200,000 mUSD and ≥ 1 SOL each
- [ ] Faucet wallet holds ≥ 5 SOL
- [ ] Homeowner demo wallet funded
- [ ] Fallback market seeded with accepted positions
- [ ] YES and NO full runs completed today; Explorer links saved in `docs/demo-script.md`
- [ ] Dataset packaged; no live government API dependency
- [ ] Backup RPC endpoint configured
- [ ] Batched accept and claim tested at three offers

---

## 15. Repository layout

v1.1.1: the layout in `docs/build-plan.md` §2 is authoritative. Oracle, close, faucet, evidence and stats are Next.js route handlers in `app/app/api/` (`oracle/resolve`, `demo/close`, `faucet`, `evidence`, `stats`); UI components live inside `app/`; `services/` holds only the bot worker and the indexer.

---

## 16. Why Solana is central

- **Custody:** collateral sits in program-controlled vaults; no team key can withdraw it.
- **Atomic activation:** premium payment and position activation happen in one instruction.
- **Verifiable funding:** anyone can check that each position's vault holds its full coverage.
- **Atomic secondary trades (Tier 2):** payment and change of claim ownership happen in one instruction, with no counterparty risk.
- **Cost and speed, shown live (Tier 2):** continuous requoting is only practical because each transaction costs a fraction of a cent and confirms in about a second; the network panel shows the actual figures from the demo.
- **Open participation:** any wallet competes under the same rules as the bots.
- **Deterministic settlement:** after resolution, the program alone decides who can claim.
- **Auditable oracle:** the evidence hash on-chain ties each outcome to a reproducible record.

## 17. Long-term vision (not MVP)

Additional fire scenarios (Eaton Fire first), tiered triggers that combine proximity with damage inspection (e.g. 30% on proximity, 100% on Destroyed), other parametric risks (flood, storm, hail), fungible per-market YES/NO tokens with an order book or AMM (building on Tier 2 holder fields), baskets of exposure, decentralized oracles, regulated insurance integration. These inform the architecture; they don't drive hackathon decisions.
