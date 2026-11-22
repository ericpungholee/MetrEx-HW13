"use client";

// Trade and settlement ledger (docs/spec-simulation.md §8). Rebuilt on the server from the market's
// finalized program events and its vault balance, never from the simulator. Every row links to its
// Solana Explorer transaction.
import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { HAZARD_LABEL, catalogByProperty } from "@metrex/exchange";
import { fetchLedger, type LedgerInfo, type LedgerParticipant } from "@/lib/exchange-client";
import { formatPrice, formatShares } from "@/lib/exchange-format";
import { explorerAddress, explorerTx, formatMusd, formatUnix, shortKey } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { PageHeader, Panel, Stat } from "@/components/ui";
import { knownName, Unavailable } from "@/components/exchange/Labels";

const signed = (v: bigint) => (v < 0n ? `−${formatMusd(-v)}` : `+${formatMusd(v)}`);
const OUTCOME_TEXT: Record<LedgerInfo["outcome"], string> = {
  unresolved: "Awaiting settlement",
  yes: "Resolved YES",
  no: "Resolved NO",
  invalid: "Resolved Invalid",
};

function Wallet({ address, labels, me }: { address: string; labels: Map<string, string>; me: string | null }) {
  const text = me === address ? "You" : knownName(labels.get(address), true) ?? shortKey(address, 4);
  return (
    <a className="text-ink-secondary underline-offset-2 hover:text-ink hover:underline" href={explorerAddress(address)} target="_blank" rel="noreferrer" title={address}>
      {text}
    </a>
  );
}

