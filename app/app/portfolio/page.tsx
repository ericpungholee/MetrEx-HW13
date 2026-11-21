"use client";

// Portfolio (spec §3.1 item 4, §10.4): balance, open offers, locked collateral, positions,
// gross exposure per scenario, original premiums, and claimable coverage.
import { useWalletSigner } from "@/lib/useWalletSigner";
import type { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useMemo } from "react";
import { useTx } from "@/components/TxProvider";
import { Empty, ErrorLine, Musd, Panel, Pill, ReplayLabel, scenarioName, Stat, StatusPill } from "@/components/ui";
import {
  cancelOffer,
  claimablePositions,
  claimAll,
  fetchExchange,
  fetchMusdBalance,
  requireSigner,
  USE_FIXTURES,
  viewerFor,
} from "@/lib/client";
import { computePortfolio, propertyLabel, type PositionRow } from "@/lib/derive";
import { formatBps, formatMusd, shortKey } from "@/lib/format";
import { marketDisplayState } from "@metrex/shared";
import { usePoll } from "@/lib/usePoll";

export default function PortfolioPage() {
  const wallet = useWalletSigner();
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
  const wallet = useWalletSigner();
  const { run } = useTx();
  const ex = usePoll(fetchExchange, []);
  const balance = usePoll(() => fetchMusdBalance(viewer), [viewer.toBase58()]);
  const pf = useMemo(() => (ex.data ? computePortfolio(viewer, ex.data.markets, ex.data.offers) : null), [ex.data, viewer]);
  const claimable = useMemo(
    () => (ex.data ? claimablePositions(viewer, ex.data.markets, ex.data.offers) : []),
    [ex.data, viewer],
  );

  if (ex.loading) return <Empty>Loading portfolio from chain…</Empty>;
  if (!pf || !ex.data) return <ErrorLine error={ex.error} />;
  const properties = ex.data.properties;

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

      <section className="grid grid-cols-2 gap-3 rounded border border-line bg-panel p-4 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="mUSD balance">{balance.data !== undefined ? formatMusd(balance.data) : "…"}</Stat>
        <Stat label="Locked collateral">{formatMusd(pf.lockedCollateral)}</Stat>
        <Stat label="Open offers">{pf.openOffers.length}</Stat>
        <Stat label="Active positions">{pf.positions.filter((p) => p.status === "active").length}</Stat>
        <Stat label="Total exposure">{formatMusd(pf.totalExposure)}</Stat>
        <Stat label="Original premiums booked / paid">
          {formatMusd(pf.premiumsBooked, 0)} / {formatMusd(pf.premiumsPaid, 0)}
        </Stat>
        <Stat label="Claimable">
          <span className={pf.claimable > 0n ? "text-up" : ""}>{formatMusd(pf.claimable)}</span>
        </Stat>
      </section>

      <Panel title="Exposure per scenario">
        {pf.exposureByScenario.size === 0 ? (
          <Empty>No active positions.</Empty>
        ) : (
          <table className="dense">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="r">Positions</th>
                <th className="r">Risk side coverage at stake</th>
                <th className="r">Protection side coverage</th>
              </tr>
            </thead>
            <tbody>
              {[...pf.exposureByScenario.entries()].map(([sid, e]) => (
                <tr key={sid}>
                  <td>{scenarioName(sid)}</td>
                  <td className="r num">{e.positions}</td>
                  <td className="r num text-down">{formatMusd(e.risk)}</td>
                  <td className="r num text-up">{formatMusd(e.protection)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-faint">
          Exposure sums the coverage of your current positions in unresolved markets. Nearby and duplicate properties can trigger together.
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

      <PositionsPanel title="Positions" rows={pf.positions} properties={properties} />
      <p className="text-xs text-dim">Portfolio P&amp;L requires complete trade and settlement history.</p>
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
}: {
  title: string;
  rows: PositionRow[];
  properties: Parameters<typeof propertyLabel>[1];
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
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
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
                </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
