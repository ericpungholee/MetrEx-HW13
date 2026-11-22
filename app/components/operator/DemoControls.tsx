"use client";

// Operator demo controls (docs/spec-simulation.md §9). Pause or resume the simulated traders,
// reset the whole demo, follow a running operation and resume one that stopped. Every action needs
// the operator password; buttons stay disabled while any operation is running.
import { useState } from "react";
import { demoAction, type DemoAction, type DemoStatus } from "@/lib/exchange-client";
import { explorerTx, formatMusd } from "@/lib/format";
import { Panel, Stat } from "@/components/ui";

const PHASES: Record<string, string> = {
  start: "Starting",
  hold: "Holding simulated traders and makers",
  settle: "Settling through the oracle",
  redeem: "Redeeming simulated and maker positions",
  capital: "Restoring seeded capital",
  sol: "Restoring SOL floats",
  open: "Opening fresh markets",
  done: "Complete",
};

const formatSol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(3);
const ago = (ms: number | null) => (ms === null ? "never" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);

export function DemoControls({ password, status, onChange }: { password: string; status: DemoStatus | null; onChange: () => void }) {
  const [busy, setBusy] = useState<DemoAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const op = status?.operation ?? null;
  const opActive = op !== null && !op.completed && (op.running || !op.failed);
  const disabled = !password || busy !== null || !status || (op?.running ?? false);

  async function act(action: DemoAction, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    setError(null);
    try {
      const res = await demoAction(action, password, undefined);
      if (!res.ok) setError(String(res.body.error ?? `Failed (${res.status})`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      onChange();
    }
  }

  const sim = status?.workers.sim;
  const simState = !sim?.alive ? "Not running" : status?.fullResetHeld ? "Held for reset" : status?.simulationPaused ? "Paused" : "Trading";
  const funding = status && !("error" in status.funding) ? status.funding : null;
  const low = funding?.wallets.filter((w) => w.low) ?? [];

  return (
    <Panel title="Demo">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Simulated traders">{simState}{sim?.status?.traders ? ` · ${String(sim.status.traders)}` : ""}</Stat>
          <Stat label="Sim fills / min">{sim?.alive ? String(sim.status?.fillsLastMinute ?? 0) : "—"}</Stat>
          <Stat label="Sim tx sent / failed">{sim?.status ? `${String(sim.status.sent ?? 0)} / ${String(sim.status.failed ?? 0)}` : "—"}</Stat>
          <Stat label="Makers">{status?.workers.bots.alive ? String(status.workers.bots.status?.state ?? "running") : `stale (${ago(status?.workers.bots.ageMs ?? null)})`}</Stat>
          <Stat label="Keeper">{status?.workers.keeper.alive ? "running" : `stale (${ago(status?.workers.keeper.ageMs ?? null)})`}</Stat>
          <Stat label="Funding">{funding ? (low.length ? `Low: ${low.map((w) => w.name).join(", ")}` : "OK") : "—"}</Stat>
        </div>
        {sim?.status?.lastError && <p className="text-xs text-dim">Last simulator error: {String(sim.status.lastError).slice(0, 200)}</p>}

        <div className="flex flex-wrap gap-3">
          {status?.simulationPaused ? (
            <button className="btn btn-primary" disabled={disabled} onClick={() => act("resume_sim")}>{busy === "resume_sim" ? "Starting…" : "Start simulation"}</button>
          ) : (
            <button className="btn" disabled={disabled} onClick={() => act("pause_sim")}>{busy === "pause_sim" ? "Pausing…" : "Pause simulation"}</button>
          )}
          <button
            className="btn"
            disabled={disabled || opActive}
            onClick={() => act("reset_demo", "Reset the demo? Every current catalog round is settled by the oracle and archived, simulated traders and makers are restored to their seeded capital, and four fresh 7-day markets open. Human wallets and their claims are untouched.")}
          >
            {busy === "reset_demo" ? "Starting reset…" : "Reset demo"}
          </button>
          {op && !op.completed && op.failed && !op.running && (
            <button className="btn btn-primary" disabled={!password || busy !== null} onClick={() => act("resume_operation")}>
              {busy === "resume_operation" ? "Resuming…" : `Resume ${op.action.replace("_", " ")}`}
            </button>
          )}
        </div>
        <p className="text-xs text-dim">Pausing stops simulated trading only. Makers keep quoting and on-chain deadlines never change.</p>
        {error && <p className="text-sm text-down">{error}</p>}

        {op && (
          <div className={`rounded-md border p-3 text-sm ${op.failed ? "border-down" : op.completed ? "border-line" : "border-info"}`}>
            <div className="font-medium">
              {op.action === "reset_demo" ? "Reset demo" : "Reset market"} · {op.completed ? "complete" : op.failed ? `stopped during “${PHASES[op.phase] ?? op.phase}”` : PHASES[op.phase] ?? op.phase}
              {op.timings.totalMs ? ` · ${Math.round(op.timings.totalMs / 1000)} s` : ""}
            </div>
            {op.error && <div className="text-down">{op.error}</div>}
            <ol className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs text-ink-secondary">
              {op.log.slice(-40).map((l, i) => (
                <li key={i}>
                  <span className="text-faint">{l.at.slice(11, 19)}</span> {l.text}
                  {l.signature && <a className="ml-2 text-info hover:underline" href={explorerTx(l.signature)} target="_blank" rel="noreferrer">Explorer</a>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {funding && (
          <details className="text-sm">
            <summary className="cursor-pointer text-dim">Wallet funding</summary>
            <table className="mt-2 w-full text-xs">
              <tbody className="divide-y divide-line">
                {funding.wallets.map((w) => (
                  <tr key={w.name} className={w.low ? "text-down" : ""}>
                    <td className="py-1 pr-3">{w.name}</td>
                    <td className="py-1 pr-3 text-right num">{formatSol(BigInt(w.lamports))} SOL</td>
                    <td className="py-1 text-right num">{BigInt(w.musd) > 0n ? `${formatMusd(BigInt(w.musd))} mUSD` : ""}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1 pr-3">{funding.sim.traders} simulated traders</td>
                  <td className="py-1 pr-3 text-right num">{formatSol(BigInt(funding.sim.lamports))} SOL</td>
                  <td className="py-1 text-right num">{formatMusd(BigInt(funding.sim.musd))} mUSD free</td>
                </tr>
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Panel>
  );
}
