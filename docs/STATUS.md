# MetrEx — Status

_Last updated: 2026-11-21_

## v2 Exchange (current work)

The owner's v2 draft (binary outcome tokens and an escrowed order book) was reviewed for design flaws and rewritten as [spec-v2.md](spec-v2.md). Section 0 lists the 28 flaws and their fixes, and §14 maps what v2 reuses from v1. The gates and agent briefs are in [build-plan-v2.md](build-plan-v2.md). The v1.1 program, app and tests are unchanged and remain the fallback demo. v2 is local only: nothing is deployed.

| Gate | Status | Notes |
|---|---|---|
| V0 — Freeze | **Passed** 2026-11-21 | `programs/metrex-exchange` compiles with every §6.6 context. IDL `target/idl/metrex_exchange.json` committed: 16 instructions, 5 accounts, 10 events, 38 errors. `@metrex/exchange` (constants, PDAs, math, ladder, book) has 20 tests, including the IDL sync |
| V1 — Binary tokens | **Passed** 2026-11-21 | Config, property, round, market, split, merge, the three settlement paths and redeem are implemented. `tests/exchange.ts` has 36 tests, with `assertMarketInvariants` (I1, I2, I5) after every state change. I1, I2 and I5–I9 have named tests, and YES, NO and Invalid conservation pass. The 78 v1 tests still pass |
| V2 — Trading protocol | **Passed** 2026-11-21 | `place_order`, `take_order`, `match_orders`, `cancel_order` and `sweep_order` are implemented against the frozen contexts. The IDL is unchanged. `tests/exchange.ts` now has 67 tests: 31 for V2, including I3, I4 and I10–I12, the §11 demo replay and the size test. A mutation check, with the execution price forced to the SELL price and the take self-trade check removed, fails 5 of them. R checklist: all six items pass (see below) |
| V3 — Engine and liquidity (local) | **Passed** 2026-11-21 | `scripts/v3-local.sh` passes end to end on a disposable validator (results below). Workspace tests: exchange 33, geo 35, server 50, bots 38, scripts 5, app 13, shared 12. App build passes with the v1 pages unchanged. `anchor test`: 145 passing (67 v2, 78 v1). Program and IDL unchanged |
| V4 — Devnet | **Passed** 2026-11-21 | Deployed at `BrHisWF8…Fko`, admin is upgrade authority, dumped bytes match the tested build. Every §13.3 item passed on Devnet, NO validated separately. See [v2-devnet-verification.md](v2-devnet-verification.md) |
| V5 — App replaces v1 | Not started | Tag `v1.1-demo` first |
| V6 — Phantom rehearsal | Not started | |

### Owner decisions (approved 2026-11-21, spec-v2 §15)

- **D1** New program `metrex_exchange`. v1.1 stays deployed and frozen as the fallback.
- **D2** No v2 deploy until local V1–V3 pass. A human then funds about 4–5 Devnet SOL.
- **D3** Tightened. The oracle alone resolves while `now < T`. Emergency invalidation needs admin **and** oracle. Anyone can `expire_market` once `now ≥ T`. On-chain timeout bounds are 10 s to 30 days, and Devnet uses 86,400 s.
- **D4** Featured market Home #1042 (YES), with Home #2210 (NO) in the same round.
- **D5** Only the round controller lists markets.
- **D6** No warm-up trades.
- **D7** No blind replay.

### Keys (generated at V0)

`~/.config/metrex/metrex-exchange-program.json` (program ID `BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko`, copied to `target/deploy/`) and `~/.config/metrex/keeper.json`. Both are mode 600 and outside the repo. v2 reuses the existing mUSD mint, mint authority, admin, controller, oracle, bot, faucet and presenter keys.

### V1 build notes

- The order instructions (`place_order`, `take_order`, `match_orders`, `cancel_order`, `sweep_order`) have their frozen account contexts. Their bodies return `NotImplemented` until V2, and a test checks this.
- `Cargo.lock` pins `blake3 = 1.8.2`. 1.8.7 pulls a crate that needs edition 2024, which platform-tools Rust 1.84 can't parse. Build with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`.
- `anchor-spl` needs the `token_2022_extensions` feature for `init_if_needed` ATAs to compile.
- The Anchor test glob is quoted (`'tests/*.ts'`). Unquoted, the shell expanded `tests/**/*.ts` to `tests/helpers/invariants.ts` only, and mocha then ran 0 tests with exit code 0.
- Spec corrections after the freeze are in spec-v2 §0.2: the skew sign and the respect rule (both bot policy), and the timeout bounds wording. No interface changed.

