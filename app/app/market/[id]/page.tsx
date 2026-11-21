"use client";

// Market page (spec §3.1 item 3, §10): header, risk info, funding, order book, offer form,
// homeowner "Accept selected", positions with holders and listings (Tier 2), claim all, activity.
import {
  computeOfferTerms,
  marketStatusOf,
  MAX_BPS,
  MIN_BPS,
  MIN_COVERAGE,
  offerStatusOf,
  Side,
  type ListingAccount,
  type OfferAccount,
} from "@metrex/shared";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PerimeterMap } from "@/components/PerimeterMap";
import { useTx } from "@/components/TxProvider";
import {
  AddressLink,
  Empty,
  ErrorLine,
  FundingBar,
  Musd,
  Panel,
  Pill,
  ReplayLabel,
  scenarioName,
  Stat,
  StatusPill,
  TriggerWording,
} from "@/components/ui";
import {
  acceptOffers,
  buyPosition,
  cancelListing,
  cancelOffer,
  claimablePositions,
  claimAll,
  fetchMarketSnapshot,
  refundVoidedOffer,
  fetchMusdBalance,
  listPosition,
  placeOffer,
  requireSigner,
  USE_FIXTURES,
  viewerFor,
  type Keyed,
} from "@/lib/client";
import { isDefaultKey, listingFor, summarizeMarket } from "@/lib/derive";
import {
  explorerAddress,
  formatBps,
  formatE6,
  formatMusd,
  formatRatio,
  formatUnix,
  isZeroBytes,
  parseMusd,
  parsePercentToBps,
  timeAgo,
  toBig,
  toHex,
} from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

function parseKey(s: string | undefined): PublicKey | null {
  try {
    return s ? new PublicKey(s) : null;
  } catch {
    return null;
  }
}

const TRADING_ENABLED = process.env.NEXT_PUBLIC_ENABLE_TIER2 === "1";

export default function MarketPage() {
  const params = useParams<{ id: string }>();
  const marketKey = useMemo(() => parseKey(params?.id), [params?.id]);
  if (!marketKey) return <ErrorLine error="That isn't a valid market address." />;
  return <MarketView marketKey={marketKey} />;
}

