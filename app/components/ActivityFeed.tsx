"use client";

// Activity feed (spec §6.5) decoded from program event logs. Best effort.
import type { PublicKey } from "@solana/web3.js";
import { fetchActivity, type ActivityItem } from "@/lib/client";
import { formatBps, formatMusd, shortKey, timeAgo } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { Empty, Panel, TxLink } from "./ui";

function k(v: unknown): string {
  if (v && typeof v === "object" && "toBase58" in v) return shortKey((v as PublicKey).toBase58());
  return String(v ?? "?");
}

function amt(v: unknown): string {
  try {
    return `${formatMusd(BigInt(String(v)))} mUSD`;
  } catch {
    return "?";
  }
}

const SIDE = ["Protection", "Risk"];

export function describeEvent(e: ActivityItem): string {
  const d = e.data;
  switch (e.name) {
    case "MarketCreated":
      return `Market created by ${k(d.homeowner)} for ${amt(d.coverage_target)}`;
    case "OfferPlaced":
      return `${k(d.underwriter)} offered ${amt(d.coverage)} at ${formatBps(Number(d.premium_bps))} (collateral ${amt(d.collateral)} locked)`;
    case "OfferCancelled":
      return `${k(d.underwriter)} cancelled an offer (${amt(d.refunded)} returned)`;
    case "OfferAccepted":
      return `Homeowner accepted ${amt(d.coverage)} from ${k(d.underwriter)} (premium ${amt(d.premium)})`;
    case "MarketClosed":
      return "Market closed by the demo controller";
    case "MarketResolved":
      return `Oracle resolved: ${d.triggered ? "TRIGGERED" : "NOT triggered"}`;
    case "PayoutClaimed":
      return `${k(d.claimant)} claimed ${amt(d.amount)}`;
    case "MarketVoided":
      return "Market voided by admin";
    case "OfferRefunded":
      return `Offer refunded (premium ${amt(d.premium)} → homeowner, collateral ${amt(d.collateral)} → underwriter)`;
    case "PositionListed":
      return `${k(d.seller)} listed ${SIDE[Number(d.side)] ?? "?"} side for ${amt(d.price)}`;
    case "PositionBought":
      return `${k(d.buyer)} bought ${SIDE[Number(d.side)] ?? "?"} side from ${k(d.seller)} for ${amt(d.price)}`;
    case "ListingCancelled":
      return `${k(d.seller)} cancelled a ${SIDE[Number(d.side)] ?? "?"} listing`;
    default:
      return e.name;
  }
}

export function ActivityFeed({ address }: { address: PublicKey }) {
  const feed = usePoll(() => fetchActivity(address, 25), [address.toBase58()], 6_000);
  return (
    <Panel title="Activity" right={<span className="text-[10px] text-faint">from program event logs</span>}>
      {feed.error && <div className="text-xs text-faint">Activity unavailable: {feed.error}</div>}
      {feed.loading && <Empty>Loading…</Empty>}
      {feed.data && feed.data.length === 0 && <Empty>No events yet.</Empty>}
      <ul className="divide-y divide-line">
        {feed.data?.map((e, i) => (
          <li key={`${e.signature}-${i}`} className="flex items-center gap-3 py-1.5 text-xs">
            <span className="w-28 shrink-0 font-semibold text-dim">{e.name}</span>
            <span className="min-w-0 flex-1 truncate">{describeEvent(e)}</span>
            <span className="num w-16 shrink-0 text-right text-faint">{e.blockTime ? timeAgo(e.blockTime) : ""}</span>
            <span className="w-28 shrink-0 text-right">
              <TxLink signature={e.signature} />
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
