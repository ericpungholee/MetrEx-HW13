"use client";

// Network panel (spec §10.5): program tx counts and fees from GET /api/stats (backend),
// plus the median send→confirm latency of this browser's own transactions.
import { fetchNetworkStats, getLatencies, medianLatencyMs, USE_FIXTURES } from "@/lib/client";
import { usePoll } from "@/lib/usePoll";

export function NetworkPanel() {
  const stats = usePoll(fetchNetworkStats, [], 5_000);
  const latency = usePoll(async () => ({ median: medianLatencyMs(), n: getLatencies().length }), [], 1_000);
  const s = stats.data;
  const unavailable = !stats.loading && !s;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded border border-line bg-panel px-4 py-2">
      <div className="text-[10px] font-bold tracking-widest text-faint uppercase">Network · Solana Devnet</div>
      <Metric label={s?.truncated ? "Program txs (indexed)" : "Program txs (total)"} value={s?.txTotal?.toLocaleString("en-US")} unavailable={unavailable} />
      <Metric label="Program txs (last 10 min)" value={s?.txLast10Min?.toLocaleString("en-US")} unavailable={unavailable} />
      <Metric
        label={s?.feesPending || s?.truncated ? "Indexed network fees" : "Total network fees"}
        value={s?.feesSol != null ? `${s.feesSol} SOL` : undefined}
        unavailable={unavailable}
      />
      <Metric
        label="Median latency, your txs"
        value={latency.data?.median != null ? `${(latency.data.median / 1000).toFixed(2)} s (n=${latency.data.n})` : "no txs yet"}
      />
      {unavailable && (
        <span className="text-[11px] text-faint">{USE_FIXTURES ? "stats unavailable in fixture mode" : "stats unavailable"}</span>
      )}
      {s?.stale && <span className="text-[11px] text-faint">Showing cached network stats</span>}
    </div>
  );
}

function Metric({ label, value, unavailable }: { label: string; value: string | undefined; unavailable?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-faint uppercase">{label}</div>
      <div className="num text-sm">{value ?? (unavailable ? "—" : "…")}</div>
    </div>
  );
}