### V2 results

- **Demo replay on-chain.** The presenter's market buy of 300 YES fills A 200 @ 430 and B 100 @ 500 for exactly 13.6 mUSD. The sell of 200 @ 410, sent as `place_order` + `match_orders` in one transaction, fills 100 against Bot C for 4.1 mUSD and rests 100. Bot B's 400 bid then returns `OrdersDoNotCross`.
- **Size.** A 4-level take is 1,106 B and about 109k CU. A place + 3-match limit order is 1,181 B and about 114k CU. Both are under 1,232 B and the default compute budget, with every event parsed. The limit order has only 51 B of headroom, so clients should not add a compute-budget instruction to it.
- **R checklist (build-plan-v2 §4), all pass:**
  - Token accounts are bound to the market, order or escrow by PDA seeds, `has_one`, canonical ATA addresses, and handler mint checks against the order's side and outcome.
  - Fills pay `quote(fill, price)` from booked state.
  - Every trading instruction checks the round and the market first.
  - `take_order` checks `expected_seq` and the taker's limit, and fills `min(requested, remaining)`.
  - Cancel and sweep send the whole escrow to the maker's ATA and the rent to the maker.
  - Market and Round are read-only in `take_order` and `match_orders`.
- **Client note.** `match_orders` needs the buyer's canonical mUSD ATA even when the refund is zero (spec-v2 §0.2). Clients prepend an idempotent ATA create.

### V3 results

Run with `bash scripts/v3-local.sh`. It uses throwaway keys in a temp dir (never `~/.config/metrex`), a fresh `solana-test-validator` with `metrex_exchange.so` upgradeable by the temp admin, and `--timeout 120` for the local round. Devnet setup refuses a timeout under 86,400 s.

- **Bots quote within 10 s, never cross.** After `create_market`, three bots quoted both books of both markets in 5.7 s (featured) and 7.7 s (other), and the §8.3 ladder was exact on YES with exact NO complements. Twenty samples over 10 s showed all 12 bot levels and no cross.
- **§11 demo replay through the planners.** A market buy of 300 YES filled A 200 @ 430 + B 100 @ 500 = 13.6 mUSD in one signature. The limit sell 200 @ 410 (place + match) filled 100 against C for 4.1 mUSD and rested 100. After the bots requoted, the best bot bid was 409.
- **Keeper.** A crossing BUY 20 @ 415 placed with no match was matched once by the keeper at the older price 410, with a 0.01 mUSD refund. One `OrderFilled`, no double match.
- **Restart and dedup.** Two fresh loaders rebuilt an identical book fingerprint (13 orders) and identical trade indexes (4 fills). Unit tests cover event dedup across overlapping pages and restarts.
- **Keeper stopped.** With the keeper killed for 22 s, `handleBook`, `handleMarket` and `handleHealth` kept working, and health reported matching "paused".
- **Settlement.** The second `prepare-demo-v2` run found round 1 stale (two non-bot wallets), closed it, resolved both markets through the oracle (round gate and dataset hash checked), swept, then opened round 2 with fresh markets and bots quoting. Property 1 resolved YES, property 2 NO, and both evidence v2 hashes matched on-chain. A take on the closed round was rejected. The presenter redeemed 180 YES for exactly 180 mUSD.
- **Failures logged.** One bot cancel raced a keeper sweep (`AccountNotInitialized`). The keeper logged none.

### V3 notes

- **v2 bots** live in `services/bots/src/v2/` (`pnpm --filter bots start:v2`). The v1 bots are untouched for the fallback demo. The keeper and trade index are `services/indexer/src/v2.ts` (`start:v2`, `KEEPER_DISABLED=1` stops matching).
- **Oracle isolation.** Bots and keeper import only `@metrex/server/exchange`, which never reaches oracle or geo code. Tests enforce this, and both workers refuse to start when `METREX_ORACLE_DATA_DIR` is set.
- **Heartbeats** are files in `METREX_HEARTBEAT_DIR` (default `<repo>/.metrex/heartbeat`, gitignored). They are stale after 20 s. On a hosted deploy the app and workers must share this directory, or V4/V5 needs another channel.
- **Routes.** The §7.5 handlers are in `packages/server/src/routes/exchange.ts`, mounted at `app/app/api/{rounds,markets,health}`. `/api/evidence` still serves v1 only. Wiring v2 evidence into the app is C/V5 work.
- **Local finality** lags about 13 s. Pre-checks in `prepare-demo-v2` read at `confirmed`, and round creation and settlement wait for `finalized`.
- `app/next.config.ts` adds `@metrex/exchange` to `transpilePackages`, because the server root now imports it.

