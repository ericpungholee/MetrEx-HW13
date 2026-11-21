"use client";

// Portfolio (spec §3.1 item 4, §10.4): balance, offers, positions, exposure, claimable, P&L.
import { useWalletSigner } from "@/lib/useWalletSigner";
import type { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useMemo } from "react";
import { useTx } from "@/components/TxProvider";
import { Empty, ErrorLine, Musd, PageHeader, Panel, Pill, ReplayLabel, scenarioName, Stat, StatusPill } from "@/components/ui";
import {
  cancelOffer,
  claimablePositions,
  claimAll,
  fetchActivity,
  fetchExchange,
  fetchMusdBalance,
  requireSigner,
  viewerFor,
} from "@/lib/client";
import { computePortfolio, propertyLabel, type PositionRow } from "@/lib/derive";
import { formatBps, formatMusd, formatSignedMusd, shortKey } from "@/lib/format";
import { marketDisplayState } from "@metrex/shared";
import { usePoll } from "@/lib/usePoll";

export default function PortfolioPage() {
  const wallet = useWalletSigner();
  const viewer = viewerFor(wallet?.publicKey);
  if (!viewer) {
    return (
      <div className="animate-in mx-auto max-w-lg py-24 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Portfolio</h1>
        <p className="mt-3 text-[15px] text-dim">Connect a wallet to see your positions, offers, and performance.</p>
      </div>
    );
  }
  return <PortfolioView viewer={viewer} />;
}

