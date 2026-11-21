"use client";

// Market page (spec §3.1 item 3, §10): header, risk, funding, order book, offer form,
// accept, positions, claim, activity.
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
  Callout,
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
  if (!marketKey) return <ErrorLine error="That isn’t a valid market address." />;
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

  useEffect(() => {
    if (!summary) return;
    const open = new Set(summary.openOffers.map((o) => o.publicKey.toBase58()));
    setSelected((s) => {
      const next = new Set([...s].filter((k) => open.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [summary]);

  if (snap.loading) return <Empty>Loading market…</Empty>;
  if (!market || !summary || !data) {
    return (
      <div className="space-y-4">
        <ErrorLine error={snap.error} />
        <Empty>Market not found.</Empty>
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
    <div className="animate-in space-y-12">
      <div className="text-sm text-dim">
        <Link href="/" className="hover:text-ink">
          Markets
        </Link>
        <span className="mx-2 text-faint">/</span>
        <span className="text-ink">{summary.label}</span>
      </div>

      {/* Hero */}
      <header className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{summary.label}</h1>
              <StatusPill state={summary.display} />
            </div>
            <p className="mt-2 text-[15px] text-dim">
              Within {m.triggerDistanceM} m · {scenarioName(m.scenarioId)}
            </p>
            <div className="mt-3">
              <ReplayLabel />
            </div>
          </div>
          <a
            className="text-sm text-dim underline-offset-2 hover:text-ink hover:underline"
            href={explorerAddress(marketKey)}
            target="_blank"
            rel="noreferrer"
          >
            View on Explorer
          </a>
        </div>

        <div className="grid grid-cols-2 gap-6 border-y border-line py-6 sm:grid-cols-4">
          <Stat large label="Requested">
            {formatMusd(summary.target)}
          </Stat>
          <Stat large label="Activated">
            {formatMusd(summary.activated)}
          </Stat>
          <Stat large label="Premium paid">
            {formatMusd(summary.premiumTotal)}
          </Stat>
          <Stat large label="Collateral">
            {formatMusd(summary.collateralTotal)}
          </Stat>
        </div>

        <div className="space-y-3">
          <TriggerWording />
          <div className="flex items-center gap-4">
            <FundingBar activated={summary.activated} target={summary.target} pending={isHomeowner ? selectedCoverage : 0n} />
            <span className="num shrink-0 text-sm text-dim">
              {formatMusd(summary.activated, 0)} / {formatMusd(summary.target, 0)} · {formatRatio(summary.activated, summary.target)}
            </span>
          </div>
        </div>
      </header>

      {claimable.length > 0 && (
        <Callout tone="up">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium text-up">Claim ready</div>
              <div className="num mt-0.5 text-sm text-ink-secondary">{formatMusd(claimableTotal)} mUSD across {claimable.length} position{claimable.length === 1 ? "" : "s"}</div>
            </div>
            <button className="btn btn-primary" disabled={busy} onClick={doClaim}>
              Claim all
            </button>
          </div>
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-12 xl:grid-cols-[1.5fr_1fr]">
        <Panel
          title={`Offers · ${summary.openOffers.length}`}
          right={summary.openOffers.length > 0 ? "Lowest rate first" : undefined}
        >
          {summary.openOffers.length === 0 ? (
            <Empty>No open offers.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="dense">
                <thead>
                  <tr>
                    {isHomeowner && isOpen && <th />}
                    <th className="r">Rate</th>
                    <th className="r">Coverage</th>
                    <th className="r">Premium</th>
                    <th className="r">Collateral</th>
                    <th>Underwriter</th>
                    <th>Age</th>
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
                      <tr key={key} className={checked ? "bg-bg-soft" : ""}>
                        {isHomeowner && isOpen && (
                          <td>
                            <input
                              type="checkbox"
                              className="accent-ink"
                              checked={checked}
                              disabled={!checked && !fits}
                              title={!checked && !fits ? "Would exceed requested coverage" : undefined}
                              onChange={() => toggle(o)}
                            />
                          </td>
                        )}
                        <td className="r num text-base font-semibold">{formatBps(o.account.premiumBps)}</td>
                        <td className="r num">{formatMusd(o.account.coverage)}</td>
                        <td className="r num">{formatMusd(o.account.premium)}</td>
                        <td className="r num text-dim">{formatMusd(o.account.collateral)}</td>
                        <td>
                          <AddressLink address={o.account.underwriter} you={viewer} />
                        </td>
                        <td className="num text-dim">{timeAgo(o.account.createdAt.toNumber())}</td>
                        <td className="r">
                          {mine && (
                            <button className="btn btn-down btn-sm" onClick={() => doCancel(o)}>
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {isHomeowner && isOpen && summary.openOffers.length > 0 && (
            <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-dim">
                {selectedOffers.length === 0 ? (
                  "Select offers to accept"
                ) : (
                  <>
                    <span className="num text-ink">{selectedOffers.length}</span> selected · coverage{" "}
                    <span className="num text-ink">{formatMusd(selectedCoverage)}</span> · you pay{" "}
                    <span className="num font-medium text-ink">{formatMusd(selectedPremium)}</span> mUSD
                    {balance.data != null && balance.data < selectedPremium && (
                      <span className="ml-2 text-down">Insufficient balance</span>
                    )}
                  </>
                )}
              </div>
              <button className="btn btn-primary" disabled={busy || selectedOffers.length === 0 || selectedCoverage > summary.remaining || (balance.data != null && balance.data < selectedPremium)} onClick={doAccept}>
                Accept selected
              </button>
            </div>
          )}
        </Panel>

        <div className="space-y-10">
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
            <Panel title="Your market">
              <p className="text-[15px] leading-relaxed text-dim">
                You created this market. Select offers within the remaining coverage. You pay each accepted offer&apos;s premium. The underwriter&apos;s collateral is already escrowed.
              </p>
            </Panel>
          )}
          {!isOpen && (
            <Panel title="Offers">
              <p className="text-[15px] text-dim">This market is no longer accepting offers.</p>
            </Panel>
          )}

          <Panel title="Event">
            <div className="grid grid-cols-2 gap-5">
              <Stat label="Scenario">{scenarioName(m.scenarioId)}</Stat>
              <Stat label="Trigger">{m.triggerDistanceM} m</Stat>
              <Stat label="Location">
                <span className="num text-sm">
                  {formatE6(m.latE6)}, {formatE6(m.lonE6)}
                </span>
              </Stat>
              <Stat label="Homeowner">
                <AddressLink address={m.homeowner} you={viewer} />
              </Stat>
              <Stat label="Created">{formatUnix(m.createdAt)}</Stat>
              <Stat label="Closed">{formatUnix(m.closedAt)}</Stat>
              <Stat label="Resolved">{formatUnix(m.resolvedAt)}</Stat>
              <Stat label="Evidence">
                {isZeroBytes(m.evidenceHash) ? "—" : <span className="num text-sm" title={toHex(m.evidenceHash)}>{toHex(m.evidenceHash).slice(0, 12)}…</span>}
              </Stat>
            </div>
            <div className="mt-5">
              <PerimeterMap
                height={220}
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
  else if (bps === null) error = "Enter a rate like 4.25";
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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-dim">Coverage (mUSD)</label>
          <input className="input mt-1.5" inputMode="decimal" value={coverageText} onChange={(e) => setCoverageText(e.target.value)} />
        </div>
        <div>
          <label className="text-sm text-dim">Premium rate (%)</label>
          <input className="input mt-1.5" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
        </div>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-4 border-y border-line py-4">
        <Stat label="Premium if Risk wins">{terms ? formatMusd(terms.premium) : "—"}</Stat>
        <Stat label="You lock">{terms ? formatMusd(terms.collateral) : "—"}</Stat>
        <Stat label="Escrow">{terms ? formatMusd(terms.coverage) : "—"}</Stat>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-faint">
        If the fire reaches the property, Protection claims the escrow. If not, Risk receives it.
      </p>
      <div className="mt-2 h-5 text-sm text-down">{error ?? (short ? "Not enough mUSD for collateral" : "")}</div>
      <button className="btn btn-primary mt-2 w-full py-3" disabled={busy || !!error || !terms || !!short} onClick={submit}>
        {busy ? "Placing…" : "Place offer"}
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
    const r = await run(`List ${side === Side.Protection ? "Protection" : "Risk"}`, (opts) =>
      listPosition(requireSigner(wallet), o, side, price, opts),
    );
    if (r) setDraft(null);
    onChange();
  }

  async function doBuy(l: Keyed<ListingAccount>, o: Keyed<OfferAccount>) {
    await run(`Buy ${l.account.side === Side.Protection ? "Protection" : "Risk"}`, (opts) =>
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
        <div className="flex flex-wrap items-center gap-2">
          {isDefaultKey(holder) ? <span className="text-faint">—</span> : <AddressLink address={holder} you={viewer} />}
          {listing && tradable && accepted && (
            <span className="num text-sm text-warn" title={`Listed by ${listing.account.seller.toBase58()}`}>
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
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {TRADING_ENABLED && candidate && viewer && candidate.account.seller.equals(viewer) && (
            <button className="btn btn-sm" onClick={() => doCancelListing(candidate)}>
              Cancel listing
            </button>
          )}
          {listing && tradable && accepted && (!viewer || (!listing.account.seller.equals(viewer) && !opposite.equals(viewer))) && (
            <button className="btn btn-primary btn-sm" onClick={() => doBuy(listing, o)}>
              Buy · {formatMusd(listing.account.price)}
            </button>
          )}
          {!listing && isHolder && tradable && accepted && !isDraft && (
            <button className="btn btn-sm" onClick={() => setDraft({ offer: o.publicKey.toBase58(), side, price: "" })}>
              List
            </button>
          )}
          {isDraft && (
            <>
              <input
                className="input w-28 px-2 py-1 text-sm"
                placeholder="Price"
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={(parseMusd(draft.price) ?? 0n) < 1n}
                onClick={() => doList(o, side, draft.price)}
              >
                Confirm
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </td>
    );
  }

  return (
    <Panel title={`Positions · ${offers.length}`} right="Protection wins on YES · Risk wins on NO">
      {offers.length === 0 ? (
        <Empty>No accepted positions yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
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
        </div>
      )}
    </Panel>
  );
}
