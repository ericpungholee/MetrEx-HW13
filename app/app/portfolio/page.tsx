"use client";

// Portfolio (spec §3.1 item 4, §10.4): balance, open offers, locked collateral, positions,
// total exposure, exposure per scenario, premiums, claimable, realized P&L, bought positions.
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useMemo } from "react";
import { useTx } from "@/components/TxProvider";
import { Empty, ErrorLine, Musd, Panel, Pill, ReplayLabel, scenarioName, Stat, StatusPill } from "@/components/ui";
import {
  cancelOffer,
  claimablePositions,
  claimAll,
  fetchActivity,
  fetchExchange,
  fetchMusdBalance,
  requireSigner,
  USE_FIXTURES,
  viewerFor,
} from "@/lib/client";
import { computePortfolio, propertyLabel, type PositionRow } from "@/lib/derive";
import { formatBps, formatMusd, formatSignedMusd, shortKey } from "@/lib/format";
import { marketDisplayState } from "@metrex/shared";
import { usePoll } from "@/lib/usePoll";

export default function PortfolioPage() {
  const wallet = useAnchorWallet();
  const viewer = viewerFor(wallet?.publicKey);
  if (!viewer) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <h1 className="text-lg font-bold">Portfolio</h1>
        <p className="mt-2 text-sm text-dim">Connect a wallet to see your offers, positions and exposure.</p>
      </div>
    );
  }
  return <PortfolioView viewer={viewer} />;
}

function PortfolioView({ viewer }: { viewer: PublicKey }) {
  const wallet = useAnchorWallet();
  const { run } = useTx();
  const ex = usePoll(fetchExchange, []);
  const balance = usePoll(() => fetchMusdBalance(viewer), [viewer.toBase58()]);
  // Entry prices of bought sides come from PositionBought events in the wallet's own txs (best effort).
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

  if (ex.loading) return <Empty>Loading portfolio from chain…</Empty>;
  if (!pf || !ex.data) return <ErrorLine error={ex.error} />;
  const properties = ex.data.properties;

  // Realized P&L including bought sides whose entry price we know.
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
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-bold">Portfolio</h1>
          <div className="num text-xs text-dim">
            {viewer.toBase58()}
            {USE_FIXTURES && !wallet && <span className="ml-2 text-fixture">(viewing as fixture wallet)</span>}
          </div>
        </div>
        {claimable.length > 0 && (
          <button className="btn btn-up" onClick={doClaimAll}>
            Claim all ({claimable.length}) · {formatMusd(pf.claimable)} mUSD
          </button>
        )}
      </div>
      <ErrorLine error={ex.error} />

      <section className="grid grid-cols-2 gap-3 rounded border border-line bg-panel p-4 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="mUSD balance">{balance.data !== undefined ? formatMusd(balance.data) : "…"}</Stat>
        <Stat label="Locked collateral">{formatMusd(pf.lockedCollateral)}</Stat>
        <Stat label="Open offers">{pf.openOffers.length}</Stat>
        <Stat label="Active positions">{pf.positions.filter((p) => p.status === "active").length}</Stat>
        <Stat label="Total exposure">{formatMusd(pf.totalExposure)}</Stat>
        <Stat label="Premiums earned / paid">
          {formatMusd(pf.premiumsEarned, 0)} / {formatMusd(pf.premiumsPaid, 0)}
        </Stat>
        <Stat label="Claimable">
          <span className={pf.claimable > 0n ? "text-up" : ""}>{formatMusd(pf.claimable)}</span>
        </Stat>
        <Stat label="Realized P&L">
          <span className={realized > 0n ? "text-up" : realized < 0n ? "text-down" : ""}>{formatSignedMusd(realized)}</span>
        </Stat>
      </section>

      <Panel
        title="Exposure per scenario"
        right={<span className="text-[10px] text-faint">one fire hits every home in its footprint at once</span>}
      >
        {pf.exposureByScenario.size === 0 ? (
          <Empty>No active positions.</Empty>
        ) : (
          <table className="dense">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="r">Positions</th>
                <th className="r">Risk side (you pay if triggered)</th>
                <th className="r">Protection side (you receive if triggered)</th>
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
        )}
        <p className="mt-2 text-[11px] text-faint">
          Exposure counts the escrowed coverage of each side you hold in unresolved markets. Many positions in one scenario are
          effectively one bet.
        </p>
      </Panel>

      <Panel title={`Open offers · locked ${formatMusd(pf.lockedCollateral)} mUSD`}>
        {pf.openOffers.length === 0 ? (
          <Empty>No open offers.</Empty>
        ) : (
          <table className="dense">
            <thead>
              <tr>
                <th>Market</th>
                <th className="r">Rate</th>
                <th className="r">Coverage</th>
                <th className="r">Premium</th>
                <th className="r">Collateral locked</th>
                <th>Market status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pf.openOffers.map(({ market, offer }) => (
                <tr key={offer.publicKey.toBase58()}>
                  <td>
                    {market ? (
                      <Link className="text-info hover:underline" href={`/market/${market.publicKey.toBase58()}`}>
                        {propertyLabel(market.account.propertyId, properties)}
                      </Link>
                    ) : (
                      shortKey(offer.account.market)
                    )}
                  </td>
                  <td className="r num">{formatBps(offer.account.premiumBps)}</td>
                  <td className="r num">{formatMusd(offer.account.coverage)}</td>
                  <td className="r num">{formatMusd(offer.account.premium)}</td>
                  <td className="r num">{formatMusd(offer.account.collateral)}</td>
                  <td>{market && <StatusPill state={marketDisplayState(market.account)} />}</td>
                  <td className="r">
                    <button
                      className="btn btn-down px-2 py-0.5"
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
        )}
      </Panel>

      <PositionsPanel title="Positions" rows={pf.positions} properties={properties} entries={buys.data} />
      <PositionsPanel title="Bought positions (secondary market)" rows={pf.bought} properties={properties} entries={buys.data} showEntry />
      <div>
        <ReplayLabel />
      </div>
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
        <Empty>None.</Empty>
      ) : (
        <table className="dense">
          <thead>
            <tr>
              <th>Market</th>
              <th>Side</th>
              <th className="r">Coverage (payout if you win)</th>
              <th className="r">Rate</th>
              <th>Market status</th>
              <th>Position</th>
              {showEntry && <th className="r">Entry price</th>}
              <th className="r">Realized P&amp;L</th>
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
                    <Link className="text-info hover:underline" href={`/market/${p.market.publicKey.toBase58()}`}>
                      {propertyLabel(p.market.account.propertyId, properties)}
                    </Link>
                  </td>
                  <td>
                    <Pill tone={p.side === "Protection" ? "up" : "warn"}>{p.side}</Pill>
                    {p.bought && <span className="ml-1 text-[10px] text-faint">bought</span>}
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
                  {showEntry && <td className="r num">{entry !== undefined ? formatMusd(entry) : "unknown"}</td>}
                  <td className={`r num ${pnl !== null && pnl > 0n ? "text-up" : pnl !== null && pnl < 0n ? "text-down" : ""}`}>
                    {pnl === null ? "—" : formatSignedMusd(pnl)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
