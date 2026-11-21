"use client";

import { createContext, useContext, type ReactNode } from "react";
import { explorerAddress, shortKey } from "@/lib/format";
import {
  INVALID_DISCLOSURE,
  LIQUIDITY_DISCLOSURE,
  REPLAY_DISCLOSURE,
  STATE_TONE,
  TRIGGER_SENTENCE,
  formatPrice,
  type MarketState,
} from "@/lib/exchange-format";

/** address → "A" | "B" | "C" for the MetrEx-operated market makers (§8.4). */
export const MakersContext = createContext<Map<string, string>>(new Map());

/** "MetrEx market maker A", "You", or a short Explorer link. */
export function MakerLabel({ address, me, short }: { address: string; me?: string | null; short?: boolean }) {
  const makers = useContext(MakersContext);
  const bot = makers.get(address);
  const text = me && me === address ? "You" : bot ? (short ? `Maker ${bot}` : `MetrEx market maker ${bot}`) : shortKey(address, 4);
  return (
    <a className="text-ink-secondary underline-offset-2 hover:text-ink hover:underline" href={explorerAddress(address)} target="_blank" rel="noreferrer" title={address}>
      {text}
    </a>
  );
}

export function Price({ bps, className = "" }: { bps: number | null | undefined; className?: string }) {
  return <span className={`num ${className}`}>{formatPrice(bps)}</span>;
}

export function StateLabel({ state }: { state: MarketState }) {
  return <span className={`text-sm font-medium ${STATE_TONE[state]}`}>{state}</span>;
}

/** §10.1: the trigger sentence on every market page. */
export function TriggerSentence() {
  return <p className="text-[15px] leading-relaxed text-ink-secondary">{TRIGGER_SENTENCE}</p>;
}

export function ReplayDisclosure({ className = "" }: { className?: string }) {
  return <p className={`text-sm text-dim ${className}`}>{REPLAY_DISCLOSURE}</p>;
}

export function InvalidDisclosure() {
  return <p className="text-xs leading-relaxed text-dim">{INVALID_DISCLOSURE}</p>;
}

export function LiquidityDisclosure() {
  return <p className="text-sm text-dim">{LIQUIDITY_DISCLOSURE}</p>;
}

/** Quiet "unavailable" line: the UI never shows cached or invented data as live (§7.5). */
export function Unavailable({ children }: { children?: ReactNode }) {
  return <div className="py-6 text-sm text-warn">{children ?? "Unavailable right now."}</div>;
}