function PortfolioView({ viewer }: { viewer: PublicKey }) {
  const wallet = useWalletSigner();
  const { run } = useTx();
  const ex = usePoll(fetchExchange, []);
  const balance = usePoll(() => fetchMusdBalance(viewer), [viewer.toBase58()]);
  const buys = usePoll(
    async () => {
      const events = await fetchActivity(viewer, 50);
      const map = new Map<string, bigint>();
      for (const e of events) {
        if (e.name !== "PositionBought") continue;
        const buyer = e.data.buyer as PublicKey | undefined;
        if (!buyer || !buyer.equals(viewer)) continue;
        const key = `${(e.data.offer as PublicKey).toBase58()}:${Number(e.data.side)}`;
        if (!map.has(key)) map.set(key, BigInt(String(e.data.price)));
      }
      return map;
    },
    [viewer.toBase58()],
    15_000,
  );

  const pf = useMemo(() => (ex.data ? computePortfolio(viewer, ex.data.markets, ex.data.offers) : null), [ex.data, viewer]);
  const claimable = useMemo(
    () => (ex.data ? claimablePositions(viewer, ex.data.markets, ex.data.offers) : []),
    [ex.data, viewer],
  );

  if (ex.loading) return <Empty>Loading portfolio…</Empty>;
  if (!pf || !ex.data) return <ErrorLine error={ex.error} />;
  const properties = ex.data.properties;

  let realized = pf.realizedPnl;
  for (const p of pf.bought) {
    const entry = buys.data?.get(`${p.offer.publicKey.toBase58()}:${p.side === "Protection" ? 0 : 1}`);
    if (entry === undefined) continue;
    if (p.status === "claimable" || p.status === "claimed") realized += p.payoutIfWin - entry;
    else if (p.status === "lost") realized -= entry;
  }

  async function doClaimAll() {
    await run(`Claim ${claimable.length} position(s)`, (opts) => claimAll(requireSigner(wallet), claimable, opts));
    ex.refresh();
    balance.refresh();
  }

  return (
    <div className="animate-in space-y-12">
      <PageHeader
        title="Portfolio"
        description={<span className="num text-sm text-dim">{shortKey(viewer, 6)}</span>}
        action={
          claimable.length > 0 ? (
            <button className="btn btn-primary" onClick={doClaimAll}>
              Claim {formatMusd(pf.claimable)} mUSD
            </button>
          ) : undefined
        }
      />

      <ErrorLine error={ex.error} />

      <section className="grid grid-cols-2 gap-x-8 gap-y-8 border-b border-line pb-10 sm:grid-cols-4">
        <Stat large label="Balance" >
          {balance.data !== undefined ? formatMusd(balance.data) : "…"}
        </Stat>
        <Stat large label="Locked">
          {formatMusd(pf.lockedCollateral)}
        </Stat>
        <Stat large label="Claimable">
          <span className={pf.claimable > 0n ? "text-up" : ""}>{formatMusd(pf.claimable)}</span>
        </Stat>
        <Stat large label="Realized P&L">
          <span className={realized > 0n ? "text-up" : realized < 0n ? "text-down" : ""}>{formatSignedMusd(realized)}</span>
        </Stat>
      </section>

      <section className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
        <Stat label="Open offers">{pf.openOffers.length}</Stat>
        <Stat label="Active positions">{pf.positions.filter((p) => p.status === "active").length}</Stat>
        <Stat label="Total exposure">{formatMusd(pf.totalExposure)}</Stat>
        <Stat label="Premiums earned / paid">
          {formatMusd(pf.premiumsEarned, 0)} / {formatMusd(pf.premiumsPaid, 0)}
        </Stat>
      </section>

      <Panel title="Exposure by scenario">
        {pf.exposureByScenario.size === 0 ? (
          <Empty>No active positions.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th className="r">Positions</th>
                  <th className="r">Risk</th>
                  <th className="r">Protection</th>
                  <th className="r">Net if triggered</th>
                </tr>
              </thead>
              <tbody>
                {[...pf.exposureByScenario.entries()].map(([sid, e]) => (
                  <tr key={sid}>
                    <td>{scenarioName(sid)}</td>
                    <td className="r num">{e.positions}</td>
                    <td className="r num text-down">{formatMusd(e.risk)}</td>
                    <td className="r num text-up">{formatMusd(e.protection)}</td>
                    <td className="r num">{formatSignedMusd(e.protection - e.risk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-sm text-faint">
          Positions in the same scenario move together — one fire can settle every home in its footprint.
        </p>
      </Panel>

      <Panel title={`Open offers · ${formatMusd(pf.lockedCollateral)} mUSD locked`}>
        {pf.openOffers.length === 0 ? (
          <Empty>No open offers.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="r">Rate</th>
                  <th className="r">Coverage</th>
                  <th className="r">Premium</th>
                  <th className="r">Collateral</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pf.openOffers.map(({ market, offer }) => (
                  <tr key={offer.publicKey.toBase58()}>
                    <td>
                      {market ? (
                        <Link className="font-medium hover:underline" href={`/market/${market.publicKey.toBase58()}`}>
                          {propertyLabel(market.account.propertyId, properties)}
                        </Link>
                      ) : (
                        <span className="num text-dim">{shortKey(offer.account.market)}</span>
                      )}
                    </td>
                    <td className="r num">{formatBps(offer.account.premiumBps)}</td>
                    <td className="r num">{formatMusd(offer.account.coverage)}</td>
                    <td className="r num">{formatMusd(offer.account.premium)}</td>
                    <td className="r num">{formatMusd(offer.account.collateral)}</td>
                    <td>{market && <StatusPill state={marketDisplayState(market.account)} />}</td>
                    <td className="r">
                      <button
                        className="btn btn-down btn-sm"
                        onClick={async () => {
                          await run("Cancel offer", (opts) => cancelOffer(requireSigner(wallet), offer, opts));
                          ex.refresh();
                        }}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <PositionsPanel title="Positions" rows={pf.positions} properties={properties} entries={buys.data} />
      <PositionsPanel title="Bought positions" rows={pf.bought} properties={properties} entries={buys.data} showEntry />
      <ReplayLabel />
    </div>
  );
}

const STATUS_TONE: Record<PositionRow["status"], "dim" | "up" | "down" | "warn" | "info"> = {
  active: "info",
  claimable: "up",
  claimed: "dim",
  lost: "down",
  refunded: "dim",
  voided: "warn",
};

function PositionsPanel({
  title,
  rows,
  properties,
  entries,
  showEntry,
}: {
  title: string;
  rows: PositionRow[];
  properties: Parameters<typeof propertyLabel>[1];
  entries: Map<string, bigint> | undefined;
  showEntry?: boolean;
}) {
  return (
    <Panel title={`${title} · ${rows.length}`}>
      {rows.length === 0 ? (
        <Empty>None yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="dense">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="r">Payout if win</th>
                <th className="r">Rate</th>
                <th>Market</th>
                <th>Position</th>
                {showEntry && <th className="r">Entry</th>}
                <th className="r">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const entry = entries?.get(`${p.offer.publicKey.toBase58()}:${p.side === "Protection" ? 0 : 1}`);
                let pnl = p.realized;
                if (p.bought && entry !== undefined) {
                  if (p.status === "claimable" || p.status === "claimed") pnl = p.payoutIfWin - entry;
                  else if (p.status === "lost") pnl = -entry;
                }
                return (
                  <tr key={`${p.offer.publicKey.toBase58()}-${p.side}`}>
                    <td>
                      <Link className="font-medium hover:underline" href={`/market/${p.market.publicKey.toBase58()}`}>
                        {propertyLabel(p.market.account.propertyId, properties)}
                      </Link>
                    </td>
                    <td>
                      <Pill tone={p.side === "Protection" ? "up" : "warn"}>{p.side}</Pill>
                      {p.bought && <span className="ml-1.5 text-xs text-faint">bought</span>}
                    </td>
                    <td className="r">
                      <Musd value={p.payoutIfWin} />
                    </td>
                    <td className="r num">{formatBps(p.offer.account.premiumBps)}</td>
                    <td>
                      <StatusPill state={marketDisplayState(p.market.account)} />
                    </td>
                    <td>
                      <Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill>
                    </td>
                    {showEntry && <td className="r num">{entry !== undefined ? formatMusd(entry) : "—"}</td>}
                    <td className={`r num ${pnl !== null && pnl > 0n ? "text-up" : pnl !== null && pnl < 0n ? "text-down" : ""}`}>
                      {pnl === null ? "—" : formatSignedMusd(pnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
