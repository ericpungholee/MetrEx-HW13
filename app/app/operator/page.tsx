"use client";

// Operator (spec-v2 §10.6). Password-protected, never linked from the trading UI. Close and settle
// runs one server step at a time; each step reads the chain first, so the workflow resumes from
// wherever it stopped. Every on-chain step is its own transaction with an Explorer link.
// Multi-peril (docs/spec-multiperil.md §2.2): one round per hazard can be open at once, so the
// operator picks a round and closes and settles it without touching the others.
import { useState } from "react";
import { HAZARD_LABEL, catalogByScenario } from "@metrex/exchange";
import { fetchHealth, fetchLatestRound, fetchRound, operatorStep, USE_FIXTURES, type OperatorAction, type RoundWithMarkets } from "@/lib/exchange-client";
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
      return { action, ok: true, text: `RoundNotOpen verified on property ${String(body.propertyId)}.`, links: [] };
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
  close: "1. close_round (finalized)",
  reject: "2. Show a trade is rejected",
  resolve: "3–4. Oracle resolution and evidence",
  sweep: "5. Sweep remaining orders",
  status: "6. Completeness check",
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

const hazardOf = (r: RoundWithMarkets): string => {
  const c = catalogByScenario(r.scenarioId);
  return c ? HAZARD_LABEL[c.hazard] : `Scenario ${r.scenarioId}`;
};

export default function OperatorPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<OperatorAction | "all" | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const rounds = usePoll(() => fetchRecentRounds(), [], 5_000);
  const health = usePoll(() => fetchHealth(), [], 10_000);
  const all = rounds.data ?? [];
  // Default: the newest round that still needs work, else the newest round.
  const r = all.find((x) => x.address === picked) ?? all.find((x) => x.state === "open" || x.resolvedCount < x.marketCount) ?? all[0] ?? null;

  async function step(action: OperatorAction): Promise<boolean> {
    if (!r) return false;
    const res = await operatorStep(action, password, r.address);
    const line = describe(action, res.ok, res.body);
    setLog((l) => [...l, { ...line, text: `Round #${r.roundId.toString()}: ${line.text}` }]);
    rounds.refresh();
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
    <div className="space-y-10">
      <PageHeader title="Operator" description="Round inspection, bot and keeper health, and the Close and settle workflow. Keys stay on the server." />

      <div className="grid gap-6 sm:grid-cols-4">
        <Stat label="RPC">{health.data ? (health.data.rpc.ok ? `ok · slot ${health.data.rpc.slot}` : "down") : "—"}</Stat>
        <Stat label="Bots">{health.data ? (health.data.botsAlive ? "running" : "no heartbeat") : "—"}</Stat>
        <Stat label="Keeper">{health.data ? (health.data.keeperAlive ? "running" : "no heartbeat") : "—"}</Stat>
        <Stat label="Matching">{health.data?.matching ?? "—"}</Stat>
      </div>

      <Panel title="Recent rounds" right="one Open round per hazard is operator policy, not a program rule">
        {all.length === 0 ? (
          rounds.error ? <Unavailable>{rounds.error}</Unavailable> : <div className="text-sm text-dim">No round yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-faint">
              <tr>
                <th className="pb-2 font-medium">Round</th>
                <th className="pb-2 font-medium">Hazard</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 text-right font-medium">Settled</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {all.map((x) => (
                <tr key={x.address} className={`border-t border-line ${x.address === r?.address ? "bg-bg-soft" : ""}`}>
                  <td className="py-2.5">
                    <span className="font-medium">#{x.roundId.toString()}</span> <span className="text-dim">{x.label}</span>
                  </td>
                  <td className="py-2.5">{hazardOf(x)}</td>
                  <td className="py-2.5">{x.state}</td>
                  <td className="num py-2.5 text-right">
                    {x.resolvedCount}/{x.marketCount}
                  </td>
                  <td className="py-2.5 text-right">
                    <button className="btn btn-sm" disabled={busy !== null || x.address === r?.address} onClick={() => setPicked(x.address)}>
                      {x.address === r?.address ? "Selected" : "Select"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title={r ? `Round #${r.roundId.toString()} · ${hazardOf(r)} · ${r.label}` : "Round"}
        right={r ? `${r.state} · ${r.resolvedCount}/${r.marketCount} settled` : undefined}
      >
        {!r ? (
          <div className="text-sm text-dim">No round selected.</div>
        ) : (
          <div className="divide-y divide-line">
            {r.markets.map((m) => (
              <div key={m.address} className="flex items-center justify-between py-3 text-sm">
                <span>
                  <span className="font-medium">{marketTitle(m)}</span> <span className="num text-faint">{m.address.slice(0, 8)}…</span>
                </span>
                <StateLabel state={marketState(m.outcome, r)} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={r ? `Close and settle round #${r.roundId.toString()} (${hazardOf(r)} only)` : "Close and settle"}>
        <div className="space-y-5">
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
            <ol className="space-y-2 text-sm">
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
