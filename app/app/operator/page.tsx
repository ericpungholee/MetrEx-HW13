"use client";

// Operator (spec-v2 §10.6). Password-protected, never linked from the trading UI. Close and settle
// runs one server step at a time; each step reads the chain first, so the workflow resumes from
// wherever it stopped. Every on-chain step is its own transaction with an Explorer link.
// Multi-peril (docs/spec-multiperil.md §2.2): one round per hazard can be open at once, so the
// operator picks a round and closes and settles it without touching the others.
import { useState } from "react";
import Link from "next/link";
import { HAZARD_LABEL, catalogByScenario } from "@metrex/exchange";
import { fetchFeatured, fetchHealth, fetchLatestRound, fetchMarketInfo, fetchRound, operatorStep, USE_FIXTURES, type OperatorAction, type RoundInfo, type RoundWithMarkets } from "@/lib/exchange-client";
import { marketState, marketTitle } from "@/lib/exchange-format";
import { usePoll } from "@/lib/usePoll";
import { PageHeader, Panel, Stat } from "@/components/ui";
import { StateLabel, Unavailable } from "@/components/exchange/Labels";

interface LogLine {
  action: OperatorAction;
  ok: boolean;
  text: string;
  links: { label: string; href: string }[];
}

type Body = Record<string, unknown>;

function describe(action: OperatorAction, ok: boolean, body: Body): LogLine {
  if (!ok) return { action, ok, text: String(body.error ?? "Step failed"), links: [] };
  if (action === "reject") {
    if (body.rejected === null) {
      return { action, ok: true, text: "Round closure is finalized. Skipped the trade simulation because all resting orders are gone.", links: [] };
    }
    if (body.rejected === true && body.roundNotOpen === true) {
      return { action, ok: true, text: "Verified that the program rejects trades after closure.", links: [] };
    }
    const text = body.rejected === false
      ? "A trade still simulated successfully. Do not settle yet."
      : `Closure proof failed. ${String(body.error ?? "Retry the trade simulation.")}`;
    return { action, ok: false, text, links: [] };
  }
  if (action === "status") {
    return {
      action,
      ok: body.complete === true,
      text: `${String(body.resolvedCount)}/${String(body.marketCount)} markets resolved; ${((body.markets as Body[]) ?? []).reduce((a, m) => a + Number(m.orders ?? 0), 0)} orders remain${body.complete === true ? ". Complete." : "."}`,
      links: [],
    };
  }
  const steps = (body.steps as Body[]) ?? [];
  return {
    action,
    ok: true,
    text: steps.length ? steps.map((s) => `${String(s.step)} ${String(s.target).slice(0, 8)}…${s.note ? ` (${String(s.note)})` : ""}`).join(" · ") : "Nothing to do.",
    links: steps.filter((s) => typeof s.explorer === "string").map((s) => ({ label: `${String(s.step)} ${String(s.target).slice(0, 6)}`, href: String(s.explorer) })),
  };
}

const LABELS: Record<OperatorAction, string> = {
  close: "Close trading",
  reject: "Verify closure",
  resolve: "Resolve markets",
  sweep: "Sweep orders",
  status: "Check settlement",
};

const ROUNDS_BACK = 8n;

async function fetchRecentRounds(): Promise<RoundWithMarkets[]> {
  const latest = await fetchLatestRound();
  if (!latest) return [];
  const ids: bigint[] = [];
  for (let id = latest.roundId - 1n; id >= 0n && id > latest.roundId - ROUNDS_BACK; id--) ids.push(id);
  const older = await Promise.all(ids.map((id) => fetchRound(id)));
  return [latest, ...older.filter((r): r is RoundWithMarkets => r !== null)];
}

const hazardOf = (r: Pick<RoundInfo, "scenarioId">): string => {
  const c = catalogByScenario(r.scenarioId);
  return c ? HAZARD_LABEL[c.hazard] : `Scenario ${r.scenarioId}`;
};

