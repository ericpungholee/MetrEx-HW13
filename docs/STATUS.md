# MetrEx — Status

_Last updated: 2026-11-20_

## Gates

| Gate | Status | Notes |
|---|---|---|
| 0 — Freeze | **Frozen — interface approved** | Gate 0 review against spec §5 and generated IDL completed at `25e10ac`; local keypair backup still unverified |
| 1 — Core program | Not started | |
| 2 — Devnet live | Not started | |
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
- [x] IDL + types committed (Gate 0 commit `25e10ac`)
- [x] Human review of account structs, PDA seeds, instruction arguments, program ID and generated IDL against spec §5–6; **interfaces frozen**

## Gate 0 interface review (2026-11-20)

- Reviewed GitHub commit `25e10ac` against `docs/spec.md` §5–6: all five Anchor account layouts and six PDA derivations agree with the spec (including integer seed byte order), all 14 instruction signatures are present, and the program ID is consistent in Rust, `Anchor.toml` and the IDL.
- This is an **interface freeze**, not approval of business logic: Gate 0 instruction handlers are empty stubs and the reported `anchor test` is a program-load smoke test. Full security and lifecycle tests remain Gate 1 work.
- Gate 1 review requirements: validate the vault mint and token authority on every token-moving path; enforce distinct oracle/controller keys at initialization to honor spec §2. These checks need no frozen interface change.
- **Operational action still required:** back up `target/deploy/metrex-keypair.json` outside the repository (e.g. `~/.config/metrex/metrex-program.json`) and confirm its public key is `AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X`. This cannot be verified from GitHub.

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

1. **Keypairs missing.** `~/.config/metrex/` does not exist. Need `admin`, `oracle`, `controller`, `bot-a/b/c`, `homeowner-demo`, `judge-1..3`, `deployer`, `mint-authority`, `faucet`.
2. **Devnet SOL** not yet requested for `deployer` and `admin`.
3. **Raw fire perimeter** not in `data/raw/` (CAL FIRE / NIFC final Palisades perimeter).
4. **Program keypair backup unverified.** Copy the existing `target/deploy/metrex-keypair.json` to a private location and check the public key before deploying; never commit it.

## Open questions

- Gate 1: enforce `oracle != controller` in `initialize_config` (spec §2 requires distinct keys; no interface change).
- `pnpm install` skipped build scripts for `bigint-buffer`, `bufferutil`, `esbuild`, `utf-8-validate`. Tests pass without them; run `pnpm approve-builds` if native speed-ups are wanted.
