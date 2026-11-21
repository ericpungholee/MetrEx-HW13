# MetrEx — Project Context for Coding Agents

> Also usable as `AGENTS.md`. Read this file first, every session.

## What this is

MetrEx is an on-chain underwriting exchange for individual parametric wildfire risk, built for Hack Western 2026 (MLH Best Use of Solana). A homeowner lists a risk, traders compete to underwrite it with fully collateralized offers, an oracle reports whether a historical fire (January 2025 Palisades Fire) came within 500 m of the property, and a Solana program pays the winning side from escrow. Positions can be traded on-chain (Tier 2).

Target user: homeowners dropped by traditional insurers. The product is parametric gap coverage: it pays on fire proximity, not on damage.

## Source of truth

| File | Role |
|---|---|
| `docs/spec.md` | **The specification.** Every behaviour, account, instruction, invariant and test is defined here. Section numbers (§) below refer to it. |
| `docs/build-plan.md` | Gates, workstreams, ownership, acceptance criteria |
| `docs/STATUS.md` | Current gate status and open issues. Update it whenever a gate passes or you get blocked |
| This file | Conventions and hard rules |

If code and spec disagree, the spec wins. If the spec looks wrong, **stop and report** in `docs/STATUS.md` instead of improvising.

## Stack

- Program: Rust + Anchor (version pinned in `Anchor.toml`; never upgrade), classic SPL Token program, Solana Devnet
- Shared TS: `packages/shared` (constants, PDA helpers, account types, scenario + evidence types)
- Geo: `packages/geo` (Turf.js trigger evaluation, canonical JSON, evidence builder)
- Frontend: Next.js (App Router) + TypeScript + Tailwind + Solana wallet adapter (Wallet Standard), in `app/`
- Backend: one Node/TypeScript worker (`services/bots`, `services/indexer`) + Next.js route handlers for oracle, close, faucet, evidence and stats
- Package manager: pnpm workspace

## Repository layout

```text
programs/metrex/src/   lib.rs, state.rs, errors.rs, constants.rs, instructions/*.rs
tests/metrex.ts        Anchor tests (§12.1)
packages/shared/       FROZEN after Gate 0
packages/geo/          trigger evaluation + evidence
data/                  palisades-2025.geojson, scenarios.json, DATASET.md, evidence/, raw/
app/                   Next.js; all chain access via app/lib/client.ts
app/app/api/           oracle/resolve, demo/close, faucet, evidence, stats
services/bots/         underwriter bots (+ requoting)
services/indexer/      program tx stats
scripts/               setup-devnet, fund-bots, fund-wallet, seed-demo, find-properties
docs/                  spec.md, build-plan.md, STATUS.md, demo-script.md
```

## Commands

```bash
pnpm install
anchor build                 # also regenerates IDL in target/idl + types
anchor test                  # local validator, runs tests/metrex.ts
pnpm -r test                 # TS package tests (geo, shared)
pnpm --filter app dev        # frontend
pnpm --filter bots start     # bot worker
pnpm tsx scripts/<name>.ts   # scripts (all idempotent)
```

Run the relevant tests before every commit. Never commit with failing tests.

## Hard rules

### Money and math
- All amounts are `u64` base units of `mUSD` (6 decimals). Intermediate products in `u128`.
- Rates are `u16` basis points. **No floating point in the program.**
- `premium = floor(coverage × bps / 10_000)`, `collateral = coverage − premium`, computed **on-chain**. Callers pass only `coverage` and `bps`.
- Every arithmetic op is checked. Every vault holds exactly `0`, `collateral`, or `coverage` (§4.4).

### Authority
- Oracle, demo controller, admin and mint come **only** from the `Config` PDA. No instruction accepts them as caller-supplied values.
- Market coordinates come **only** from a registered `Property`.
- Claims go to `protection_holder` (YES) / `risk_holder` (NO), never to hard-coded roles.
- Check mint and owner on every token account.

### Frozen interfaces (after Gate 0)
Account layouts, PDA seeds, instruction names and arguments, error codes and `packages/shared` must not change without an explicit human instruction. If you need a change, write it up in `docs/STATUS.md` and stop that line of work.

### Data and the oracle
- Never invent coordinates, fire geometry or dataset hashes. Properties are chosen with `scripts/find-properties.ts` from the real perimeter, with the §8.3 margins.
- A point inside a perimeter **hole** is not inside the footprint (§8.2).
- Evidence JSON is canonical (sorted keys, no whitespace, integers only) and hashed with SHA-256 (§8.4).
- No live government API calls at runtime. Data is packaged in `data/`.

### Frontend
- Never fake a successful transaction. Every displayed trade corresponds to on-chain state.
- Fixtures exist only behind `NEXT_PUBLIC_USE_FIXTURES=1`; production builds must fail with it on.
- Every market page shows: *"Pays the full amount if the final mapped footprint of the fire came within 500 m of this property. Pays on fire proximity, not on damage."*
- Every market is labelled "Historical replay — outcome already known".
- Explorer links use `?cluster=devnet`.

### Secrets
- Keypairs live in `~/.config/metrex/*.json`, never in the repo. Only `.env.example` is committed.
- Never print private keys or secret env values in logs or output.

### Sensitivity
- Home labels are fictional; coordinates are approximate points, not real addresses.
- Never use a real damage-inspection (DINS) record as a demo property. DINS may appear only as aggregate figures.

## Out of scope — do not build

Mainnet, real money, other risk types or fire scenarios, damage-based triggers, partial fills, order-matching engines, AMMs, fungible position tokens, leverage, LLM- or ML-driven trading, decentralized oracles, KYC, mobile apps, governance tokens, a database (use on-chain reads + in-memory cache).

## Gates (see `docs/build-plan.md` §5)

0 Freeze → 1 Core program green → 2 Devnet live → 3 Human lifecycle → 4 Definition of Done (YES and NO on Devnet) → 5 Tier 2 Solana track → 6 Demo-ready.

Tier 2 program code stays on its own branch until Gate 4 is green, its tests pass, and the security review is re-run. Nothing merges while Gate 4 is red.

## Stop and ask a human when

- Devnet SOL, keypairs or a deploy is needed and not already available
- The raw fire perimeter isn't in `data/raw/` and can't be downloaded
- A frozen interface needs to change
- The spec is ambiguous or seems wrong
- A security finding needs a design decision

Record the blocker in `docs/STATUS.md`, then continue with any work that doesn't depend on it.

## Style

- Rust: one file per instruction in `instructions/`; `require!` with named errors; no `unwrap()` in program code.
- TypeScript: strict mode; no `any` in `packages/`; BN/bigint for token amounts, never JS numbers.
- Small commits with messages naming the spec section (`feat(program): accept_offer §6`).
