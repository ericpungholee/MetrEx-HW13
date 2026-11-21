"use client";

// Create (spec §3.1 item 2): choose a registered property, enter coverage.
import { decodeLabel, MAX_COVERAGE_TARGET, MIN_COVERAGE } from "@metrex/shared";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PerimeterMap } from "@/components/PerimeterMap";
import { useTx } from "@/components/TxProvider";
import { Empty, ErrorLine, PageHeader, ReplayLabel, scenarioName, TriggerWording } from "@/components/ui";
import { createMarket, fetchProperties, requireSigner, USE_FIXTURES } from "@/lib/client";
import { formatE6, formatMusd, parseMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

export default function CreatePage() {
  const props = usePoll(fetchProperties, [], 15_000);
  const wallet = useWalletSigner();
  const { setVisible } = useWalletModal();
  const { run } = useTx();
  const router = useRouter();
  const [selected, setSelected] = useState<number | null>(null);
  const [coverageText, setCoverageText] = useState("10000");
  const [busy, setBusy] = useState(false);

  const list = props.data ?? [];
  const sel = list.find((p) => p.account.propertyId === selected) ?? list[0];
  const coverage = parseMusd(coverageText);
  const coverageError =
    coverage === null
      ? "Enter an amount in mUSD"
      : coverage < MIN_COVERAGE
        ? `Minimum is ${formatMusd(MIN_COVERAGE, 0)} mUSD`
        : coverage > MAX_COVERAGE_TARGET
          ? `Maximum is ${formatMusd(MAX_COVERAGE_TARGET, 0)} mUSD`
          : null;

  const points = useMemo(
    () =>
      list.map((p) => ({
        key: String(p.account.propertyId),
        lat: p.account.latE6 / 1e6,
        lon: p.account.lonE6 / 1e6,
        label: decodeLabel(p.account.label),
        radiusM: p.account.triggerDistanceM,
        selected: sel ? p.account.propertyId === sel.account.propertyId : false,
      })),
    [list, sel],
  );

  async function submit() {
    if (!sel || coverage === null || coverageError) return;
    if (!wallet && !USE_FIXTURES) {
      setVisible(true);
      return;
    }
    setBusy(true);
    let marketKey: string | null = null;
    const res = await run(`Create market · ${decodeLabel(sel.account.label)}`, async (opts) => {
      const r = await createMarket(requireSigner(wallet), sel.account.propertyId, coverage, opts);
      marketKey = r.market.toBase58();
      return r.results;
    });
    setBusy(false);
    if (res && marketKey) router.push(`/market/${marketKey}`);
  }

  return (
    <div className="animate-in mx-auto max-w-3xl space-y-10">
      <PageHeader
        title="Create a market"
        description="List a property’s wildfire risk. Underwriters compete to cover it with fully collateralized offers."
      />

      <ErrorLine error={props.error} />

      <section>
        <h2 className="mb-4 text-xs font-medium tracking-wide text-faint uppercase">Property</h2>
        {props.loading && <Empty>Loading properties…</Empty>}
        {props.data && list.length === 0 && <Empty>No properties registered on this network yet.</Empty>}
        <div className="space-y-1">
          {list.map((p) => {
            const active = sel?.account.propertyId === p.account.propertyId;
            return (
              <label
                key={p.publicKey.toBase58()}
                className={`flex cursor-pointer items-start gap-4 border-b border-line px-1 py-4 transition-colors last:border-b-0 ${active ? "bg-bg-soft" : "hover:bg-bg-soft/50"}`}
              >
                <input
                  type="radio"
                  name="property"
                  checked={active}
                  onChange={() => setSelected(p.account.propertyId)}
                  className="mt-1.5 accent-ink"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-semibold tracking-tight">{decodeLabel(p.account.label)}</div>
                  <div className="mt-1 text-sm text-dim">
                    {scenarioName(p.account.scenarioId)} · {p.account.triggerDistanceM} m trigger ·{" "}
                    <span className="num">
                      {formatE6(p.account.latE6)}, {formatE6(p.account.lonE6)}
                    </span>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        {list.length > 0 && (
          <div className="mt-6">
            <PerimeterMap points={points} height={280} onSelect={(k) => setSelected(Number(k))} />
          </div>
        )}
      </section>

      <section className="space-y-5 border-t border-line pt-10">
        <h2 className="text-xs font-medium tracking-wide text-faint uppercase">Coverage</h2>
        <div>
          <label className="text-sm text-dim">Amount requested (mUSD)</label>
          <input
            className="input mt-2 text-2xl font-medium tracking-tight"
            inputMode="decimal"
            value={coverageText}
            onChange={(e) => setCoverageText(e.target.value)}
          />
          <div className="mt-2 h-5 text-sm text-down">{coverageError}</div>
        </div>

        <div className="space-y-3 bg-bg-soft px-5 py-5">
          <ReplayLabel />
          <TriggerWording />
        </div>

        <button
          className="btn btn-primary w-full py-3.5 text-base"
          disabled={busy || !sel || !!coverageError}
          onClick={submit}
        >
          {busy ? "Creating…" : wallet || USE_FIXTURES ? "Create market" : "Connect wallet"}
        </button>
      </section>
    </div>
  );
}
