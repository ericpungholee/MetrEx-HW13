"use client";

// §10.3 wallet panel: holdings, available and reserved balances (from the wallet's own orders),
// open orders with cancel, recent fills, and redeem (sweeps + redeem in one transaction).
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { OrderSide } from "@metrex/exchange";
import {
  buildRedeem,
  cancelOrder,
  redemptionValue,
  reservedOf,
  sendRedeem,
  USE_FIXTURES,
  type MarketSummary,
  type TradeInfo,
  type WalletOrder,
} from "@/lib/exchange-client";
import { formatPrice, formatShares, outcomeName, sideName } from "@/lib/exchange-format";
import { formatMusd } from "@/lib/format";
import { useWalletSigner } from "@/lib/useWalletSigner";
import { useTx } from "@/components/TxProvider";
import { Stat, TxLink } from "@/components/ui";

export function WalletPanel({
  market,
  have,
  orders,
  trades,
  onDone,
}: {
  market: MarketSummary;
  have: { musd: bigint; yes: bigint; no: bigint } | null;
  orders: WalletOrder[] | undefined;
  trades: TradeInfo[] | undefined;
  onDone: () => void;
}) {
  const { publicKey } = useWallet();
  const signer = useWalletSigner();
  const { run } = useTx();
  const [busy, setBusy] = useState<string | null>(null);
  if (!publicKey) return <div className="py-4 text-sm text-dim">Connect a wallet.</div>;

  const mine = (orders ?? []).filter((o) => o.market === market.address);
  const reserved = reservedOf(mine);
  const me = publicKey.toBase58();
  const fills = (trades ?? []).filter((t) => t.buyer === me || t.seller === me).slice(0, 10);
  const resolved = market.outcome !== "unresolved";
  const swept = { yes: 0n, no: 0n };
  for (const o of mine) if (o.side === OrderSide.Sell) swept[o.outcome === 0 ? "yes" : "no"] += o.remainingQty;
  const claim = have ? redemptionValue(market.outcome, have.yes + swept.yes, have.no + swept.no) : 0n;

  async function cancel(o: WalletOrder) {
    if (!signer) return;
    setBusy(o.address);
    try {
      const r = await run(`Cancel ${sideName(o.side).toLowerCase()} ${outcomeName(o.outcome)} @ ${formatPrice(o.priceBps)}`, (opts) => cancelOrder(signer, market, o, opts));
      if (r) onDone();
    } finally {
      setBusy(null);
    }
  }

  async function redeem() {
    if (!signer || !publicKey || !have) return;
    setBusy("redeem");
    try {
      const ixs = await buildRedeem(publicKey, market, mine, have);
      const r = await run(`Redeem ${formatMusd(claim)} mUSD`, (opts) => sendRedeem(signer, ixs, opts));
      if (r) onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="YES">{have ? formatShares(have.yes) : "—"}</Stat>
        <Stat label="NO">{have ? formatShares(have.no) : "—"}</Stat>
        <Stat label="mUSD">{have ? formatMusd(have.musd) : "—"}</Stat>
        <Stat label="Reserved">
          {formatMusd(reserved.musd)}{reserved.yes ? ` · ${formatShares(reserved.yes)} Y` : ""}
          {reserved.no ? ` · ${formatShares(reserved.no)} N` : ""}
        </Stat>
      </div>

      {resolved && (
        <div className="flex flex-col gap-3 border border-line bg-bg-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            {claim > 0n ? (
              <>
                Redeemable: <span className="num font-medium">{formatMusd(claim)} mUSD</span>
                {mine.length > 0 && <span className="text-dim"> (also returns {mine.length} resting order{mine.length === 1 ? "" : "s"})</span>}
              </>
            ) : (
              <span className="text-dim">Nothing to redeem in this market.</span>
            )}
          </div>
          <button className="btn btn-primary btn-sm" disabled={USE_FIXTURES || claim === 0n || busy !== null} onClick={redeem}>
            {busy === "redeem" ? "Redeeming…" : "Redeem"}
          </button>
        </div>
      )}

      <div>
        <div className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Open orders</div>
        {mine.length === 0 ? (
          <div className="text-sm text-dim">No open orders.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {mine.map((o) => (
                <tr key={o.address} className="border-t border-line">
                  <td className="py-2">
                    {sideName(o.side)} {outcomeName(o.outcome)}
                  </td>
                  <td className="num py-2 text-right">{formatPrice(o.priceBps)}</td>
                  <td className="num py-2 text-right text-dim">
                    {formatShares(o.originalQty - o.remainingQty)}/{formatShares(o.originalQty)} filled · {formatShares(o.remainingQty)} resting
                  </td>
                  <td className="py-2 text-right">
                    <button className="btn btn-ghost btn-sm" disabled={USE_FIXTURES || busy !== null} onClick={() => cancel(o)}>
                      {busy === o.address ? "Cancelling…" : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Your recent fills</div>
        {fills.length === 0 ? (
          <div className="text-sm text-dim">No fills yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {fills.map((t) => (
                <tr key={`${t.signature}-${t.priceBps}-${t.quantity}`} className="border-t border-line">
                  <td className="py-2">
                    {t.buyer === me ? "Bought" : "Sold"} {formatShares(t.quantity)} {outcomeName(t.outcome)}
                  </td>
                  <td className="num py-2 text-right">{formatPrice(t.priceBps)}</td>
                  <td className="num py-2 text-right">{formatMusd(t.quoteAmount)} mUSD</td>
                  <td className="py-2 text-right">
                    {!t.finalized && <span className="mr-2 text-xs text-warn">confirming</span>}
                    <TxLink signature={t.signature} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
