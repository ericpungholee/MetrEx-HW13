"use client";

import { HISTORICAL_REPLAY_LABEL, SCENARIO_PALISADES_2025, TRIGGER_WORDING, type MarketDisplayState } from "@metrex/shared";
import type { PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";
import { explorerAddress, explorerTx, formatMusd, shortKey } from "@/lib/format";

const STATUS_TONE: Record<MarketDisplayState, string> = {
  "Accepting offers": "text-ink",
  Funded: "text-up",
  "Closed — awaiting oracle": "text-warn",
  "Resolved: triggered": "text-down",
  "Resolved: not triggered": "text-up",
  Voided: "text-dim",
};

/** Quiet status label — color carries meaning, no pill chrome. */
export function StatusPill({ state }: { state: MarketDisplayState }) {
  return <span className={`text-sm font-medium ${STATUS_TONE[state]}`}>{state}</span>;
}

export function Pill({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "up" | "down" | "warn" | "info" }) {
  const cls = {
    dim: "text-dim",
    up: "text-up",
    down: "text-down",
    warn: "text-warn",
    info: "text-ink-secondary",
  }[tone];
  return <span className={`text-sm font-medium ${cls}`}>{children}</span>;
}

/** Spec §8.5 — every market is labelled as historical replay. */
export function ReplayLabel({ className = "" }: { className?: string }) {
  return <p className={`text-sm text-dim ${className}`}>{HISTORICAL_REPLAY_LABEL}</p>;
}

/** Spec §3.3 — exact trigger sentence on every market page. */
export function TriggerWording() {
  return <p className="text-[15px] leading-relaxed text-ink-secondary">{TRIGGER_WORDING}</p>;
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
    <a className="num text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline" href={explorerAddress(s)} target="_blank" rel="noreferrer" title={s}>
      {isYou ? "You" : shortKey(s, chars)}
    </a>
  );
}

export function TxLink({ signature }: { signature: string }) {
  if (signature.startsWith("FIXTURE")) return <span className="num text-sm text-fixture">fixture</span>;
  return (
    <a className="num text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline" href={explorerTx(signature)} target="_blank" rel="noreferrer">
      {shortKey(signature, 6)}
    </a>
  );
}

/** Open section with a quiet header — prefer over nested cards. */
export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${className}`}>
      {(title || right) && (
        <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-line pb-3">
          <h2 className="text-sm font-medium tracking-wide text-dim uppercase">{title}</h2>
          {right && <div className="text-sm text-faint">{right}</div>}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
}

export function Stat({ label, children, large }: { label: string; children: ReactNode; large?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium tracking-wide text-faint uppercase">{label}</div>
      <div className={`num mt-1 truncate text-ink ${large ? "text-2xl font-medium tracking-tight" : "text-base"}`}>{children}</div>
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="border border-down/30 bg-down-soft px-4 py-3 text-sm text-down">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-sm text-dim">{children}</div>;
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{title}</h1>
        {description && <div className="mt-2 text-[15px] leading-relaxed text-dim">{description}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Callout({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "up" | "down" | "warn" }) {
  const cls = {
    neutral: "bg-bg-soft border-line",
    up: "bg-up-soft border-up/20",
    down: "bg-down-soft border-down/20",
    warn: "bg-warn-soft border-warn/20",
  }[tone];
  return <div className={`border px-5 py-4 ${cls}`}>{children}</div>;
}

export const SCENARIO_NAMES: Record<number, string> = {
  [SCENARIO_PALISADES_2025]: "Palisades Fire, January 2025",
};

export function scenarioName(id: number): string {
  return SCENARIO_NAMES[id] ?? `Scenario ${id}`;
}

/** Funding progress: activated fill over target. */
export function FundingBar({ activated, target, pending = 0n }: { activated: bigint; target: bigint; pending?: bigint }) {
  const pct = (x: bigint) => (target === 0n ? 0 : Math.min(100, Number((x * 10_000n) / target) / 100));
  return (
    <div className="h-1.5 w-full overflow-hidden bg-bg-muted">
      <div className="flex h-full">
        <div className="h-full bg-ink transition-[width] duration-300" style={{ width: `${pct(activated)}%` }} />
        {pending > 0n && <div className="h-full bg-ink/30" style={{ width: `${pct(pending)}%` }} />}
      </div>
    </div>
  );
}
