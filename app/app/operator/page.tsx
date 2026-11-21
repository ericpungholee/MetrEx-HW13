"use client";

// Operator (spec-v2 §10.6). Password-protected, never linked from the trading UI. Close and settle
// runs one server step at a time; each step reads the chain first, so the workflow resumes from
// wherever it stopped. Every on-chain step is its own transaction with an Explorer link.
import { useState } from "react";
import { fetchHealth, fetchLatestRound, operatorStep, USE_FIXTURES, type OperatorAction } from "@/lib/exchange-client";
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

export default function OperatorPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<OperatorAction | "all" | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const round = usePoll(() => fetchLatestRound(), [], 5_000);
  const health = usePoll(() => fetchHealth(), [], 10_000);

  async function step(action: OperatorAction): Promise<boolean> {
    const res = await operatorStep(action, password, round.data?.address);
    const line = describe(action, res.ok, res.body);
    setLog((l) => [...l, line]);
    round.refresh();
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

  const r = round.data;
  return (
    <div className="space-y-10">
      <PageHeader title="Operator" description="Round inspection, bot and keeper health, and the Close and settle workflow. Keys stay on the server." />

      <div className="grid gap-6 sm:grid-cols-4">
        <Stat label="RPC">{health.data ? (health.data.rpc.ok ? `ok · slot ${health.data.rpc.slot}` : "down") : "—"}</Stat>
        <Stat label="Bots">{health.data ? (health.data.botsAlive ? "running" : "no heartbeat") : "—"}</Stat>
        <Stat label="Keeper">{health.data ? (health.data.keeperAlive ? "running" : "no heartbeat") : "—"}</Stat>
        <Stat label="Matching">{health.data?.matching ?? "—"}</Stat>
      </div>

      <Panel title={r ? `Latest round #${r.roundId.toString()} · ${r.label}` : "Latest round"} right={r ? `${r.state} · ${r.resolvedCount}/${r.marketCount} settled` : undefined}>
        {!r ? (
          round.error ? <Unavailable>{round.error}</Unavailable> : <div className="text-sm text-dim">No round yet.</div>
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

      <Panel title="Close and settle">
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
