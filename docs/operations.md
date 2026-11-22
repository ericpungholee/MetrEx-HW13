# Exchange operations

## Start and restart

1. Copy `app/.env.example` to `app/.env.local`. Configure a Devnet RPC and backup URL, the operator password and the public app origin. The browser defaults to the same-origin RPC proxy. Keep RPC credentials server-side.
2. Put `scenarios.json`, `palisades-2025.geojson`, `atlantic-hurricanes-2017-09.geojson`, `south-napa-2014-08.json` and `central-iowa-tornadoes-2024-05.geojson` in the private oracle directory. Use the committed normalized data. The server checks its SHA-256 against each round before use.
3. On the funded presentation deployment, run the command below. The default local port is 3015. Ctrl-C stops the app and workers cleanly. On restart, open rounds keep their addresses, balances, order history and deadlines.
4. Wait for readiness, then open the app. `GET /api/health` reports RPC, the simulator, maker and keeper/indexer heartbeats, and matching. It lists aggregate depth in YES bid, YES ask, NO bid and NO ask order. Maker `free_*` and `committed_*` values are in mUSD base units. The launcher checks on-chain depth and reports thin markets.

```bash
METREX_ORACLE_DATA_DIR="$HOME/.config/metrex/oracle-data" \
  METREX_SIM=1 SIM_TRADERS=100 SIM_RATE=2.5 SIM_MAX_IN_FLIGHT=4 \
  BOTS_POLL_MS=2500 KEEPER_POLL_MS=3000 pnpm demo
```

The launcher starts workers without the private oracle directory or operator password. A host-local lease per program and signer identity prevents overlapping instances, and the OS releases it on exit. Keep one operational host per identity. A process on another host with the same signer can still transact. If unknown signer activity recurs, retain the receipts and coordinate rotation with the owner.

For standalone workers, export the server-side RPC configuration and run `pnpm --filter bots start` and `pnpm --filter indexer start`. Give the app and workers the same `METREX_HEARTBEAT_DIR` when launching them separately. Shutdown and restart can leave legitimate fills or cancels in flight. The on-chain book and account balances are authoritative when each worker resumes.

Keep the `trades-<program>-v1.jsonl` file in that directory across restarts. The keeper/indexer writes the finalized receipts and paging checkpoints. The app reads the same file without requesting trade-history RPC data. Use a dedicated directory per cluster. The keeper heartbeat reports its last index refresh, streamed receipts, receipts fetched via HTTP, pending receipts and backfill status. A cold start shows verified trades and indexed volume as they arrive. The complete quote history and settlement ledger appear after backfill.

## Funding and replay preparation

Use the app’s Devnet faucet when the connected wallet has low funds. It requests SOL and mint units from the exchange Config’s mUSD mint. The faucet enforces wallet and process rate limits. Use the existing Devnet funding utilities for operator and bot accounts.

```bash
node --env-file=app/.env.local --import tsx scripts/fund-bots.ts --dry-run
node --env-file=app/.env.local --import tsx scripts/fund-operators.ts --dry-run
node --env-file=app/.env.local --import tsx scripts/fund-wallet.ts <wallet-address> --dry-run
```

Remove `--dry-run` when funding is authorized. `fund-bots.ts` seeds unused maker mUSD accounts once from `MAKER_CAPITAL` and restores maker SOL when below two thirds of the configured float. Existing mUSD account history, including the original V7 seed, causes the seed to be skipped regardless of the free balance. The script funds only the three configured makers. Operators and explicitly selected demo wallets use their respective commands.

Normal startup keeps active markets and advances expired rounds. For intentional replay rotation, run `pnpm demo --new-round` with the existing supervisor stopped and the oracle environment set. To replace a retired property’s open replay, use `--replace-retired`. A normal restart never uses participant activity as a reason to rotate.

## Close, verify, resolve, sweep

Select a specific round in `/operator`. Close trading first. The operator places a round-specific hold so the local workers preserve resting orders for the closure proof. Verify closure submits a real Devnet take, waits for a finalized `RoundNotOpen` receipt and checks transaction balance changes. A verified receipt releases the hold and sweeping resumes. An abandoned hold expires after ten minutes. Anyone can still sweep on-chain when the program permits it, so preserve the test order through the local flow and use its receipt to verify the actual outcome.

Resolve uses the pinned data during the resolution window. Missing coverage leaves the market unresolved. Admin and oracle can jointly invalidate, and expiry is permissionless after the timeout. Settled YES and NO markets publish evidence that matches the finalized on-chain commitment. Invalid markets have no settlement overlay.

For redemption, the app combines sweeps and burns when the transaction fits. Larger claims confirm sweep batches, re-read exact token balances, then build a separate burn. Resume by using **Redeem** again. The app refreshes chain state and shows receipts for confirmed batches even if a later prompt is declined. Successful burns consume the shares, so an already-paid position cannot be redeemed again.

## Legacy recovery

The RFQ app and web routes are retired from the active runtime. The frozen v1.1 program and on-chain claims are preserved at [the original program address](https://explorer.solana.com/address/AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X?cluster=devnet). The `v1.1-demo` tag preserves the old frontend. Commit `b3f507a` preserves the last code and documentation for the historical `/v1` recovery UI and services.

For a historical claim, use an isolated checkout of `b3f507a`, its original compatible configuration and a separate local port. Follow [the v1 recovery steps](v1.1-devnet-verification.md). The claim holder signs with their own wallet. This recovery path needs no program upgrade or account migration. The current test suite keeps the legacy buyer client and its regressions in `legacy/v1`.
