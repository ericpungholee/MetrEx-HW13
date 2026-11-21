# MetrEx — Status

_Last updated: 2026-11-21_

Both generations are complete. The v2 exchange (binary YES/NO outcome tokens and an escrowed order book) passed every gate from V0 to V6 and is deployed on Devnet. The app at `/` is the exchange. The frozen v1.1 program and its app at `/v1` remain the fallback demo.

This page holds the current state only. Per-gate detail lives in the build logs:

| Record | Contents |
|---|---|
| [v2-build-log.md](v2-build-log.md) | V0–V6 results, test counts, the round 8–11 Phantom rehearsal and the post-V6 quality check |
| [v2-devnet-verification.md](v2-devnet-verification.md) | V4 deployment and every §13.3 check with Explorer links |
| [v1-build-log.md](v1-build-log.md) | v1.1 Gates 0–6, the Workstream R review, Tier 2 and the market integrity revision |
| [demo-script.md](demo-script.md) · [v1.1-devnet-verification.md](v1.1-devnet-verification.md) · [v1.1-integrity-audit.md](v1.1-integrity-audit.md) | v1 Devnet records and audit |
| [spec-v2.md](spec-v2.md) · [build-plan-v2.md](build-plan-v2.md) | v2 spec and gates (source of truth for new work) |
| [spec.md](spec.md) · [build-plan.md](build-plan.md) | v1.1 spec and gates (frozen) |
| [archive/](archive/) | The original pre-repo v1.1 drafts, superseded by `spec.md` and `build-plan.md` |

## v2 gates

| Gate | Status | Summary |
|---|---|---|
| V0 — Freeze | **Passed** 2026-11-21 | IDL frozen: 16 instructions, 5 accounts, 10 events, 38 errors. `@metrex/exchange` frozen |
| V1 — Binary tokens | **Passed** 2026-11-21 | Config, property, round, market, split, merge, three settlement paths and redeem. I1, I2, I5–I9 tested |
| V2 — Trading protocol | **Passed** 2026-11-21 | Place, take, match, cancel and sweep. 67 v2 Anchor tests, R checklist all six items |
| V3 — Engine and liquidity (local) | **Passed** 2026-11-21 | Bots, keeper, trade index and the §11 replay end to end on a disposable validator (`scripts/v3-local.sh`) |
| V4 — Devnet | **Passed** 2026-11-21 | Deployed bytes match the tested build. Every §13.3 item passed on Devnet, YES and NO |
| V5 — App replaces v1 | **Passed** 2026-11-21 | `/` is the exchange, v1 at `/v1`, tag `v1.1-demo` on `47cbda2`. Production build passes, fixture build refused |
| V6 — Phantom rehearsal | **Passed** 2026-11-21 | Round 10 matched §11 exactly. Round 11 accepted by the owner. Both live closure rejections and combined sweep-and-redeem claims finalized |

v1.1 Gates 0–6 all passed on 2026-11-20 and 2026-11-21 (see [v1-build-log.md](v1-build-log.md)).

Last full verification (post-V6): `anchor test` 145 passing (78 v1, 67 v2), 198 workspace tests, TypeScript checks, Clippy, production build, fixture guard and the V3 disposable-validator replay.

## Deployed on Devnet

