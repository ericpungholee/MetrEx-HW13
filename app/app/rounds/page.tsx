"use client";

// Rounds (spec-v2 §10.2): earlier rounds appear only here, with their outcomes labelled.
import Link from "next/link";
import { fetchLatestRound, fetchRound, type RoundWithMarkets } from "@/lib/exchange-client";
import { marketState, marketTitle } from "@/lib/exchange-format";
import { formatUnix } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { PageHeader, Panel } from "@/components/ui";
import { ReplayDisclosure, StateLabel, Unavailable } from "@/components/exchange/Labels";

const SHOW = 10n;

export default function RoundsPage() {
  const rounds = usePoll(
    async () => {
      const latest = await fetchLatestRound();
      if (!latest) return [];
      const ids: bigint[] = [];
      for (let id = latest.roundId - 1n; id >= 0n && id > latest.roundId - SHOW; id--) ids.push(id);
      const older = await Promise.all(ids.map((id) => fetchRound(id)));
      return [latest, ...older.filter((r): r is RoundWithMarkets => r !== null)];
    },
    [],
    15_000,
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Rounds" description={<ReplayDisclosure />} />
      {!rounds.data ? (
        rounds.error ? <Unavailable>Rounds unavailable: {rounds.error}</Unavailable> : <div className="h-64 animate-pulse bg-bg-soft" />
      ) : rounds.data.length === 0 ? (
        <div className="text-sm text-dim">No rounds yet.</div>
      ) : (
        rounds.data.map((r, i) => (
          <Panel
            key={r.address}
            title={`Round #${r.roundId.toString()} · ${r.label}${i === 0 ? " · latest" : ""}`}
            right={r.state === "open" ? `trading until ${formatUnix(r.tradingEndsAt)}` : `closed ${formatUnix(r.closedAt)} · ${r.resolvedCount}/${r.marketCount} settled`}
          >
            <div className="divide-y divide-line">
              {r.markets.map((m) => (
                <Link key={m.address} href={`/market/${m.address}`} className="flex items-center justify-between py-3 text-sm hover:bg-bg-soft">
                  <span className="font-medium text-ink">{marketTitle(m)}</span>
                  <StateLabel state={marketState(m.outcome, r)} />
                </Link>
              ))}
            </div>
          </Panel>
        ))
      )}
    </div>
  );
}
