#!/usr/bin/env bash
# Gate V3 acceptance run on a disposable local validator (build-plan-v2 §5 V3).
# Uses throwaway keys in a temp dir: never reads or writes ~/.config/metrex.
#   bash scripts/v3-local.sh            # WORK=<dir> to keep the logs and ledger somewhere specific
# Requires: anchor build (target/deploy/metrex_exchange.so), solana-test-validator on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

WORK="${WORK:-$(mktemp -d -t metrex-v3)}"
mkdir -p "$WORK/keys" "$WORK/hb" "$WORK/oracle-data" "$WORK/logs"
echo "work dir: $WORK"
PROGRAM_ID=BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko
PORT="${PORT:-8899}"

export METREX_KEY_DIR="$WORK/keys"
export METREX_HEARTBEAT_DIR="$WORK/hb"
export RPC_URL="http://127.0.0.1:$PORT"
unset RPC_URL_BACKUP METREX_ORACLE_DATA_DIR MUSD_MINT || true
# Settlement data lives only in the oracle's directory; only the oracle steps get this variable.
ORACLE_ENV=(env "METREX_ORACLE_DATA_DIR=$WORK/oracle-data")
cp data/scenarios.json data/palisades-2025.geojson "$WORK/oracle-data/"

for k in admin oracle controller deployer mint-authority faucet bot-a bot-b bot-c homeowner-demo judge-1 judge-2 judge-3 keeper; do
  [ -f "$WORK/keys/$k.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/keys/$k.json" >/dev/null
done
ADMIN=$(solana-keygen pubkey "$WORK/keys/admin.json")

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

solana-test-validator --reset --quiet --ledger "$WORK/ledger" --rpc-port "$PORT" \
  --upgradeable-program "$PROGRAM_ID" target/deploy/metrex_exchange.so "$ADMIN" >"$WORK/logs/validator.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do solana -u "$RPC_URL" cluster-version >/dev/null 2>&1 && break; sleep 1; done
for k in admin deployer; do solana -u "$RPC_URL" airdrop 100 "$WORK/keys/$k.json" >/dev/null; done

step() { echo; echo "######## $*"; }
step "setup-devnet-v2 --local"
pnpm -s tsx scripts/setup-devnet-v2.ts --local --create-mint --timeout 120
step "fund-bots"
pnpm -s tsx scripts/fund-bots.ts
step "start v2 bots and keeper"
pnpm -s --filter bots start:v2 >"$WORK/logs/bots.log" 2>&1 &
PIDS+=($!)
pnpm -s --filter indexer start:v2 >"$WORK/logs/keeper.log" 2>&1 &
KEEPER=$!
PIDS+=($KEEPER)
sleep 3

step "prepare-demo-v2 #1 (fresh round; bots must quote within 10 s)"
"${ORACLE_ENV[@]}" pnpm -s tsx scripts/prepare-demo-v2.ts --local --wait 10
step "prove: demo"
pnpm -s tsx scripts/prove-v3-local.ts --phase demo

step "stop the keeper; reads must keep working"
kill "$KEEPER"; wait "$KEEPER" 2>/dev/null || true
sleep 22
pnpm -s tsx scripts/prove-v3-local.ts --phase reads
pnpm -s --filter indexer start:v2 >>"$WORK/logs/keeper.log" 2>&1 &
PIDS+=($!)
sleep 3

step "prepare-demo-v2 #2 (stale round: close, resolve, sweep, then a fresh round)"
"${ORACLE_ENV[@]}" pnpm -s tsx scripts/prepare-demo-v2.ts --local --wait 30
step "prove: settled"
"${ORACLE_ENV[@]}" pnpm -s tsx scripts/prove-v3-local.ts --phase settled

step "bot and keeper failures (expected: races only)"
grep -c "failed" "$WORK/logs/bots.log" || true
grep -c "failed" "$WORK/logs/keeper.log" || true
echo
echo "V3 LOCAL ACCEPTANCE: PASS (logs in $WORK/logs)"