| Item | Address |
|---|---|
| v2 program `metrex_exchange` | [`BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko`](https://explorer.solana.com/address/BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko?cluster=devnet), upgrade authority admin `sQuXrM2LYdxq5sc8dAcsfgFSoa9V6jfNk5txzea87sD` |
| v2 Config | [`786Mr9aEboyAe26Q91mPXpWA92KmsdtGivCkG15aaY2E`](https://explorer.solana.com/address/786Mr9aEboyAe26Q91mPXpWA92KmsdtGivCkG15aaY2E?cluster=devnet), resolution timeout 86,400 s |
| mUSD (shared by v1 and v2) | [`6cb8kKLX9hSfAeLGYxutmbadSckUfZ5cD8KyYZGNbTQC`](https://explorer.solana.com/address/6cb8kKLX9hSfAeLGYxutmbadSckUfZ5cD8KyYZGNbTQC?cluster=devnet) |
| v1.1 program `metrex` (frozen) | [`AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X`](https://explorer.solana.com/address/AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X?cluster=devnet) |

## Open items

None of these block the demo.

- **Wallet redemption (§10.3), deferred for the hackathon.** Redemption bundles every resting order's sweep into one transaction. A wallet with eight resting YES sells produced 1,252 bytes against the 1,232-byte limit. The one-order demo claim fits and was verified on Devnet. Large wallets can cancel orders before redeeming. Splitting the claim needs an owner decision, since §10.3 asks for one transaction.
- **Portfolio history (§10.5).** Completed redemptions are not listed. Only claimable amounts are shown.
- **Dependency advisories.** `npm audit` (production) reports 7 high and 4 moderate transitive advisories, reachability not established. The Rust lockfile scan flags two unmaintained crates. Locked `borsh` 0.10.4 is patched, and the `rand` advisory needs a logging feature the workspace leaves off.
- **V5 rough edges.** `/v1` takes about 20 s to load through the paced RPC proxy. The first visit to an older round costs one property scan (about 10 s cold). The faucet button is still the v1 faucet (same mUSD).
- **Open PR #2** (`cursor/sans-number-font-8d0a`, sans font for amounts) is unreviewed and unmerged.

## Running the demo

- `pnpm tsx scripts/prepare-demo-v2.ts` reuses a fresh round or closes a stale one, settles it and opens a new round. It verifies the bot ladder, worker heartbeats and the private dataset hash.
- Workers: `pnpm --filter bots start:v2` and `pnpm --filter indexer start:v2` (keeper and trade index, `KEEPER_DISABLED=1` stops matching). Both refuse to start when `METREX_ORACLE_DATA_DIR` is set.
- Only the app server's oracle routes read `METREX_ORACLE_DATA_DIR`. The operator page at `/operator` closes and settles a round step by step.
- Rehearsal lesson from V6: when showing a resting order surviving closure, pause the keeper from closure until Phantom confirms the combined sweep-and-redeem, or the keeper sweeps the order first. `scripts/prove-v6-rejection.ts --order <address> --submit` sends the live closure rejection and checks it.

## Owner decisions (approved 2026-11-21, spec-v2 §15)

- **D1** New program `metrex_exchange`. v1.1 stays deployed and frozen as the fallback.
- **D2** No v2 deploy until local V1–V3 pass. A human then funds about 4–5 Devnet SOL.
- **D3** Tightened. The oracle alone resolves while `now < T`. Emergency invalidation needs admin **and** oracle. Anyone can `expire_market` once `now ≥ T`. On-chain timeout bounds are 10 s to 30 days, and Devnet uses 86,400 s.
- **D4** Featured market Home #1042 (YES), with Home #2210 (NO) in the same round.
- **D5** Only the round controller lists markets.
- **D6** No warm-up trades.
- **D7** No blind replay.

## Keys (generated at V0)

`~/.config/metrex/metrex-exchange-program.json` (program ID `BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko`, copied to `target/deploy/`) and `~/.config/metrex/keeper.json`. Both are mode 600 and outside the repo. v2 reuses the existing mUSD mint, mint authority, admin, controller, oracle, bot, faucet and presenter keys.

## Toolchain

### Pinned versions

| Component | Version |
|---|---|
| Anchor CLI / `anchor-lang` / `anchor-spl` | 0.32.3 (installed via avm 0.32.1 built from tag v0.32.3) |
| Anchor TS client | `@anchor-lang/core` 0.32.3 (the package was renamed from `@coral-xyz/anchor` at 0.32.2) |
| Solana CLI (Agave) | 4.1.2 (what Anchor 0.32.3's CI tests against); platform-tools v1.54, cargo 1.84 |
| Rust (host) | 1.100.0 via rustup; program declares `rust-version = "1.84"` so `Cargo.lock` stays buildable by platform-tools |
| `@solana/web3.js` | ^1.98.0 (resolved 1.99.0; v1 required by Anchor TS) |
| `@solana/spl-token` | ^0.4.13 |
| Node / pnpm | v24.18.0 / 10.30.3 |

### Build notes

- Why 0.32.3, not 0.32.1: 0.32.2/0.32.3 contain no security fixes; they backport the SBPF build flags that current Agave toolchains need. Anchor 1.2.2 is the current major release; staying on 0.32.x was the agreed line.
- `anchor-spl` enables `token_2022` only because Anchor's `init` codegen for token accounts references `token_interface`; every instruction still takes `Program<Token>` (classic SPL Token, `Tokenkeg…`).
- When updating Rust deps, run `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update`; otherwise crates that need edition 2024 break `cargo-build-sbf`.
- The program keypair is `target/deploy/metrex-keypair.json` (gitignored). **Back it up to `~/.config/metrex/`**; losing it means a new program ID.
- Toolchain binaries are on `~/.cargo/bin` and `~/.local/share/solana/install/active_release/bin`; installers were run with `--no-modify-path`, so add both to your shell `PATH`.
- `anchor test` needs a wallet; pass `--provider.wallet <path>` or create `~/.config/solana/id.json`.
