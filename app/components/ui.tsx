"use client";

import { HISTORICAL_REPLAY_LABEL, SCENARIO_PALISADES_2025, TRIGGER_WORDING, type MarketDisplayState } from "@metrex/shared";
import type { PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";
import { explorerAddress, explorerTx, formatMusd, shortKey } from "@/lib/format";

const PILL: Record<MarketDisplayState, string> = {
  "Accepting offers": "bg-info/15 text-info border-info/40",
  Funded: "bg-up/15 text-up border-up/40",
  "Closed — awaiting oracle": "bg-warn/15 text-warn border-warn/40",
  "Resolved: triggered": "bg-down/15 text-down border-down/40",
  "Resolved: not triggered": "bg-up/15 text-up border-up/40",
  Voided: "bg-faint/20 text-dim border-faint/40",
};

export function StatusPill({ state }: { state: MarketDisplayState }) {
  return (
    <span className={`inline-block rounded-sm border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${PILL[state]}`}>
      {state}
    </span>
  );
}

export function Pill({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "up" | "down" | "warn" | "info" }) {
  const cls = {
    dim: "bg-faint/20 text-dim border-faint/40",
    up: "bg-up/15 text-up border-up/40",
    down: "bg-down/15 text-down border-down/40",
    warn: "bg-warn/15 text-warn border-warn/40",
    info: "bg-info/15 text-info border-info/40",
  }[tone];
  return <span className={`inline-block rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>{children}</span>;
}

/** Every market is tagged with this (spec §8.5). */
export function ReplayLabel({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-block rounded-sm border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold text-warn ${className}`}>
      {HISTORICAL_REPLAY_LABEL}
    </span>
  );
}

/** The exact trigger sentence (spec §3.3), shown on every market page. */
export function TriggerWording() {
  return <p className="text-sm text-ink">{TRIGGER_WORDING}</p>;
}

export function Musd({ value, className = "" }: { value: bigint | { toString(): string }; className?: string }) {
  return (
    <span className={`num ${className}`}>
      {formatMusd(value)} <span className="text-faint">mUSD</span>
    </span>
  );
}

export function AddressLink({ address, you, chars = 4 }: { address: PublicKey | string; you?: PublicKey | null; chars?: number }) {
  const s = typeof address === "string" ? address : address.toBase58();
  const isYou = you ? you.toBase58() === s : false;
  return (
    <a className="num text-info hover:underline" href={explorerAddress(s)} target="_blank" rel="noreferrer" title={s}>
      {shortKey(s, chars)}
      {isYou && <span className="ml-1 text-up">(you)</span>}
    </a>
  );
}

export function TxLink({ signature }: { signature: string }) {
  if (signature.startsWith("FIXTURE")) return <span className="num text-fixture">fixture</span>;
  return (
    <a className="num text-info hover:underline" href={explorerTx(signature)} target="_blank" rel="noreferrer">
      {shortKey(signature, 6)} ↗
    </a>
  );
}

export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded border border-line bg-panel ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-xs font-semibold tracking-wide text-dim uppercase">{title}</h2>
          <div>{right}</div>
        </div>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-wide text-faint uppercase">{label}</div>
      <div className="num mt-0.5 truncate text-sm text-ink">{children}</div>
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-xs text-faint">{children}</div>;
}

export const SCENARIO_NAMES: Record<number, string> = {
  [SCENARIO_PALISADES_2025]: "Palisades Fire, January 2025",
};

export function scenarioName(id: number): string {
  return SCENARIO_NAMES[id] ?? `Scenario ${id}`;
}

/** Funding bar: activated (solid) + selected-but-not-yet-accepted (striped) over target. */
export function FundingBar({ activated, target, pending = 0n }: { activated: bigint; target: bigint; pending?: bigint }) {
  const pct = (x: bigint) => (target === 0n ? 0 : Number((x * 10_000n) / target) / 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-sm bg-line">
      <div className="flex h-full">
        <div className="h-full bg-up" style={{ width: `${pct(activated)}%` }} />
        <div
          className="h-full bg-info/70"
          style={{ width: `${pct(pending)}%`, backgroundImage: "repeating-linear-gradient(45deg,transparent 0 4px,rgba(0,0,0,.25) 4px 8px)" }}
        />
      </div>
    </div>
  );
}
