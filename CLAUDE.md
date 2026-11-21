# MetrEx — Project Context for Coding Agents

> Also usable as `AGENTS.md`. Read this file first, every session.

## What this is

MetrEx is an on-chain exchange for catastrophe risk, built for Hack Western 13 (MLH Best Use of Solana). Each market asks one binary question: did the final mapped footprint of a historical fire (January 2025 Palisades Fire) come within 500 m of a registered property? Fungible YES and NO SPL tokens are minted in pairs against 1 mUSD each in a market vault. They trade in a fully escrowed limit order book with real partial fills. One round closure stops trading on every market of the fire, and an oracle settles from a dataset whose hash was committed on-chain before trading. Winning shares redeem for 1 mUSD.

The product has two generations in this repo:

| | v1.1 (deployed, frozen) | v2 Exchange (current work) |
|---|---|---|
| Model | Per-offer RFQ underwriting, transferable claim rights | Binary outcome tokens + escrowed order book |
| Program | `programs/metrex` at `AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X` | `programs/metrex-exchange` (new program ID, local only until V3 passes) |
| Spec | `docs/spec.md` | **`docs/spec-v2.md`** |
| Plan | `docs/build-plan.md` (Gates 0–6, all passed) | `docs/build-plan-v2.md` (Gates V0–V6) |

YES is parametric protection for homeowners dropped by insurers. It pays on fire proximity, not on damage. MetrEx is a risk exchange, not insurance.

## Source of truth

| File | Role |
|---|---|
| `docs/spec-v2.md` | **The specification for all new work.** Section 0 lists the design flaws found in the v2 draft and how they were fixed. Section numbers (§) below refer to it unless marked v1 |
| `docs/spec.md` | v1.1 spec. Governs `programs/metrex`, `packages/shared` and existing v1 code only |
| `docs/build-plan-v2.md` | v2 gates, workstreams, agent briefs, acceptance |
| `docs/STATUS.md` | Current gate status, owner decisions and blockers. Update it whenever a gate passes or you get blocked |
| `docs/v1.2-design-review.md` | Why replay prices aren't forecasts, and the trusted-role limits. Still applies to v2 |
| This file | Conventions and hard rules |

If code and spec disagree, the spec wins. If the spec looks wrong, **stop and report** in `docs/STATUS.md` instead of improvising.

## Stack

- Programs: Rust + Anchor 0.32.3 / Agave 4.1.2 (pinned in `Anchor.toml`; never upgrade), classic SPL Token program, Solana Devnet
- `packages/shared`: v1 constants, PDAs, types, scenarios, evidence v1 (**frozen**)
- `packages/exchange` (v2, to be created at V0): `@metrex/exchange` constants, PDAs, account types and quote math (frozen at V0), plus pure book, planner and chart functions
- `packages/geo`: Turf.js trigger evaluation, canonical JSON, evidence builders
- `packages/server`: RPC fallback, keys, oracle, evidence gate, faucet, password, stats
- Frontend: Next.js (App Router) + TypeScript + Tailwind + Wallet Standard adapter in `app/`
- Workers: `services/bots` (market makers), `services/indexer` (stats; v2 adds book cache, trade index and keeper)
- pnpm workspace

## Repository layout

```text
programs/metrex/              v1.1 program. FROZEN; never modify or upgrade
programs/metrex-exchange/     v2 program (V0)
tests/metrex.ts               v1 Anchor tests (must keep passing)
tests/exchange.ts             v2 Anchor tests; tests/helpers/invariants.ts = assertMarketInvariants (§13.1)
packages/shared/              v1, FROZEN
packages/exchange/            v2 shared TS (frozen parts at V0)
packages/geo/                 trigger evaluation + evidence (v2 builder is additive)
packages/server/              oracle, evidence, faucet, routes, stats
data/                         palisades-2025.geojson, scenarios.json, DATASET.md, raw/
app/                          Next.js; v2 chain access via app/lib/exchange-client.ts
services/bots/                market-maker bots
services/indexer/             stats; v2 book, trades, keeper
scripts/                      setup-devnet(-v2), prepare-demo-v2, fund-bots, fund-wallet, find-properties
docs/                         spec-v2.md, build-plan-v2.md, STATUS.md, spec.md (v1), build-plan.md (v1)
```

## Commands

```bash
pnpm install
anchor build                 # also regenerates IDLs in target/idl + types
anchor test                  # local validator, runs tests/*.ts (helpers in tests/helpers/)
pnpm -r test                 # TS package tests
pnpm --filter app dev        # frontend
pnpm --filter bots start     # bot worker
pnpm tsx scripts/<name>.ts   # scripts (all idempotent)
```

Run the relevant tests before every commit. Never commit with failing tests, v1 included.

## Hard rules (v2)

### Money and math
- mUSD amounts are `u64` base units (6 decimals). Shares are `u64` with **0 decimals**. One share pays exactly 1,000,000 base units on a win and 500,000 on Invalid.
- Prices are `u16` basis points, 1–9,999. `quote = quantity × price_bps × 100` in checked `u128`. There is no rounding anywhere. **No floating point in the program.**
- Program state books obligations (`pairs_outstanding`, `remaining_qty`). Require `balance ≥ obligation` and **never raw equality**. Payouts use booked amounts and never the raw balance (§4.6). Unsolicited surplus stays stranded in vaults, and in order escrows it goes to the maker.
- Only `split` mints outcome tokens. The market PDA is the sole mint authority. No mint has a freeze authority.

