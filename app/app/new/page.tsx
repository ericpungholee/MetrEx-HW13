"use client";

// List your home (docs/spec-multiperil.md §7.7). A homeowner in one of the replay areas picks their
// address from the pinned home pool, then opens the market with a YES bid: the premium they offer
// for the coverage. The server registers the home and creates the market; the wallet signs the bid.
// Makers then quote around that price and simulated underwriters can sell into it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { QUOTE_PER_SHARE_BPS, type Hazard } from "@metrex/exchange";
import { buildOpeningBid, createListedMarket, fetchHoldings, fetchHomes, sendTrade, type HomeOption } from "@/lib/exchange-client";
import { formatPrice, parsePriceToBps } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { useTx } from "@/components/TxProvider";
import { ErrorLine, PageHeader } from "@/components/ui";

const HAZARDS: { id: Hazard; label: string }[] = [
  { id: "wildfire", label: "Wildfire" },
  { id: "hurricane", label: "Hurricane" },
  { id: "earthquake", label: "Earthquake" },
  { id: "tornado", label: "Tornado" },
];

function AddressPicker({ homes, value, onChange, disabled }: { homes: HomeOption[]; value: HomeOption | null; onChange: (h: HomeOption | null) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? homes.filter((h) => h.address.toLowerCase().includes(q)) : homes).slice(0, 8);
  }, [homes, query]);

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="address-options"
        aria-label="Your address"
        disabled={disabled}
        placeholder={`Search ${homes.length.toLocaleString()} addresses`}
        value={value && !open ? value.address : query}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (value) onChange(null);
        }}
        className="w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 text-ink placeholder:text-faint focus:border-ink focus:outline-none disabled:opacity-50"
      />
      {open && (
        <ul id="address-options" role="listbox" className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-bg shadow-lg">
          {matches.length === 0 && <li className="px-3 py-2.5 text-sm text-dim">No matching address</li>}
          {matches.map((h) => (
            <li key={h.propertyId} role="option" aria-selected={value?.propertyId === h.propertyId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(h);
                  setQuery(h.address);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-soft"
              >
                <span className="min-w-0">
                  <span className="block truncate text-ink">{h.address}</span>
                  <span className="block text-xs text-dim">{h.place}</span>
                </span>
                {h.market && <span className="shrink-0 rounded bg-bg-muted px-2 py-0.5 text-xs text-dim">Listed</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-ink">{label}</span>
        {hint && <span className="text-xs text-dim">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputCls = "num w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 text-ink focus:border-ink focus:outline-none";

export default function ListYourHome() {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const signer = useWalletSigner();
  const { run } = useTx();
  const [hazard, setHazard] = useState<Hazard>("wildfire");
  const data = usePoll(() => fetchHomes(hazard), [hazard], 15_000);
  const [home, setHome] = useState<HomeOption | null>(null);
  const [coverageText, setCoverageText] = useState("10000");
  const [priceText, setPriceText] = useState("");
  const [step, setStep] = useState<null | "create" | "sign">(null);
  const [error, setError] = useState<string | null>(null);

  const d = data.data?.hazard === hazard ? data.data : undefined;
  // Default the premium price to the hazard's starting quote once per hazard.
  useEffect(() => {
    if (d?.suggestedBps) setPriceText(formatPrice(d.suggestedBps).replace("¢", ""));
  }, [d?.hazard, d?.suggestedBps]);

  const live = home ? (d?.homes.find((h) => h.propertyId === home.propertyId) ?? home) : null;
  const coverage = /^\d{1,7}$/.test(coverageText.replace(/[,\s]/g, "")) ? BigInt(coverageText.replace(/[,\s]/g, "")) : 0n;
  const priceBps = parsePriceToBps(priceText);
  const premium = priceBps !== null ? coverage * BigInt(priceBps) * QUOTE_PER_SHARE_BPS : null;
  const open = d?.round?.state === "open";
  const ready = !!live && !live.market && coverage > 0n && priceBps !== null && open && step === null;

  async function create() {
    if (!live || priceBps === null || premium === null) return;
    if (!publicKey || !signer) return setVisible(true);
    setError(null);
    try {
      const { musd } = await fetchHoldings(publicKey, []);
      if (musd < premium) throw new Error(`The premium is ${formatMusd(premium)} mUSD and this wallet has ${formatMusd(musd)}. Use Get mUSD in the header.`);
      setStep("create");
      const { market } = await createListedMarket(live.propertyId);
      setStep("sign");
      const { ixs } = await buildOpeningBid(publicKey, market, coverage, priceBps);
      const res = await run(`Bid ${formatPrice(priceBps)} for ${coverage.toLocaleString()} YES`, (opts) => sendTrade(signer, ixs, opts));
      if (res) return router.push(`/market/${market}`);
      setStep(null);
      setError("The market was created but the bid was not placed. Open the market to place it.");
      data.refresh?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(null);
      data.refresh?.();
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="List your home" />

      <div role="tablist" aria-label="Hazard" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {HAZARDS.map((h) => {
          const active = h.id === hazard;
          return (
            <button
              key={h.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={step !== null}
              onClick={() => {
                setHazard(h.id);
                setHome(null);
                setError(null);
              }}
              className={`rounded-md border px-3 py-2.5 text-sm font-medium transition-colors ${
                active ? "border-ink bg-ink text-bg" : "border-line text-ink-secondary hover:border-line-strong hover:bg-bg-soft"
              }`}
            >
              {h.label}
            </button>
          );
        })}
      </div>

      {data.error && !d && <ErrorLine error={`Unavailable: ${data.error}`} />}
      {!d && !data.error && <div className="h-72 animate-pulse rounded-lg bg-bg-soft" aria-label="Loading" />}

      {d && (
        <div className="space-y-5">
          <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2 text-sm">
            <span className="text-ink-secondary">{d.trigger}</span>
            <span className="text-dim">{d.month}</span>
          </div>

          <Field label="Your address">
            <AddressPicker key={hazard} homes={d.homes} value={home} onChange={setHome} disabled={step !== null} />
          </Field>

          {live?.market && (
            <div className="flex items-center justify-between gap-4 rounded-md bg-bg-soft px-4 py-3 text-sm">
              <span className="text-ink-secondary">This home already has a market.</span>
              <Link href={`/market/${live.market}`} className="font-medium text-ink underline-offset-2 hover:underline">
                Open it
              </Link>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Coverage" hint="mUSD paid if triggered">
              <input className={inputCls} inputMode="numeric" value={coverageText} onChange={(e) => setCoverageText(e.target.value)} disabled={step !== null} />
            </Field>
            <Field label="Price per share" hint={d.suggestedBps ? `Suggested ${formatPrice(d.suggestedBps)}` : undefined}>
              <div className="relative">
                <input className={`${inputCls} pr-8`} inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} disabled={step !== null} />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-dim">¢</span>
              </div>
            </Field>
          </div>

          <div className="flex items-baseline justify-between border-t border-line pt-4">
            <span className="text-sm text-dim">Premium</span>
            <span className="num text-2xl font-medium tracking-tight text-ink">
              {premium !== null ? formatMusd(premium) : "—"} <span className="text-base text-faint">mUSD</span>
            </span>
          </div>

          <ErrorLine error={error} />

          <div className="flex items-center justify-end gap-3">
            {!open && <span className="text-sm text-dim">Trading has ended for {d.label.toLowerCase()}</span>}
            <button type="button" className="btn btn-primary" disabled={publicKey ? !ready : step !== null} aria-busy={step !== null} onClick={create}>
              {step === "create" ? "Creating market…" : step === "sign" ? "Confirm in wallet…" : publicKey ? "Create market" : "Connect wallet"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
