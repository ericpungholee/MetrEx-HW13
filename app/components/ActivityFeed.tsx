"use client";

// Activity feed (spec §6.5) decoded from program event logs.
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
      return `Market created for ${amt(d.coverage_target)}`;
    case "OfferPlaced":
      return `${k(d.underwriter)} offered ${amt(d.coverage)} at ${formatBps(Number(d.premium_bps))}`;
    case "OfferCancelled":
      return `${k(d.underwriter)} cancelled an offer`;
    case "OfferAccepted":
      return `Accepted ${amt(d.coverage)} from ${k(d.underwriter)}`;
    case "MarketClosed":
      return "Market closed";
    case "MarketResolved":
      return d.triggered ? "Resolved: fire within range" : "Resolved: fire outside range";
    case "PayoutClaimed":
      return `${k(d.claimant)} claimed ${amt(d.amount)}`;
    case "MarketVoided":
      return "Market voided";
    case "OfferRefunded":
      return `Position refunded · ${amt(d.premium)} premium, ${amt(d.collateral)} collateral`;
    case "PositionListed":
      return `${k(d.seller)} listed ${SIDE[Number(d.side)] ?? "?"} for ${amt(d.price)}`;
    case "PositionBought":
      return `${k(d.buyer)} bought ${SIDE[Number(d.side)] ?? "?"} for ${amt(d.price)}`;
    case "ListingCancelled":
      return `${k(d.seller)} cancelled a listing`;
    default:
      return e.name;
  }
}

export function ActivityFeed({ address }: { address: PublicKey }) {
  const feed = usePoll(() => fetchActivity(address, 25), [address.toBase58()], 6_000);
  return (
    <Panel title="Activity">
      {feed.error && <div className="text-sm text-dim">Activity unavailable</div>}
      {feed.loading && <Empty>Loading activity…</Empty>}
      {feed.data && feed.data.length === 0 && <Empty>No activity yet.</Empty>}
      <ul>
        {feed.data?.map((e, i) => (
          <li key={`${e.signature}-${i}`} className="flex items-baseline gap-4 border-b border-line py-3 text-sm last:border-b-0">
            <span className="min-w-0 flex-1 text-ink-secondary">{describeEvent(e)}</span>
            <span className="num shrink-0 text-faint">{e.blockTime ? timeAgo(e.blockTime) : ""}</span>
            <span className="shrink-0">
              <TxLink signature={e.signature} />
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