### Trading
- Every order is fully escrowed at placement (§5.2). Fills never exceed remaining quantity, never execute outside either limit price, and execute at the older or resting order's price. Price improvement is refunded to buyers.
- `take_order` always carries the taker's limit price and `expected_seq`. Order PDAs use a client nonce, never a shared counter.
- Self-trade is rejected. Bots are post-only, quote NO as exact complements of YES, and never cross the book (§8.2).
- Fills and matches take Market and Round read-only.
- Cancel and sweep return the full escrow and rent to the maker, always.
- Trading (`split`, `place_order`, `take_order`, `match_orders`) requires round Open, `now < trading_ends_at` and market Unresolved. `merge` works until resolution. Cancel and sweep always work.

### Authority and lifecycle
- Admin, round controller, oracle and collateral mint come **only** from `Config`. No instruction accepts an authority argument.
- Market coordinates come only from a registered `Property`. One market per (round, property). The property's scenario must equal the round's.
- **At most one Open round.** One `close_round` stops every member market. With `T = closed_at + resolution_timeout_s`, settlement and recovery are separate instructions: the oracle alone resolves (`resolve_market`, only while `now < T`), admin and oracle together invalidate in an emergency (`invalidate_market`), and anyone can expire to Invalid once `now ≥ T` (`expire_market`).
- Contract guarantees and off-chain policy (price-time priority, keeper speed, bot behaviour) are listed separately in spec-v2 §5.10. Never present policy as a guarantee.
- Redemption burns the signer's own tokens and pays the signer's own mUSD account. There is no redirection and no delegate path.
- Check mint, owner and market binding on every token account (I10).

### Frozen interfaces
- **v1:** `programs/metrex` and `packages/shared` are frozen for good. Don't modify, don't upgrade the Devnet program.
- **v2:** after Gate V0, the `metrex_exchange` account layouts, PDA seeds, instruction names and arguments, error codes, events, `MAX_TAKE_LEVELS`/`MAX_MATCH_LEVELS` and the frozen part of `packages/exchange` must not change without an explicit human instruction. Write needed changes in `docs/STATUS.md` and stop that line of work.

### Data and the oracle
- Never invent coordinates, fire geometry or dataset hashes. Properties come from `data/DATASET.md` (selected with `scripts/find-properties.ts` under the v1 §8.3 margins).
- A point inside a perimeter **hole** is not inside the footprint.
- Evidence JSON is canonical (sorted keys, no whitespace, integers only), SHA-256 hashed. v2 evidence adds `round` and has `version: 2`.
- The oracle refuses a dataset whose SHA-256 differs from `round.dataset_sha256`.
- No live government API calls at runtime. Settlement data lives only in the private `METREX_ORACLE_DATA_DIR`. **Bots, keeper and the trading app never read it.** The bot worker refuses to start if that variable is set, and a test forbids bots importing `@metrex/geo` or oracle modules.

### Frontend
- Never fake a transaction, fill, price, level, chart point or volume. Everything shown comes from on-chain accounts or finalized events. Optimistic rows are marked pending.
- Never synthesize an executable NO quote from YES. Complements must be labelled "indicative".
- Fixtures exist only behind `NEXT_PUBLIC_USE_FIXTURES=1`, and production builds must fail with it on.
- Every market page shows, as plain text: *"Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage."* It also shows the historical-replay disclosure, the invalid-outcome disclosure and the note that liquidity comes from MetrEx-operated market makers (§10.1).
- Evidence and the perimeter require finalized settlement and a matching on-chain hash.
- The homepage features only `Config.latest_round`. Operator controls live only at password-protected `/operator`.
- Explorer links use `?cluster=devnet`.
- The v1 app stays the default until Gate V5. Tag `v1.1-demo` before replacing pages.

### Secrets
- Keypairs live in `~/.config/metrex/*.json`, never in the repo. Only `.env.example` is committed.
- Never print private keys or secret env values in logs or output.

### Sensitivity
- Home labels are fictional. Coordinates are approximate points, not real addresses.
- Never use a real damage-inspection (DINS) record as a demo property. DINS may appear only as aggregate figures.

## Out of scope — do not build

Mainnet, real money, other risk types or fire scenarios, damage-based triggers, leverage or margin, AMMs and pools, on-chain order-book priority enforcement, complementary cross-book matching, trading fees, session keys or gasless trading, LLM- or ML-driven pricing, decentralized oracles, KYC, mobile apps, governance tokens, P&L or tax accounting, migrating v1 positions, the blind-replay variant, a database (use on-chain reads + in-memory cache). Partial fills, fungible outcome tokens and a matching keeper **are now in scope** (v2).

## Gates

- v1 (`docs/build-plan.md`): 0–6 all passed on 2026-11-21.
- v2 (`docs/build-plan-v2.md` §5): V0 Freeze → V1 Binary tokens → V2 Trading protocol (+ R exit checklist) → V3 Engine and liquidity (local) → V4 Devnet (YES and NO) → V5 App replaces v1 → V6 Phantom rehearsal.

Nothing reaches main that breaks v1 tests or the v1 fallback demo before V5.

## Stop and ask a human when

- Devnet SOL, keypairs or a deploy is needed and not already available
- A spec-v2 §15 owner decision is unresolved and your work depends on it
- A frozen interface needs to change
- The spec is ambiguous or seems wrong
- A security finding needs a design decision

Record the blocker in `docs/STATUS.md`, then continue with any work that doesn't depend on it.

## Style

- Rust: one file per instruction in `instructions/`; `require!` with named errors; no `unwrap()` in program code.
- TypeScript: strict mode; no `any` in `packages/`; BN/bigint for token amounts, never JS numbers.
- Pure logic (book, planner, strategy, chart reducer) lives in testable functions with no I/O.
- Small commits with messages naming the spec and section (`feat(exchange): match_orders spec-v2 §5.5`).
