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
  return <span className={`text-xs font-medium ${STATE_TONE[state]}`}>{state}</span>;
}

/** §10.1: the payout rule on every market page (plain text, no pills). Wildfire sentence by default, `payoutRule` per hazard. */
export function TriggerSentence({ text = TRIGGER_SENTENCE, className = "" }: { text?: string; className?: string }) {
  return <span className={`text-[11px] leading-snug text-faint ${className}`}>{text}</span>;
}

/** §10.1 replay disclosure; `replayOf` names the real event the market replays (docs/spec-multiperil.md §7.1). */
export function ReplayDisclosure({ className = "", replayOf }: { className?: string; replayOf?: string }) {
  return (
    <span className={`text-[11px] leading-snug text-faint ${className}`}>
      {REPLAY_DISCLOSURE}
      {replayOf && <> This market replays {replayOf}. Coverage dates are historical; trading time on-chain is the demo clock.</>}
    </span>
  );
}

export function InvalidDisclosure() {
  return <p className="text-[11px] leading-snug text-faint">{INVALID_DISCLOSURE}</p>;
}

export function LiquidityDisclosure() {
  return <p className="text-xs leading-snug text-faint">{LIQUIDITY_DISCLOSURE}</p>;
}

/** Quiet "unavailable" line: the UI never shows cached or invented data as live (§7.5). */
export function Unavailable({ children }: { children?: ReactNode }) {
  return <div className="py-6 text-sm text-warn">{children ?? "Unavailable right now."}</div>;
}
