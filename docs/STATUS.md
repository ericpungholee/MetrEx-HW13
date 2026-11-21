# MetrEx — Status

_Last updated: 2026-11-21_

## Gates

| Gate | Status | Notes |
|---|---|---|
| 0 — Freeze | **Passed 2026-11-20** | Frozen on owner's instruction to proceed with Gates 1–6. Interfaces in commit 25e10ac are frozen |
| 1 — Core program | **Passed 2026-11-21** | Merged in `00dba89`. Anchor 62/62; independent review in progress before Devnet deployment |
| 2 — Devnet live | Blocked | Devnet faucet rate limits. Both payer wallets reported 0 SOL |
| 3 — Human lifecycle | Not started | |
| 4 — Definition of Done | Not started | |
| 5 — Solana track (T2) | Not started | |
| 6 — Demo-ready | Not started | |

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

## Blockers (human)

1. **Devnet SOL.** On November 21, the public Devnet RPC rate-limited both CLI airdrop requests. The deployer and admin both reported 0 SOL, and the program account was absent. Request about **14 Devnet SOL** for `7CdaAZPSiSKSs7TF4RCrCZZbkaiwTCs8t43qnu7QGvrP` and **1 Devnet SOL** for `sQuXrM2LYdxq5sc8dAcsfgFSoa9V6jfNk5txzea87sD` using the [Solana Foundation faucet](https://faucet.solana.com/) with GitHub sign-in. The deployer target includes approximately 2.71 SOL in ProgramData rent, up to 10.4 SOL in `fund-bots.ts` wallet top-ups, the script's 0.1 SOL reserve and room for transaction fees.

## Gate 1 progress

- **B (geo, dataset, properties): merged** (e50cbf0). Geo 31 tests green. Normalized `data/palisades-2025.geojson` SHA-256 `8447bc02…4b73a`. Properties: 1 Home #1042 (34.045, −118.526) inside, 672 m margin, YES; 2 Home #2210 (34.057, −118.458) 4,000 m out, NO; 3 Home #1187 (34.055, −118.515) inside, 559 m margin, YES. Map check: 1 and 3 lie inside the mapped burn area in Pacific Palisades; 2 checked on OpenStreetMap, on land in West LA by the I-405 near Brentwood. Real perimeter has no holes; hole logic covered by synthetic tests. §8.2 compares the full geodesic distance with the trigger radius. Evidence reports the distance floored to an integer.
- **A (core program): merged** in `00dba89`. `anchor build` passed without warnings after removing the unused `lib` crate type, and the full Anchor suite passed on an isolated local validator (62 tests). The named `inv-1` through `inv-14` cases passed, including wrong-mint coverage for all five core token-moving instructions. YES and NO both conserved balances across wallets and vaults. The test harness now waits for confirmed setup transactions before dependent preflight checks. Shared tests passed (12), including IDL sync. `target/idl`, `target/types` and `packages/shared` match `25e10ac`, and the three Tier 2 handlers remain stubs.
- **C (frontend): merged** in `6a253d0`. Fixtures and browser evidence verification use the registered demo property data.
- **D (backend):** integration commit `869535b` on `ws-d-backend`. `/api/stats` returns the fields read by the app. The oracle uses the packaged geometry loader and rejects unknown scenarios. The setup script verifies upgrade authority before creating the mint and can recover the mint address from an initialized Config. Workspace tests passed (111), TypeScript checks passed and Next.js built with all five API routes. Local validation ran setup, funding and seeding twice, funded a fresh wallet through `/api/faucet`, and exercised both outcomes with the app client, the bots and the close, oracle and evidence routes. Bot offers arrived in about 1.2 s on both local runs. Three offers fit in one acceptance transaction, the YES claims fit in one transaction and each settlement paid exactly 10,000 mUSD. Both evidence files matched their on-chain hashes. The local stats route reported 27 program transactions and 135,000 lamports in fees for this run.

## Resolved

- Keypairs generated 2026-11-20 in `~/.config/metrex/` (mode 600): `admin`, `oracle`, `controller`, `deployer`, `mint-authority`, `faucet`, `bot-a/b/c`, `homeowner-demo`, `judge-1..3`; program keypair backed up as `metrex-program.json`. Local test wallet at `~/.config/solana/id.json` (localnet only).
- Raw perimeter downloaded 2026-11-20 to `data/raw/wfigs-palisades-2025.geojson` from NIFC WFIGS Interagency Perimeters (FeatureServer layer 0, OBJECTID 36398, `2025-CALFD-000738`, 23,448 GIS acres, 16 polygons, no holes). SHA-256 `a88cb3a7785ad1b108c3edc84ddb948885a5a03c291e18a28e3d16a0bb45c6ba`.

## Open questions

- Workstream A applied §2 by requiring distinct, nondefault oracle and controller keys during Config initialization. The instruction interface stayed frozen.
- `pnpm install` skipped build scripts for `bigint-buffer`, `bufferutil`, `esbuild`, `utf-8-validate`. Tests pass without them; run `pnpm approve-builds` if native speed-ups are wanted.
