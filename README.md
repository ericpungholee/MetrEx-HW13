# MetrEx

MetrEx is a Solana Devnet exchange for historical catastrophe-risk replays, built at Hack Western 13. Four property markets cover the Palisades Fire, September 2017 Atlantic hurricanes, the South Napa earthquake and surveyed May 2024 central Iowa tornadoes. Each market has its own order book, outcome mints, collateral vault and settlement.

Splitting 1 mUSD creates one YES share and one NO share. A winning share pays exactly 1 mUSD. An Invalid share pays 0.50 mUSD. Users can buy a potential payout by entering a dollar amount, or trade individual shares on the exchange. The ticket prices the executable quantity from resting orders. Price increments are 0.01¢ per share.

The coverage period identifies historical source data. The program enforces each replay’s separate Devnet trading deadline. All tokens are for Devnet testing.

## Run the demo

Use Node 24, pnpm 10, Anchor 0.32.3 and Agave 4.1.2. Set the server configuration from [app/.env.example](app/.env.example) in `app/.env.local`. Keep signing keys under `~/.config/metrex/` and copy the registry and pinned datasets to the private oracle directory.

```bash
pnpm install --frozen-lockfile
METREX_ORACLE_DATA_DIR="$HOME/.config/metrex/oracle-data" pnpm demo
```

The launcher verifies Devnet, configuration and service balances, reuses open rounds, creates missing rounds, and starts the market makers, keeper, indexer and production app. Open [the local exchange](http://127.0.0.1:3015/) after the readiness message. `/operator` requires the operator password for lifecycle actions. See the [operations guide](docs/operations.md) for funding, restart, settlement and recovery.

## Verification

```bash
anchor test
pnpm test:ts
pnpm lint:ts
cargo clippy --workspace --all-targets -- -D warnings
pnpm --filter app build
pnpm tsx scripts/normalize-perimeter.ts
pnpm tsx scripts/normalize-hazards.ts --check
pnpm tsx scripts/find-real-properties.ts
bash scripts/v3-local.sh
```

[Status and Devnet addresses](docs/STATUS.md) · [Verification receipts](docs/multiperil-verification.md) · [Exchange contract specification](docs/spec-v2.md) · [Multi-peril replay rules](docs/spec-multiperil.md) · [Data sources](data/DATASET-hazards.md)

The current exchange runs at `/`. For outstanding RFQ claims on the historical v1.1 program, see [legacy recovery](docs/operations.md#legacy-recovery).