function MarketView({ marketKey }: { marketKey: PublicKey }) {
  const wallet = useWalletSigner();
  const viewer = viewerFor(wallet?.publicKey);
  const { run } = useTx();
  const snap = usePoll(() => fetchMarketSnapshot(marketKey), [marketKey.toBase58()]);
  const balance = usePoll(async () => (viewer ? fetchMusdBalance(viewer) : null), [viewer?.toBase58()]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const data = snap.data;
  const market = data?.market ?? null;
  const summary = useMemo(
    () => (market && data ? summarizeMarket(market, data.offers, data.property ? [data.property] : []) : null),
    [market, data],
  );

  // Drop selections for offers that are no longer open.
  useEffect(() => {
    if (!summary) return;
    const open = new Set(summary.openOffers.map((o) => o.publicKey.toBase58()));
    setSelected((s) => {
      const next = new Set([...s].filter((k) => open.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [summary]);

  if (snap.loading) return <Empty>Loading market from chain…</Empty>;
  if (!market || !summary || !data) {
    return (
      <div className="space-y-3">
        <ErrorLine error={snap.error} />
        <Empty>Market not found on this cluster.</Empty>
      </div>
    );
  }

  const m = market.account;
  const status = marketStatusOf(m.status);
  const isOpen = status === "open";
  const tradable = TRADING_ENABLED && status === "open";
  const isHomeowner = !!viewer && m.homeowner.equals(viewer);

  const selectedOffers = summary.openOffers.filter((o) => selected.has(o.publicKey.toBase58()));
  const selectedCoverage = selectedOffers.reduce((s, o) => s + toBig(o.account.coverage), 0n);
  const selectedPremium = selectedOffers.reduce((s, o) => s + toBig(o.account.premium), 0n);
  const claimable = viewer ? claimablePositions(viewer, [market], data.offers) : [];
  const claimableTotal = claimable.reduce((s, p) => s + toBig(p.offer.account.coverage), 0n);

  function toggle(o: Keyed<OfferAccount>) {
    const key = o.publicKey.toBase58();
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function doAccept() {
    setBusy(true);
    const r = await run(`Accept ${selectedOffers.length} offer(s)`, (opts) =>
      acceptOffers(requireSigner(wallet), marketKey, selectedOffers, opts),
    );
    setBusy(false);
    if (r) setSelected(new Set());
    snap.refresh();
  }

  async function doClaim() {
    setBusy(true);
    await run(`Claim ${claimable.length} position(s)`, (opts) => claimAll(requireSigner(wallet), claimable, opts));
    setBusy(false);
    snap.refresh();
    balance.refresh();
  }

  async function doCancel(o: Keyed<OfferAccount>) {
    await run("Cancel offer", (opts) => cancelOffer(requireSigner(wallet), o, opts));
    snap.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-dim">
        <Link href="/" className="hover:text-ink">
          Exchange
        </Link>{" "}
        / <span className="num">{marketKey.toBase58()}</span>
      </div>

      {/* Header */}
      <section className="rounded border border-line bg-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">{summary.label}</h1>
              <StatusPill state={summary.display} />
            </div>
            <div className="mt-1 text-xs text-dim">
              Wildfire within {m.triggerDistanceM} m · {scenarioName(m.scenarioId)} · Property #{m.propertyId} ·{" "}
              <a className="text-info hover:underline" href={explorerAddress(marketKey)} target="_blank" rel="noreferrer">
                market account ↗
              </a>
            </div>
            <div className="mt-2">
              <ReplayLabel />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
            <Stat label="Requested">{formatMusd(summary.target)}</Stat>
            <Stat label="Activated">{formatMusd(summary.activated)}</Stat>
            <Stat label="Premium paid">{formatMusd(summary.premiumTotal)}</Stat>
            <Stat label="Collateral locked">{formatMusd(summary.collateralTotal)}</Stat>
          </div>
        </div>
        <div className="mt-3 rounded border border-line bg-bg p-3">
          <TriggerWording />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <FundingBar activated={summary.activated} target={summary.remaining} pending={isHomeowner ? selectedCoverage : 0n} />
          <span className="num w-56 shrink-0 text-right text-xs text-dim">
            {formatMusd(summary.activated, 0)} / {formatMusd(summary.target, 0)} ({formatRatio(summary.activated, summary.target)})
          </span>
        </div>
        <div className="mt-1 text-[11px] text-faint">
          Escrow on accepted positions: <span className="num">{formatMusd(summary.premiumTotal + summary.collateralTotal)} mUSD</span>{" "}
          (premium + collateral = coverage, per position)
        </div>
      </section>

      {claimable.length > 0 && (
        <div className="flex items-center justify-between rounded border border-up/50 bg-up/10 px-4 py-3">
          <div>
            <div className="font-semibold text-up">You can claim {claimable.length} position(s)</div>
            <div className="num text-xs">{formatMusd(claimableTotal)} mUSD from escrow</div>
          </div>
          <button className="btn btn-up" disabled={busy} onClick={doClaim}>
            Claim all · 1 signature
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        {/* Order book */}
        <Panel
          title={`Order book · ${summary.openOffers.length} open offer(s)`}
          right={<span className="text-[10px] text-faint">sorted by premium rate, ascending</span>}
        >
          {summary.openOffers.length === 0 ? (
            <Empty>No open offers.</Empty>
          ) : (
            <table className="dense">
              <thead>
                <tr>
                  {isHomeowner && isOpen && <th />}
                  <th className="r">Rate</th>
                  <th className="r">Coverage</th>
                  <th className="r">Premium</th>
                  <th className="r">Collateral</th>
                  <th>Underwriter</th>
                  <th>Placed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {summary.openOffers.map((o) => {
                  const key = o.publicKey.toBase58();
                  const checked = selected.has(key);
                  const fits = selectedCoverage + toBig(o.account.coverage) <= summary.remaining;
                  const mine = !!viewer && o.account.underwriter.equals(viewer);
                  return (
                    <tr key={key} className={checked ? "bg-info/10" : ""}>
                      {isHomeowner && isOpen && (
                        <td>
                          <input
                            type="checkbox"
                            className="accent-[#4ea1ff]"
                            checked={checked}
                            disabled={!checked && !fits}
                            title={!checked && !fits ? "Would exceed the requested coverage" : undefined}
                            onChange={() => toggle(o)}
                          />
                        </td>
                      )}
                      <td className="r num font-semibold text-up">{formatBps(o.account.premiumBps)}</td>
                      <td className="r num">{formatMusd(o.account.coverage)}</td>
                      <td className="r num">{formatMusd(o.account.premium)}</td>
                      <td className="r num text-dim">{formatMusd(o.account.collateral)}</td>
                      <td>
                        <AddressLink address={o.account.underwriter} you={viewer} />
                      </td>
                      <td className="num text-dim">{timeAgo(o.account.createdAt.toNumber())}</td>
                      <td className="r">
                        <a className="text-info hover:underline" href={explorerAddress(o.publicKey)} target="_blank" rel="noreferrer">
                          offer ↗
                        </a>
                        {mine && (
                          <button className="btn btn-down ml-2 px-2 py-0.5" onClick={() => doCancel(o)}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {isHomeowner && isOpen && summary.openOffers.length > 0 && (
            <div className="mt-3 flex items-center justify-between rounded border border-line bg-bg px-3 py-2">
              <div className="num text-xs">
                Selected {selectedOffers.length} · coverage {formatMusd(selectedCoverage)} · premium you pay{" "}
                <span className="text-warn">{formatMusd(selectedPremium)}</span> mUSD · remaining after{" "}
                {formatMusd(summary.remaining - selectedCoverage)}
                {balance.data != null && balance.data < selectedPremium && (
                  <span className="ml-2 text-down">insufficient mUSD balance</span>
                )}
              </div>
              <button className="btn btn-primary" disabled={busy || selectedOffers.length === 0 || selectedCoverage > summary.remaining || (balance.data != null && balance.data < selectedPremium)} onClick={doAccept}>
                Accept selected
              </button>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          {isOpen && !isHomeowner && summary.remaining >= MIN_COVERAGE && (
            <OfferForm
              marketKey={marketKey}
              target={summary.remaining}
              balance={balance.data ?? null}
              onPlaced={() => {
                snap.refresh();
                balance.refresh();
              }}
            />
          )}
          {isOpen && isHomeowner && (
            <Panel title="Homeowner">
              <p className="text-xs text-dim">
                You created this market. Select offers within the remaining coverage. You pay each accepted offer&apos;s premium. The underwriter&apos;s collateral is already escrowed.
              </p>
            </Panel>
          )}
          {!isOpen && (
            <Panel title="Offers">
              <p className="text-xs text-dim">This market is no longer accepting offers ({summary.display}).</p>
            </Panel>
          )}
          <Panel title="Risk">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Scenario">{scenarioName(m.scenarioId)}</Stat>
              <Stat label="Trigger distance">{m.triggerDistanceM} m</Stat>
              <Stat label="Point (approx.)">
                {formatE6(m.latE6)}, {formatE6(m.lonE6)}
              </Stat>
              <Stat label="Homeowner">
                <AddressLink address={m.homeowner} you={viewer} />
              </Stat>
              <Stat label="Created">{formatUnix(m.createdAt)}</Stat>
              <Stat label="Closed">{formatUnix(m.closedAt)}</Stat>
              <Stat label="Resolved">{formatUnix(m.resolvedAt)}</Stat>
              <Stat label="Evidence hash">
                {isZeroBytes(m.evidenceHash) ? "—" : <span title={toHex(m.evidenceHash)}>{toHex(m.evidenceHash).slice(0, 16)}…</span>}
              </Stat>
            </div>
            <div className="mt-3">
              <PerimeterMap
                height={200}
                settledMarket={status === "resolvedYes" || status === "resolvedNo" ? marketKey.toBase58() : undefined}
                points={[
                  {
                    key: "m",
                    lat: m.latE6 / 1e6,
                    lon: m.lonE6 / 1e6,
                    label: summary.label,
                    radiusM: m.triggerDistanceM,
                    selected: true,
                  },
                ]}
              />
            </div>
          </Panel>
        </div>
      </div>

      <PositionsTable
        offers={summary.acceptedOffers}
        listings={data.listings}
        viewer={viewer}
        tradable={tradable}
        voided={status === "voided"}
        onChange={() => {
          snap.refresh();
          balance.refresh();
        }}
      />

      <ActivityFeed address={marketKey} />
      {USE_FIXTURES && <p className="text-center text-[11px] text-fixture">Fixture mode: transactions disabled</p>}
    </div>
  );
}

function OfferForm({
  marketKey,
  target,
  balance,
  onPlaced,
}: {
  marketKey: PublicKey;
  target: bigint;
  balance: bigint | null;
  onPlaced: () => void;
}) {
  const wallet = useWalletSigner();
  const { run } = useTx();
  const [coverageText, setCoverageText] = useState("1000");
  const [rateText, setRateText] = useState("4.50");
  const [busy, setBusy] = useState(false);

  const coverage = parseMusd(coverageText);
  const bps = parsePercentToBps(rateText);
  let error: string | null = null;
  let terms: ReturnType<typeof computeOfferTerms> | null = null;
  if (coverage === null) error = "Enter coverage in mUSD";
  else if (bps === null) error = "Enter a rate like 4.25 (whole basis points)";
  else if (bps < MIN_BPS || bps > MAX_BPS) error = "Rate must be between 0.01% and 99.99%";
  else if (coverage < MIN_COVERAGE) error = `Minimum coverage is ${formatMusd(MIN_COVERAGE, 0)} mUSD`;
  else if (coverage > target) error = "Coverage exceeds the remaining capacity";
  else {
    terms = computeOfferTerms(coverage, bps);
    if (terms.premium < 1n) error = "Premium rounds to zero. Increase coverage or rate.";
  }
  const short = terms && balance !== null && balance < terms.collateral;

  async function submit() {
    if (!terms || error || bps === null) return;
    setBusy(true);
    await run(`Place offer · ${formatBps(bps)}`, async (opts) => {
      const r = await placeOffer(requireSigner(wallet), marketKey, terms!.coverage, bps, opts);
      return r.results;
    });
    setBusy(false);
    onPlaced();
  }

  return (
    <Panel title="Underwrite">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-dim">Coverage (mUSD)</label>
          <input className="input mt-1" inputMode="decimal" value={coverageText} onChange={(e) => setCoverageText(e.target.value)} />
        </div>
        <div>
          <label className="text-[11px] text-dim">Premium rate (%)</label>
          <input className="input mt-1" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded border border-line bg-bg p-2">
        <Stat label="Premium if Risk wins">{terms ? formatMusd(terms.premium) : "—"}</Stat>
        <Stat label="You lock (collateral)">{terms ? formatMusd(terms.collateral) : "—"}</Stat>
        <Stat label="Escrow if accepted">{terms ? formatMusd(terms.coverage) : "—"}</Stat>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        premium = floor(coverage × bps / 10,000), collateral = coverage − premium; computed on-chain. If the trigger fires you lose
        the collateral; if not you get coverage back (collateral + premium).
      </p>
      <div className="mt-1 h-4 text-[11px] text-down">{error ?? (short ? "Not enough mUSD for the collateral" : "")}</div>
      <button className="btn btn-primary mt-1 w-full justify-center" disabled={busy || !!error || !terms || !!short} onClick={submit}>
        {busy ? "Placing…" : "Place offer (locks collateral)"}
      </button>
    </Panel>
  );
}

function PositionsTable({
  offers,
  listings,
  viewer,
  tradable,
  voided,
  onChange,
}: {
  offers: Keyed<OfferAccount>[];
  listings: Keyed<ListingAccount>[];
  viewer: PublicKey | null;
  tradable: boolean;
  voided: boolean;
  onChange: () => void;
}) {
  const wallet = useWalletSigner();
  const { run } = useTx();
  const [draft, setDraft] = useState<{ offer: string; side: Side; price: string } | null>(null);

  async function doList(o: Keyed<OfferAccount>, side: Side, priceText: string) {
    const price = parseMusd(priceText);
    if (price === null || price < 1n) return;
    const r = await run(`List ${side === Side.Protection ? "Protection" : "Risk"} side`, (opts) =>
      listPosition(requireSigner(wallet), o, side, price, opts),
    );
    if (r) setDraft(null);
    onChange();
  }

  async function doBuy(l: Keyed<ListingAccount>, o: Keyed<OfferAccount>) {
    await run(`Buy ${l.account.side === Side.Protection ? "Protection" : "Risk"} side`, (opts) =>
      buyPosition(requireSigner(wallet), l, o, opts),
    );
    onChange();
  }

  async function doCancelListing(l: Keyed<ListingAccount>) {
    await run("Cancel listing", (opts) => cancelListing(requireSigner(wallet), l, opts));
    onChange();
  }

  function sideCell(o: Keyed<OfferAccount>, side: Side) {
    const holder = side === Side.Protection ? o.account.protectionHolder : o.account.riskHolder;
    const opposite = side === Side.Protection ? o.account.riskHolder : o.account.protectionHolder;
    const candidate = listingFor(listings, o.publicKey, side);
    const listing = candidate?.account.seller.equals(holder) ? candidate : undefined;
    const accepted = offerStatusOf(o.account.status) === "accepted";
    const isHolder = !!viewer && holder.equals(viewer);
    const isDraft = tradable && accepted && draft && draft.offer === o.publicKey.toBase58() && draft.side === side;
    return (
      <td>
        <div className="flex items-center gap-2">
          {isDefaultKey(holder) ? <span className="text-faint">—</span> : <AddressLink address={holder} you={viewer} />}
          {listing && tradable && accepted && (
            <span className="num rounded-sm bg-warn/15 px-1.5 text-[11px] text-warn" title={`Listed by ${listing.account.seller.toBase58()}`}>
              for sale {formatMusd(listing.account.price)}
            </span>
          )}
        </div>
        {listing && tradable && accepted && (
          <p className="mt-1 text-[11px] text-dim">
            Max loss {formatMusd(listing.account.price)} · payout {formatMusd(o.account.coverage)} mUSD ·
            break-even {toBig(listing.account.price) > toBig(o.account.coverage)
              ? "unreachable"
              : formatBps(Number((toBig(listing.account.price) * 10_000n + toBig(o.account.coverage) - 1n) / toBig(o.account.coverage)))}
          </p>
        )}
        <div className="mt-1 flex items-center gap-1">
          {TRADING_ENABLED && candidate && viewer && candidate.account.seller.equals(viewer) && (
            <button className="btn px-2 py-0.5 text-[11px]" onClick={() => doCancelListing(candidate)}>
              Cancel listing
            </button>
          )}
          {listing && tradable && accepted && (!viewer || (!listing.account.seller.equals(viewer) && !opposite.equals(viewer))) && (
            <button className="btn btn-up px-2 py-0.5 text-[11px]" onClick={() => doBuy(listing, o)}>
              Buy · {formatMusd(listing.account.price)}
            </button>
          )}
          {!listing && isHolder && tradable && accepted && !isDraft && (
            <button
              className="btn px-2 py-0.5 text-[11px]"
              onClick={() => setDraft({ offer: o.publicKey.toBase58(), side, price: "" })}
            >
              List…
            </button>
          )}
          {isDraft && (
            <>
              <input
                className="input w-24 px-1 py-0.5 text-[11px]"
                placeholder="price mUSD"
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              />
              <button
                className="btn btn-primary px-2 py-0.5 text-[11px]"
                disabled={(parseMusd(draft.price) ?? 0n) < 1n}
                onClick={() => doList(o, side, draft.price)}
              >
                List
              </button>
              <button className="btn px-2 py-0.5 text-[11px]" onClick={() => setDraft(null)}>
                ×
              </button>
            </>
          )}
        </div>
      </td>
    );
  }

  return (
    <Panel
      title={`Positions · ${offers.length}`}
      right={<span className="text-[10px] text-faint">Protection receives escrow on YES · Risk receives escrow on NO</span>}
    >
      {offers.length === 0 ? (
        <Empty>No accepted positions yet.</Empty>
      ) : (
        <table className="dense">
          <thead>
            <tr>
              <th className="r">Coverage (escrow)</th>
              <th className="r">Rate</th>
              <th className="r">Premium</th>
              <th className="r">Collateral</th>
              <th>Protection holder</th>
              <th>Risk holder</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.publicKey.toBase58()} className="align-top">
                <td className="r num font-semibold">
                  <Musd value={o.account.coverage} />
                </td>
                <td className="r num">{formatBps(o.account.premiumBps)}</td>
                <td className="r num">{formatMusd(o.account.premium)}</td>
                <td className="r num text-dim">{formatMusd(o.account.collateral)}</td>
                {sideCell(o, Side.Protection)}
                {sideCell(o, Side.Risk)}
                <td>
                  <Pill tone={offerStatusOf(o.account.status) === "accepted" ? "info" : "dim"}>{offerStatusOf(o.account.status)}</Pill>
                  {voided && offerStatusOf(o.account.status) === "accepted" && wallet && (
                    <button className="btn ml-2 px-2 py-0.5 text-[11px]" onClick={async () => {
                      await run("Release refunds", (opts) => refundVoidedOffer(requireSigner(wallet), o, opts));
                      onChange();
                    }}>
                      Release refunds
                    </button>
                  )}
                </td>
                <td className="r">
                  <a className="text-info hover:underline" href={explorerAddress(o.publicKey)} target="_blank" rel="noreferrer">
                    offer ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
