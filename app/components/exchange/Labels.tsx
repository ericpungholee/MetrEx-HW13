"use client";

import { createContext, useContext, type ReactNode } from "react";
import { explorerAddress, shortKey } from "@/lib/format";
import {
  INVALID_DISCLOSURE,
  STATE_TONE,
  formatPrice,
  type MarketState,
} from "@/lib/exchange-format";

/** address → "A" | "B" | "C" for the MetrEx-operated market makers (§8.4). */
export const MakersContext = createContext<Map<string, string>>(new Map());

/** Display name for a known wallet: "MetrEx market maker A" or "Simulated trader T042" (docs/spec-simulation.md §1.4). */
export function knownName(tag: string | undefined, short?: boolean): string | undefined {
  if (!tag) return undefined;
  if (tag.startsWith("sim:")) return short ? `Sim ${tag.slice(4)}` : `Simulated trader ${tag.slice(4)}`;
  return short ? `Maker ${tag}` : `MetrEx market maker ${tag}`;
}

/** "MetrEx market maker A", "Simulated trader T042", "You", or a short Explorer link. */
export function MakerLabel({ address, me, short }: { address: string; me?: string | null; short?: boolean }) {
  const makers = useContext(MakersContext);
  const text = me && me === address ? "You" : knownName(makers.get(address), short) ?? shortKey(address, 4);
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

export function InvalidDisclosure() {
  return <p className="text-[11px] leading-snug text-faint">{INVALID_DISCLOSURE}</p>;
}

/** Quiet "unavailable" line: the UI never shows cached or invented data as live (§7.5). */
export function Unavailable({ children }: { children?: ReactNode }) {
  return <div className="py-6 text-sm text-warn">{children ?? "Unavailable right now."}</div>;
}