### V4 results

The full record is [v2-devnet-verification.md](v2-devnet-verification.md).

- **Funding:** 20 Devnet SOL from DevnetFaucet.org (needed the owner's X follow and post).
  - Rate-limited: faucet.solana.com (2 per 8 h) and Pine Stake (cooldown).
  - Needed a Mainnet SOL balance: QuickNode and Chainstack.
- **Deploy:** about 7.7 SOL at peak, 3.84 SOL locked. Program `BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko`, upgrade authority admin, dumped SHA-256 `b9d0325e…` equal to the tested build. v1 is untouched.
- **Config:** uses the existing mUSD mint with a resolution timeout of 86,400 s. Properties 1–3 are registered.
- **§13.3:** every item passed on Devnet (`scripts/prove-v4-devnet.ts --phase trade|settled`):
  - split and merge back to the base unit
  - the exact §8.3 bot ladder
  - market buy 300 = 13.6 mUSD
  - limit sell 200 @ 410 with a 100 partial fill
  - cancel returning the escrow and rent
  - NO buy on property 2
  - one close stopping both markets
  - a simulated split rejected with `RoundNotOpen`
  - YES (property 1) and NO (property 2) with evidence v2 hashes matching on-chain
  - redemptions exact: 200 YES → 200 mUSD, 50 NO → 50 mUSD
- **Round 2** (`Crp8ZE8C…`) is open with fresh markets for the demo.

### Next: Gate V5 (app replaces v1)

Tag `v1.1-demo` first. Then build the §10 pages on `app/lib/exchange-client.ts` and wire v2 evidence into `/api/evidence`.

RPC rate limits fixed (2026-11-21, after V4). The workers now read the books with batched, cached `getMultipleAccounts` calls, move order scans to the background, and pace requests with `RPC_MAX_RPS=8` and `RPC_MAX_SCAN_RPS=0.5`. On Devnet: 0 × HTTP 429, about 1.5 requests a second per worker, and bot quotes 6–7 s after market creation on the chain clock (previously 14–23 s). See the Risks section of [v2-devnet-verification.md](v2-devnet-verification.md).

### Effect on v1 open items

- v1 is frozen as the fallback. Don't upgrade the v1 program.


## UI overhaul

Frontend redesigned to a white/black typography-first brokerage look (Geist, open layouts, status as text instead of pills, fewer nested cards). Functionality, wallet flows, settlement, network panel (§10.5), trigger wording, and historical-replay labels unchanged.

## Gates

| Gate | Status | Notes |
|---|---|---|
| 0 — Freeze | **Passed 2026-11-20** | Frozen on owner's instruction to proceed with Gates 1–6. Interfaces in commit 25e10ac are frozen |
| 1 — Core program | **Passed 2026-11-21** | Merged in `00dba89`. Anchor 68/68 after approved review fixes |
| 2 — Devnet live | **Passed 2026-11-21** | Deployed and verified the core program, admin authority, Config, mint, properties and fallback market |
| 3 — Human lifecycle | **Passed 2026-11-21** | Phantom created, accepted and claimed on Devnet. The wallet received exactly 10,000 mUSD and the vault closed |
| 4 — Definition of Done | **Passed 2026-11-21** | Bot offers arrived within 10 s for both live markets, three offers were accepted together, both evidence hashes matched and the winning wallets received exactly 10,000 mUSD per outcome |
| 5 — Solana track (T2) | **Passed 2026-11-21** | Same program ID and admin authority after upgrade. Live requotes, a Risk purchase and the buyer's claim verified on Devnet |
| 6 — Demo-ready | **Passed 2026-11-21** | Both outcomes, fallback, packaged dataset, demo balances and backup RPC verified. Browser rehearsal and demo recording completed |

## Gate 0 checklist

- [x] `docs/spec.md` (v1.1 + v1.1.1 amendments) and `docs/build-plan.md` in place
- [x] Workspace scaffold per build plan §2 (pnpm workspace, `Anchor.toml`, `Cargo.toml`, `.gitignore`, `.env.example`)
- [x] Program stubs: every account (`InitSpace`), every core + Tier 2 instruction with full `Accounts` context and empty body, error enum, events, constants
- [x] `@metrex/shared`: constants, PDA helpers for every §5 seed, account types, display states, error codes/messages, scenario registry + evidence types, offer math; typechecks; 12 tests green (incl. IDL-sync test: errors, seeds, bounds, account set)
- [x] Git repo initialised, remote `origin` = `git@github.com:ericpungholee/MetrEx-HW13.git` (remote was empty)
- [x] Toolchain installed and pinned in `Anchor.toml` `[toolchain]`
- [x] `anchor build` passes with zero warnings
- [x] Program ID `AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X` in `declare_id!` and `Anchor.toml` (localnet + devnet)
- [x] `anchor test` green on local validator (upgradeable deploy; smoke test only)
- [x] IDL + types generated (`target/idl/metrex.json`, `target/types/metrex.ts`): 14 instructions, 5 accounts, 12 events, errors 6000–6021, 19 constants
- [x] IDL + types committed (25e10ac)
- [x] Freeze: owner instructed autonomous execution of Gates 1–6 against these interfaces

## Pinned versions

| Component | Version |
|---|---|
| Anchor CLI / `anchor-lang` / `anchor-spl` | 0.32.3 (installed via avm 0.32.1 built from tag v0.32.3) |
| Anchor TS client | `@anchor-lang/core` 0.32.3 (the package was renamed from `@coral-xyz/anchor` at 0.32.2) |
| Solana CLI (Agave) | 4.1.2 (what Anchor 0.32.3's CI tests against); platform-tools v1.54, cargo 1.84 |
| Rust (host) | 1.100.0 via rustup; program declares `rust-version = "1.84"` so `Cargo.lock` stays buildable by platform-tools |
| `@solana/web3.js` | ^1.98.0 (resolved 1.99.0; v1 required by Anchor TS) |
| `@solana/spl-token` | ^0.4.13 |
| Node / pnpm | v24.18.0 / 10.30.3 |

## Decisions (approved 2026-11-20, recorded in spec v1.1.1)

1. `Offer` has one `protection_holder` and one `risk_holder`, both `Pubkey::default()` until `accept_offer` (§5.4).
2. `initialize_config` requires the signer to be the program's upgrade authority, checked via `ProgramData` (§6). Consequence: `Anchor.toml` sets `[test] upgradeable = true`; on Devnet the deployer keypair must be the upgrade authority **and** the admin signer, or the upgrade authority must be set to `admin` before init.
3. Errors `InsufficientFunds` (6020) and `InvalidSide` (6021) appended (§6.4). `InvalidSide` was added during scaffolding: `list_position` needs a named error for a side other than 0/1.
4. Tier 2 events `PositionListed`, `PositionBought`, `ListingCancelled` (§6.5).
5. Faucet is a route handler `POST /api/faucet` in `app/app/api/faucet/` (plus the `fund-wallet.ts` script) (§9.3).
6. Evidence is served by a route handler in `app/app/api/evidence/` (§8.4).
7. Build plan §2 layout is authoritative over spec §15.

## Interface notes for workstreams

- Instruction args: `initialize_config(oracle, controller)`, `register_property(property_id, label, lat_e6, lon_e6, scenario_id, trigger_distance_m)`, `create_market(market_nonce, property_id, coverage_target)`, `place_offer(offer_nonce, coverage, premium_bps)`, `resolve_market(triggered, evidence_hash)`, `list_position(side, price)`; all others take no args.
- Account names follow Config fields so `has_one` works: signers are `admin`, `demo_controller`, `oracle_authority`.
- `claim_payout` and `refund_offer` take the original `underwriter` (unchecked, `has_one` on Offer) as the vault-rent destination.
- `refund_offer` has no signer account; any fee payer can crank it.
- `@metrex/shared` takes the program ID as a parameter in every PDA helper; it never hard-codes it.
- `@metrex/shared` exports TS source (no build step); consumers use tsx / Next.js `transpilePackages`.

## Build notes

- Why 0.32.3, not 0.32.1: 0.32.2/0.32.3 contain no security fixes; they backport the SBPF build flags that current Agave toolchains need. Anchor 1.2.2 is the current major release; staying on 0.32.x was the agreed line.
- `anchor-spl` enables `token_2022` only because Anchor's `init` codegen for token accounts references `token_interface`; every instruction still takes `Program<Token>` (classic SPL Token, `Tokenkeg…`).
- When updating Rust deps, run `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update`; otherwise crates that need edition 2024 break `cargo-build-sbf`.
- The program keypair is `target/deploy/metrex-keypair.json` (gitignored). **Back it up to `~/.config/metrex/`**; losing it means a new program ID.
- Toolchain binaries are on `~/.cargo/bin` and `~/.local/share/solana/install/active_release/bin`; installers were run with `--no-modify-path`, so add both to your shell `PATH`.
- `anchor test` needs a wallet; pass `--provider.wallet <path>` or create `~/.config/solana/id.json`.

## Devnet RPC configuration

- The free Chainstack Solana Devnet node served the Phantom claim and bot runs. The server uses the official Solana Devnet endpoint as a fallback. Both returned the Devnet genesis hash. The official endpoint was rate-limited during earlier runs.

## Gate 1 progress

- **B (geo, dataset, properties): merged** (e50cbf0). Geo 31 tests green. Normalized `data/palisades-2025.geojson` SHA-256 `8447bc02…4b73a`. Properties: 1 Home #1042 (34.045, −118.526) inside, 672 m margin, YES; 2 Home #2210 (34.057, −118.458) 4,000 m out, NO; 3 Home #1187 (34.055, −118.515) inside, 559 m margin, YES. Map check: 1 and 3 lie inside the mapped burn area in Pacific Palisades; 2 checked on OpenStreetMap, on land in West LA by the I-405 near Brentwood. Real perimeter has no holes; hole logic covered by synthetic tests. §8.2 compares the full geodesic distance with the trigger radius. Evidence reports the distance floored to an integer.
- **A (core program): merged** in `00dba89`. `anchor build` passed without warnings after removing the unused `lib` crate type, and the full Anchor suite passed on an isolated local validator (62 tests). The named `inv-1` through `inv-14` cases passed, including wrong-mint coverage for all five core token-moving instructions. YES and NO both conserved balances across wallets and vaults. The test harness now waits for confirmed setup transactions before dependent preflight checks. Shared tests passed (12), including IDL sync. `target/idl`, `target/types` and `packages/shared` match `25e10ac`, and the three Tier 2 handlers remain stubs.
- **C (frontend): merged** in `6a253d0`. Fixtures and browser evidence verification use the registered demo property data.
- **D (backend): merged** in `ac24a36`. `/api/stats` returns the fields read by the app. The oracle uses the packaged geometry loader and rejects unknown scenarios. The setup script verifies upgrade authority before creating the mint and can recover the mint address from an initialized Config. Workspace tests passed (111), TypeScript checks passed and Next.js built with all five API routes. Local validation ran setup, funding and seeding twice, funded a fresh wallet through `/api/faucet`, and exercised both outcomes with the app client, the bots and the close, oracle and evidence routes. Bot offers arrived in about 1.2 s on both local runs. Three offers fit in one acceptance transaction, the YES claims fit in one transaction and each settlement paid exactly 10,000 mUSD. Both evidence files matched their on-chain hashes. The local stats route reported 27 program transactions and 135,000 lamports in fees for this run.

## Approved deployment fixes and local rehearsal

- The owner approved §4.4 surplus accounting and disabled Tier 2 entry points on November 21. Booked obligations use the recorded Offer terms. Cancellation sends collateral and surplus to the original underwriter. A void refund sends premium to the original homeowner and collateral and surplus to the original underwriter. A claim sends exactly coverage to the current winner and routes surplus to the original underwriter, or to the original homeowner if the underwriter is the claimant. The writable surplus token destination uses Anchor remaining accounts and is validated as a classic SPL account for the approved owner and mint. The app can create the destination permissionlessly and falls back to a fresh token account if the usual ATA cannot receive it. The frozen IDL, types, and shared package still match Gate 0.
- All three disabled Tier 2 calls reject with the existing `Unauthorized` error. The local test fixture exercises purchase and cancellation against a valid Listing and checks its data, holders and balances remain intact. A separate test checks listing creation rolls back. The app keeps trading controls off until `NEXT_PUBLIC_ENABLE_TIER2=1`.
- Local validator setup registered all three properties and the minimum funding profile supported a seeded fallback market. `scripts/prove-lifecycle.ts --manual --local` completed the app-client judge lifecycle. `--local` then funded a fresh wallet through the faucet, received three bot offers on each market within 10 seconds, accepted all three in one transaction, verified each evidence hash against its resolved account and paid exactly 10,000 mUSD on both outcomes. The YES claims fit in one transaction. The local stats route reported 33 transactions and 165,000 lamports in fees. These proofs used a local validator.
- Devnet deployment uses the backed-up program keypair for the same address and the admin as upgrade authority, with the deployer as fee payer. Verify the deployed authority before running `setup-devnet.ts`. The [Devnet verification record](demo-script.md) links the deployed program, Config, properties, funding transactions and funded fallback market.

## Independent core review (Workstream R)

A fresh reviewer audited `00dba89` on November 21. The findings below describe the audited commit. The approved fixes are recorded above. The review inspected the code and test assertions. The recorded 62-test validator run was performed separately.

### §6 instruction checks

File names refer to [`programs/metrex/src/instructions`](../programs/metrex/src/instructions).

| Instruction | Enforcement |
|---|---|
| `initialize_config` | `initialize_config.rs:9–35` binds the unique Config PDA, classic mint, program and upgrade authority. `:40–58` sets the distinct roles and requires six decimals. |
| `register_property` | `register_property.rs:9–27` binds the Config admin and unique property ID. `:41–59` checks coordinates and a positive trigger and saves the data. |
| `create_market` | `create_market.rs:10–27` binds the homeowner and registered Property. `:38–64` enforces target bounds and copies the registered data into an Open market. |
| `place_offer` | `place_offer.rs:11–60` binds the source wallet, mint and PDAs. `:70–104` checks state, self-underwriting, terms and funds. `:106–142` transfers exact collateral and records the Open offer. |
| `cancel_offer` | `cancel_offer.rs:10–55` binds the original underwriter and requires an Open offer in any market state. `:57–94` drains and closes the vault under Offer PDA authority and marks the offer Cancelled. |
| `accept_offer` | `accept_offer.rs:10–82` binds the homeowner, accounts and Open states and checks remaining coverage and funds. `:84–118` transfers the booked premium and sets the initial holders. The raw-balance assertion can block acceptance when the vault contains surplus. |
| `close_market` | `close_market.rs:8–34` binds the controller to Config and allows only Open → Closed. |
| `resolve_market` | `resolve_market.rs:8–40` binds the oracle to Config and allows only Closed → ResolvedYes or ResolvedNo, with the evidence hash. |
| `claim_payout` | `claim_payout.rs:10–74` binds the signer and destination to the current winning holder and checks resolved and Accepted states. `:76–113` pays the raw balance, closes the vault and marks Claimed. A surplus can increase payment above booked coverage. |
| `list_position` | Tier 2 deferred. `list_position.rs:10–39` binds accounts and can create the Listing. `:44–46` returns success without applying the trading rules. |
| `buy_position` | Tier 2 deferred. `buy_position.rs:10–63` binds accounts and declares Listing closure. `:66–69` returns success without payment or holder updates. |
| `cancel_listing` | Tier 2 deferred. `cancel_listing.rs:9–20` checks the seller and declares Listing closure. `:23–26` returns success. |
| `void_market` | `void_market.rs:8–32` binds the Config admin and allows only Open or Closed → Voided. |
| `refund_offer` | `refund_offer.rs:10–83` binds the recorded parties and requires Voided and Accepted. `:86–133` refunds booked premium, sends the balance remainder to the original underwriter, closes the vault and marks Refunded. A surplus can increase the remainder above booked collateral. |

### §6.3 invariants

Test line numbers refer to [`tests/metrex.ts`](../tests/metrex.ts).

| Invariant | Enforcement | Test line |
|---|---|---:|
| 1. Config authorities | `resolve_market.rs:8–16`, `close_market.rs:8–16`, `register_property.rs:9–18`, `void_market.rs:8–16` | 1206 |
| 2. Config as source of authorities and mint | `initialize_config.rs:22–58` is the one-time, upgrade-authority-gated setup exception. `place_offer.rs:38–51` binds the supplied mint account to Config. | 1224 |
| 3. Registry coordinates | `register_property.rs:20–27`, `create_market.rs:14–18,44–55` | 1247 |
| 4. Homeowner accepts and original underwriter cancels | `accept_offer.rs:10–22`, `cancel_offer.rs:10–28` | 1277 |
| 5. Self-underwriting rejected | `place_offer.rs:75–78` | 1288 |
| 6. Accepted offers cannot cancel | `cancel_offer.rs:47–52` | 1296 |
| 7. Activated coverage bounded by target | `create_market.rs:56–58`, `accept_offer.rs:69–78,106–111` | 1308 |
| 8. Booked premium and collateral sum to coverage | `place_offer.rs:89–99,132–135` | 1329 |
| 9. Terminal market states | `close_market.rs:26–34`, `resolve_market.rs:26–40`, `void_market.rs:26–32`, `accept_offer.rs:54–64` | 1355 |
| 10. Terminal offer states | `cancel_offer.rs:47–52,68–94`, `claim_payout.rs:67–70,87–113`, `refund_offer.rs:62–72,98–133` | 1377 |
| 11. Winner alone can claim | `claim_payout.rs:10–11,57–71` | 1408 |
| 12. Token mint equals Config mint | `place_offer.rs:38–60`, `cancel_offer.rs:30–55`, `accept_offer.rs:37–51,65–67`, `claim_payout.rs:36–54,72–74`, `refund_offer.rs:34–59,73–75` | 1444, 1534 |
| 13. Checked arithmetic and classic Token CPI | `place_offer.rs:89–99,106–116`, `accept_offer.rs:69–111`, `refund_offer.rs:77–83`. Vault outflows use Offer PDA seeds in `cancel_offer.rs:57–91`, `claim_payout.rs:76–110`, `refund_offer.rs:86–130`. Deposits use the source wallet signature. | 1483, 1534 |
| 14. Current stored holder receives the claim | `accept_offer.rs:114–118`, `claim_payout.rs:43–48,57–71` | 1513 |

The integrated setup creates and verifies a mint without a freeze authority. Direct initialization is upgrade-authority-gated and checks mint decimals in `initialize_config.rs:47–51`. Property registration trusts the admin for scenario ID, positive trigger and label bytes in `register_property.rs:41–59`. Provisioning validates the packaged scenario, 500 m trigger and encoded labels. The frozen `u16` `accepted_count` limits a market to 65,535 accepted offers. `accept_offer.rs:106–111` rolls back on overflow. The nine named core lifecycle events in §6.5 are emitted. The frozen event list defines no events for initialization or registration.

## Gate 2 verification

- A confirmed 5 SOL deposit funded the Devnet deployer. The earlier CLI airdrops were rate-limited, and SolFaucet reported its RPC faucet closed. DevnetFaucet.org authenticated GitHub but rejected the submitted claim under its eligibility list. The documented proof-of-work pool was empty and its fee bootstrap was rate-limited. Funding came through the Solana Foundation web faucet.
- RPC write transport hit the public per-IP rate limit. Retrying with the same explicit buffer and default TPU transport succeeded. The ProgramData is 537,880 bytes at slot 524610462. The downloaded bytes match the tested build, and the on-chain authority is the admin. The measured ProgramData and Program rent totals 2.73414236 Devnet SOL before transaction fees.
- The admin was funded, initialized the no-freeze mUSD mint and Config, and registered properties 1–3. Minimum funding transactions topped up the bots and demo wallets. The fallback market has three accepted positions and 10,000 mUSD activated.
- The separately reviewed Tier 2 rehearsal is on [codex/tier2-local](https://github.com/ericpungholee/MetrEx-HW13/tree/codex/tier2-local), with 71 Anchor tests and a verified local purchase and claim. That work is merged and deployed on Devnet.

## Tier 2 local rehearsal

- The full Anchor validator suite passed (71 tests), including invariants 15–17 and both price mismatch cases through the app client. Workspace tests (111), TypeScript checks, the Tier 2 production build and the frozen interface comparison also passed.
- A 390 bps judge offer caused the three local bots to requote to 380, 400 and 450 bps. After accepting the three bot offers, the judge bought a listed Risk position and claimed it following the NO resolution. The winners received 10,000 mUSD in total, and the serialized evidence matched the on-chain hash. The local network panel reported 31 transactions and 155,000 lamports in fees.
- Independent read-only review checked §6.3 invariants 15–17. Listing authority, state and price are checked in `list_position.rs:44–59`. Purchase binds the listing, offer, seller and both mUSD accounts in `buy_position.rs:13–63`, rejects stale holders and conflicting roles in its handler, then transfers the price and records the buyer before Anchor closes the listing. The account contexts for listing, purchase and cancellation have no vault account. Cancellation binds the seller and refunds listing rent in `cancel_listing.rs:8–20`.
- The app funds a temporary token account with the displayed price and closes it within the purchase transaction. A higher on-chain price exceeds that balance. A lower price leaves a balance that prevents closure and rolls back payment and ownership changes. A validator regression exercised both mismatched quotes through the app client, then executed the matching quote.
- The [demo rehearsal script](demo-script.md) contains the Devnet verification links.

## Tier 2 Devnet verification

- The owner funded the 555,992-byte upgrade through the Solana Foundation faucet. ProgramData grew by 18,112 bytes. The admin remained upgrade authority and the downloaded ELF matched the tested build. Anchor passed 71 tests, the workspace passed 113 tests, TypeScript and production build checks passed, and the frozen interfaces matched Gate 0.
- After an RPC rate limit, the proof resumed from the same market and offers. A 390 bps judge quote led to live bot rates of 380, 400 and 450 bps. The judge paid 2,932.50 mUSD for the Risk position and later claimed 3,000 mUSD. The combined payout was 10,000 mUSD and the evidence hash matched.
- The warmed network index returned 65 program transactions and 570,000 lamports in fees with zero fees pending. The panel labels partial fee data during indexing.

## Gate 6 rehearsal

- All three bots held 1.01 SOL and more than 242,000 mUSD each. The demo faucet held 5.693713800 SOL after a finalized 2 SOL Pine Stake airdrop. The demo homeowner held 117,858 mUSD and 0.033132800 SOL. The fallback market remained open with 10,000 mUSD activated across three accepted positions.
- Local ignored configuration sets the verified program ID and mUSD mint for the app and server. The app reads the private Chainstack connection through a loopback RPC bridge. The official fallback is configured for server requests.
- Browser rehearsal found that the settlement page fetched the evidence API's JSON envelope for hashing. The app now fetches the canonical bytes. Regression tests cover the raw response request and reporting incomplete network fees. The final workspace run passed 115 tests and TypeScript checks.
- The browser displayed the YES evidence hash match, the live network panel, and the NO market's purchase and payout events. The local demo recording is a 34-second WebM replay of the verified Devnet screens. Playback and seeking were verified in Chrome.

## Resolved

- Keypairs generated 2026-11-20 in `~/.config/metrex/` (mode 600): `admin`, `oracle`, `controller`, `deployer`, `mint-authority`, `faucet`, `bot-a/b/c`, `homeowner-demo`, `judge-1..3`; program keypair backed up as `metrex-program.json`. Local test wallet at `~/.config/solana/id.json` (localnet only).
- Raw perimeter downloaded 2026-11-20 to `data/raw/wfigs-palisades-2025.geojson` from NIFC WFIGS Interagency Perimeters (FeatureServer layer 0, OBJECTID 36398, `2025-CALFD-000738`, 23,448 GIS acres, 16 polygons, no holes). SHA-256 `a88cb3a7785ad1b108c3edc84ddb948885a5a03c291e18a28e3d16a0bb45c6ba`.

## Open questions

- Workstream A applied §2 by requiring distinct, nondefault oracle and controller keys during Config initialization. The instruction interface stayed frozen.
- `pnpm install` skipped build scripts for `bigint-buffer`, `bufferutil`, `esbuild`, `utf-8-validate`. Tests pass without them; run `pnpm approve-builds` if native speed-ups are wanted.

## Market integrity revision

PR #3 merged and the existing Devnet program was upgraded in place at slot 524644844. The release preserved the program ID, upgrade authority, and all 35 pre-existing account data hashes. Both live settlement outcomes paid 10,000 mUSD, and the Phantom browser rehearsal confirmed a 120 mUSD claim across two markets. [Deployment and verification record](v1.1-devnet-verification.md) · [Market integrity audit](v1.1-integrity-audit.md)
