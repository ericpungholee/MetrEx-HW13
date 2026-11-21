# MetrEx

An on-chain exchange for catastrophe risk on Solana Devnet, built for Hack Western 13 (MLH Best Use of Solana).

Each market asks one binary question: did the final mapped footprint of the January 2025 Palisades Fire come within 500 m of a registered property? YES and NO tokens are minted in pairs against 1 mUSD each and trade in a fully escrowed limit order book with real partial fills. One round closure stops trading on every market of the fire. An oracle settles each market from a dataset whose hash was committed on-chain before trading, and each winning share redeems for 1 mUSD.

YES pays on fire proximity, not on damage. MetrEx is a risk exchange, not insurance. Home labels are fictional and coordinates are approximate points. Everything runs on Devnet with test tokens.

## What's here

| | v2 Exchange (current, at `/`) | v1.1 (frozen fallback, at `/v1`) |
|---|---|---|
| Model | Binary YES/NO SPL tokens and an escrowed order book | Per-offer RFQ underwriting with transferable claim rights |
| Program | `programs/metrex-exchange`, [`BrHisWF8…Fko`](https://explorer.solana.com/address/BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko?cluster=devnet) | `programs/metrex`, [`AHSbJKM2…u8X`](https://explorer.solana.com/address/AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X?cluster=devnet) |
| Gates | V0–V6, all passed | 0–6, all passed |
| Spec | [docs/spec-v2.md](docs/spec-v2.md) | [docs/spec.md](docs/spec.md) |

v2 highlights:

- **Program:** 16 instructions covering split, merge, place, take, match, cancel, sweep, round close, three settlement paths (oracle, emergency invalidation, timeout expiry) and redeem. No floating point, checked `u128` quote math and booked obligations instead of raw balances.
- **Liquidity:** three post-only market-maker bots quote YES and exact NO complements. A keeper matches crossed orders and sweeps after closure.
- **App:** live books, a chart from finalized events, a trade panel that simulates before the wallet signs, a portfolio, round history, a password-protected operator page and browser-side evidence hash verification.
- **Verified:** 145 Anchor tests (78 v1, 67 v2), 198 workspace tests, a full Devnet §13.3 run and a Phantom rehearsal with live closure rejections.

## Layout

```text
programs/metrex-exchange/   v2 Anchor program
programs/metrex/            v1.1 program (frozen)
packages/exchange/          v2 constants, PDAs, quote math, book, planner, chart reducer
packages/geo/               Turf.js trigger evaluation and canonical evidence
packages/server/            RPC, oracle, evidence, faucet, routes
packages/shared/            v1 shared types (frozen)
app/                        Next.js App Router frontend
services/bots/              market makers (v2 in src/v2)
services/indexer/           stats, plus v2 keeper and trade index
scripts/                    Devnet setup, demo prep and proof scripts
tests/                      Anchor tests for both programs
data/                       Palisades perimeter, scenarios, published evidence
docs/                       specs, build plans, status and build logs
```

## Quick start

Requires Anchor 0.32.3, Agave 4.1.2, Node 20+ and pnpm 10. Keypairs live in `~/.config/metrex/` and never in the repo. Copy `.env.example` to `.env` and fill in RPC and keys.

```bash
pnpm install
```

```bash
anchor test
```

```bash
pnpm -r test
```

```bash
pnpm --filter app dev
```

```bash
pnpm --filter bots start:v2
```

```bash
pnpm --filter indexer start:v2
```

`bash scripts/v3-local.sh` runs the whole v2 flow end to end on a disposable local validator with throwaway keys.

## Docs

- [docs/STATUS.md](docs/STATUS.md): current state, Devnet addresses, open items, owner decisions
- [docs/v2-build-log.md](docs/v2-build-log.md): per-gate results for V0–V6
- [docs/v2-devnet-verification.md](docs/v2-devnet-verification.md): the Devnet deployment and §13.3 checks
- [docs/v1-build-log.md](docs/v1-build-log.md): v1.1 history
- [CLAUDE.md](CLAUDE.md) (also `AGENTS.md`): conventions and hard rules for coding agents