export default function OperatorPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<OperatorAction | "all" | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const featured = usePoll(fetchFeatured, [], 5_000);
  const history = usePoll(() => showHistory ? fetchRecentRounds() : Promise.resolve(null), [showHistory], 20_000);
  const health = usePoll(() => fetchHealth(), [], 10_000);
  const current = (featured.data ?? []).flatMap(({ round, market }) => round && market ? [{
    ...round, scenarioId: market.scenarioId, market: market.address, resolved: market.outcome !== "unresolved",
  }] : []);
  const older = (history.data ?? []).filter((r) => !current.some((c) => c.address === r.address));
  const selectedCatalog = current.find((c) => c.address === picked)
    ?? (picked === null ? current.find((c) => !c.resolved) ?? current[0] : undefined);
  const selectedHistory = older.find((r) => r.address === picked);
  const selectedAddress = selectedCatalog?.address ?? selectedHistory?.address;
  const selectedMarket = selectedCatalog?.market;
  const details = usePoll(async () => {
    if (!selectedAddress) return null;
    if (selectedMarket) {
      const info = await fetchMarketInfo(selectedMarket);
      if (info?.round.address === selectedAddress && info.round.marketCount === 1) return { ...info.round, markets: [info.market] };
    }
    return fetchRound(selectedAddress);
  }, [selectedAddress, selectedMarket], 12_000);
  const r = !details.error && details.data?.address === selectedAddress ? details.data ?? null : null;

  async function step(action: OperatorAction): Promise<boolean> {
    if (!r) return false;
    const res = await operatorStep(action, password, r.address);
    const line = describe(action, res.ok, res.body);
    setLog((l) => [...l, { ...line, text: `Round #${r.roundId.toString()}: ${line.text}` }]);
    featured.refresh();
    details.refresh();
    if (showHistory) history.refresh();
    return res.ok && (action !== "reject" || line.ok);
  }

  async function runOne(action: OperatorAction) {
    setBusy(action);
    try {
      await step(action);
    } catch (e) {
      setLog((l) => [...l, { action, ok: false, text: (e as Error).message, links: [] }]);
    } finally {
      setBusy(null);
    }
  }

  async function runAll() {
    setBusy("all");
    try {
      for (const a of ["close", "reject", "resolve", "sweep", "status"] as OperatorAction[]) {
        if (!(await step(a))) break;
      }
    } catch (e) {
      setLog((l) => [...l, { action: "status", ok: false, text: (e as Error).message, links: [] }]);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Operator" description="Select a hazard round to manage its trading and settlement." />

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-line p-4 sm:grid-cols-4">
        <Stat label="Devnet RPC">{health.data ? (health.data.rpc.ok ? "Connected" : "Unavailable") : "—"}</Stat>
        <Stat label="Bots">{health.data ? (health.data.botsAlive ? "running" : "no heartbeat") : "—"}</Stat>
        <Stat label="Keeper">{health.data ? (health.data.keeperAlive ? "running" : "no heartbeat") : "—"}</Stat>
        <Stat label="Matching">{health.data?.matching ?? "—"}</Stat>
      </div>

      <Panel title="Catalog rounds">
        {current.length === 0 ? (
          featured.error ? <Unavailable>{featured.error}</Unavailable> : <div className="text-sm text-dim">{featured.loading ? "Loading rounds…" : "No rounds yet."}</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {current.map((x) => (
              <button
                key={x.address}
                type="button"
                aria-pressed={x.address === selectedAddress}
                className={`flex items-center justify-between gap-3 rounded-md border p-3 text-left text-sm ${x.address === selectedAddress ? "border-ink bg-bg-soft" : "border-line hover:bg-bg-soft"}`}
                disabled={busy !== null}
                onClick={() => setPicked(x.address)}
              >
                <span className="min-w-0">
                  <span className="block font-medium">{hazardOf(x)} · Round #{x.roundId.toString()}</span>
                  <span className="text-xs text-dim">{x.label}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-dim">
                  <span className={x.state === "open" ? "block text-up" : "block"}>
                    {x.state === "open" ? "Trading open" : "Trading closed"}
                  </span>
                  {x.resolved ? "Catalog market settled" : "Awaiting settlement"}
                </span>
              </button>
            ))}
          </div>
        )}
        <details className="mt-3 text-sm" onToggle={(e) => setShowHistory(e.currentTarget.open)}>
          <summary className="cursor-pointer text-dim">Earlier rounds</summary>
          {showHistory && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {older.map((x) => (
                <button key={x.address} type="button" className="btn btn-sm justify-start" aria-pressed={x.address === selectedAddress} disabled={busy !== null} onClick={() => setPicked(x.address)}>
                  {hazardOf(x)} · Round #{x.roundId.toString()} · {x.resolvedCount}/{x.marketCount} settled
                </button>
              ))}
              {history.error && <Unavailable>{history.error}</Unavailable>}
              {!history.error && !older.length && <p className="text-xs text-dim">{history.data ? "No earlier rounds." : "Loading earlier rounds…"}</p>}
            </div>
          )}
        </details>
      </Panel>

      <Panel
        title={r ? `${hazardOf(r)} markets` : "Markets"}
      >
        {!r ? (
          <div className="text-sm text-dim">{details.error ?? (selectedAddress ? "Loading selected round…" : "No round selected.")}</div>
        ) : (
          <div className="divide-y divide-line">
            {r.markets.map((m) => (
              <div key={m.address} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <Link href={`/market/${m.address}`} className="font-medium hover:underline">{marketTitle(m)}</Link>
                <div className="flex items-center gap-3">
                  <StateLabel state={marketState(m.outcome, r)} />
                  {(m.outcome === "yes" || m.outcome === "no") && (
                    <Link href={`/market/${m.address}#settlement`} className="text-xs underline underline-offset-2">Evidence</Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={r ? `Close and settle round #${r.roundId.toString()} (${hazardOf(r)} only)` : "Close and settle"}>
        <div className="space-y-5 rounded-lg border border-line p-4">
          <label className="block max-w-sm">
            <span className="text-xs font-medium tracking-wide text-faint uppercase">Operator password</span>
            <input className="input mt-1 w-full" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-3">
            <button className="btn btn-primary" disabled={!password || !r || busy !== null || USE_FIXTURES} onClick={runAll}>
              {busy === "all" ? "Running…" : "Close and settle"}
            </button>
            {(["close", "reject", "resolve", "sweep", "status"] as OperatorAction[]).map((a) => (
              <button key={a} className="btn btn-sm" disabled={!password || !r || busy !== null || USE_FIXTURES} onClick={() => runOne(a)}>
                {busy === a ? "…" : LABELS[a]}
              </button>
            ))}
          </div>
          {log.length > 0 && (
            <ol aria-live="polite" className="space-y-2 text-sm">
              {log.map((l, i) => (
                <li key={i} className={`border-l-2 pl-3 ${l.ok ? "border-up" : "border-down"}`}>
                  <div className="font-medium text-ink">{LABELS[l.action]}</div>
                  <div className={l.ok ? "text-ink-secondary" : "text-down"}>{l.text}</div>
                  {l.links.map((x) => (
                    <a key={x.href} className="mr-3 text-xs text-info hover:underline" href={x.href} target="_blank" rel="noreferrer">
                      {x.label} on Explorer
                    </a>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Panel>
    </div>
  );
}
