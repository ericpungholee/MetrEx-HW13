"use client";

// Spec §10.5: compact network strip — program txs, fees, median latency.
import { fetchNetworkStats, getLatencies, medianLatencyMs, USE_FIXTURES } from "@/lib/client";
import { usePoll } from "@/lib/usePoll";

export function NetworkPanel() {
  const stats = usePoll(fetchNetworkStats, [], 5_000);
  const latency = usePoll(async () => ({ median: medianLatencyMs(), n: getLatencies().length }), [], 1_000);
  const s = stats.data;
  const unavailable = !stats.loading && !s;

  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-b border-line pb-4 text-sm">
      <span className="text-xs font-medium tracking-wide text-faint uppercase">Network</span>
      <Metric label="Transactions" value={s?.txTotal?.toLocaleString("en-US")} unavailable={unavailable} />
      <Metric label="Last 10 min" value={s?.txLast10Min?.toLocaleString("en-US")} unavailable={unavailable} />
      <Metric
        label="Fees"
        value={s?.feesSol != null ? `${s.feesSol} SOL` : undefined}
        unavailable={unavailable}
      />
      <Metric
        label="Your latency"
        value={latency.data?.median != null ? `${(latency.data.median / 1000).toFixed(2)}s` : "—"}
      />
      {unavailable && (
        <span className="text-xs text-faint">{USE_FIXTURES ? "Unavailable in fixture mode" : "Unavailable"}</span>
      )}
      {s?.stale && <span className="text-xs text-faint">Cached</span>}
    </div>
  );
}

function Metric({ label, value, unavailable }: { label: string; value: string | undefined; unavailable?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-dim">{label}</span>
      <span className="num font-medium text-ink">{value ?? (unavailable ? "—" : "…")}</span>
    </div>
  );
}