function position(p: LedgerParticipant, outcome: LedgerInfo["outcome"]): string {
  const lost = (side: "yes" | "no") => (outcome === "yes" || outcome === "no") && outcome !== side ? " (expired worthless)" : "";
  const parts = [p.yes > 0n ? `${formatShares(p.yes)} YES${lost("yes")}` : null, p.no > 0n ? `${formatShares(p.no)} NO${lost("no")}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : p.redeemed > 0n ? "Redeemed" : "Flat";
}

export default function LedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const [view, setView] = useState<"settlement" | "trades">("settlement");
  const ledger = usePoll(() => fetchLedger(id), [id], 10_000);
  const l = ledger.data;
  const entry = l ? catalogByProperty(l.propertyId) : undefined;
  const mine = useMemo(() => (l && me ? l.participants.find((p) => p.wallet === me) : undefined), [l, me]);
  const resolved = l ? l.outcome !== "unresolved" : false;

  return (
    <div className="space-y-8">
      <PageHeader
        title={entry ? `${HAZARD_LABEL[entry.hazard]} · ${entry.place}` : "Settlement ledger"}
        description={
          <>
            Every figure is rebuilt from finalized on-chain events for this market and its collateral vault. Participants include simulated traders and MetrEx market makers on Devnet.{" "}
            <Link href={`/market/${id}`} className="underline underline-offset-2">Back to the market</Link>
          </>
        }
      />
      {!l ? (
        ledger.error ? <Unavailable>{ledger.error.includes("ndexing") ? "Indexing this market's transactions. This page updates by itself." : ledger.error}</Unavailable> : <div className="text-sm text-dim">Loading ledger…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 rounded-lg border border-line p-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Outcome">{OUTCOME_TEXT[l.outcome]}</Stat>
            <Stat label="Vault collateral">{formatMusd(l.reconciliation.vaultBalance)} mUSD</Stat>
            <Stat label="Trading volume">{formatMusd(l.totals.volume)} mUSD</Stat>
            <Stat label="Participants">{l.totals.participants}</Stat>
            <Stat label="Executed trades">{l.totals.trades.toLocaleString()}</Stat>
          </div>

          {mine && (
            <Panel title="Your position">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Holding">{position(mine, l.outcome)}</Stat>
                <Stat label="Paid">{formatMusd(mine.spent)} mUSD</Stat>
                <Stat label={resolved ? "Paid out + claimable" : "Received"}>{formatMusd(mine.redeemed + mine.claimable + (resolved ? 0n : mine.received))} mUSD</Stat>
                <Stat label="Net P&L">{mine.netPnl === null ? "At settlement" : `${signed(mine.netPnl)} mUSD`}</Stat>
              </div>
              {mine.claimable > 0n && <p className="mt-3 text-sm text-ink-secondary">{formatMusd(mine.claimable)} mUSD is ready to redeem from the market page.</p>}
            </Panel>
          )}

          <Panel title="Collateral reconciliation">
            <ul className="space-y-1.5 text-sm">
              <li>Deposited by splits {formatMusd(l.totals.splits)} − returned by merges {formatMusd(l.totals.merges)} − paid out {formatMusd(l.totals.payouts)} = booked collateral <b>{formatMusd(l.totals.bookedCollateral)} mUSD</b>.</li>
              <li>
                <a className="underline underline-offset-2" href={explorerAddress(l.vault)} target="_blank" rel="noreferrer">Vault</a> holds {formatMusd(l.reconciliation.vaultBalance)} mUSD:{" "}
                <span className={l.reconciliation.vaultCoversBooked ? "text-up" : "text-down"}>{l.reconciliation.vaultCoversBooked ? "covers booked collateral" : "below booked collateral"}</span>
                {resolved && (
                  <>, <span className={l.reconciliation.vaultCoversClaims ? "text-up" : "text-down"}>{l.reconciliation.vaultCoversClaims ? "covers" : "does not cover"}</span> the {formatMusd(l.totals.claimable)} mUSD still claimable</>
                )}
                .
              </li>
              <li className={l.reconciliation.payoutsWithinDeposits ? "" : "text-down"}>Redemptions {l.reconciliation.payoutsWithinDeposits ? "never exceeded" : "EXCEEDED"} collateral deposited.</li>
              {resolved && l.totals.pnlSum !== null && <li>Net P&L across all {l.participants.length} wallets sums to {signed(l.totals.pnlSum)} mUSD (no fees: every payout is funded by another participant's stake).</li>}
              {l.reconciliation.surplus > 0n && <li className="text-dim">{formatMusd(l.reconciliation.surplus)} mUSD sent to the vault outside the program stays stranded.</li>}
            </ul>
          </Panel>

          <div className="flex gap-2" role="tablist">
            {(["settlement", "trades"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={`btn btn-sm ${view === v ? "btn-primary" : ""}`} onClick={() => setView(v)}>
                {v === "settlement" ? "Settlement ledger" : "Trade ledger"}
              </button>
            ))}
          </div>

          {view === "settlement" ? (
            <Panel title="Participant settlement ledger">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-faint uppercase">
                    <tr>
                      <th className="py-2 pr-3">Wallet</th>
                      <th className="py-2 pr-3">Position</th>
                      <th className="py-2 pr-3 text-right">Paid</th>
                      <th className="py-2 pr-3 text-right">Received</th>
                      <th className="py-2 pr-3 text-right">Payout</th>
                      <th className="py-2 pr-3 text-right">Net P&L</th>
                      <th className="py-2">Redemption</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {l.participants.map((p) => (
                      <tr key={p.wallet} className={p.wallet === me ? "bg-bg-soft" : ""}>
                        <td className="py-2 pr-3"><Wallet address={p.wallet} labels={l.labels} me={me} /></td>
                        <td className="py-2 pr-3 num">{position(p, l.outcome)}</td>
                        <td className="py-2 pr-3 text-right num">{formatMusd(p.spent)}</td>
                        <td className="py-2 pr-3 text-right num">{formatMusd(p.received)}</td>
                        <td className="py-2 pr-3 text-right num">{resolved ? `${formatMusd(p.redeemed + p.claimable)}${p.claimable > 0n ? " (claimable)" : ""}` : "—"}</td>
                        <td className={`py-2 pr-3 text-right num ${p.netPnl === null ? "" : p.netPnl >= 0n ? "text-up" : "text-down"}`}>{p.netPnl === null ? "—" : signed(p.netPnl)}</td>
                        <td className="py-2">
                          {p.redemptions.slice(-2).map((s) => (
                            <a key={s} className="mr-2 text-xs text-info hover:underline" href={explorerTx(s)} target="_blank" rel="noreferrer">{shortKey(s, 4)}</a>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Panel title={`Trade ledger (${l.totals.trades.toLocaleString()} fills, newest first)`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-faint uppercase">
                    <tr>
                      <th className="py-2 pr-3">Time</th>
                      <th className="py-2 pr-3">Book</th>
                      <th className="py-2 pr-3">Buyer</th>
                      <th className="py-2 pr-3">Seller</th>
                      <th className="py-2 pr-3 text-right">Price</th>
                      <th className="py-2 pr-3 text-right">Shares</th>
                      <th className="py-2 pr-3 text-right">mUSD</th>
                      <th className="py-2">Transaction</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {l.trades.slice(0, 500).map((t, i) => (
                      <tr key={`${t.signature}:${i}`}>
                        <td className="py-2 pr-3 text-dim">{t.blockTime ? formatUnix(t.blockTime) : "—"}</td>
                        <td className="py-2 pr-3">{t.outcome}</td>
                        <td className="py-2 pr-3"><Wallet address={t.buyer} labels={l.labels} me={me} /></td>
                        <td className="py-2 pr-3"><Wallet address={t.seller} labels={l.labels} me={me} /></td>
                        <td className="py-2 pr-3 text-right num">{formatPrice(t.priceBps)}</td>
                        <td className="py-2 pr-3 text-right num">{formatShares(t.quantity)}</td>
                        <td className="py-2 pr-3 text-right num">{formatMusd(t.quoteAmount)}</td>
                        <td className="py-2"><a className="text-xs text-info hover:underline" href={explorerTx(t.signature)} target="_blank" rel="noreferrer">{shortKey(t.signature, 4)}</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {l.trades.length > 500 && <p className="mt-2 text-xs text-dim">Showing the newest 500 of {l.trades.length.toLocaleString()} fills. Totals above include all of them.</p>}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
