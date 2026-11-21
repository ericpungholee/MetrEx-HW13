// Event decoding for metrex_exchange transactions (spec-v2 §6.9, §7.2).

import type { BN } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";
import { walkProgramData, type ExchangeEvent, type PositionedEvent } from "@metrex/exchange";
import type { ExchangeProgram } from "./program";

type Raw = Record<string, unknown>;
const s = (v: unknown): string => (v as PublicKey).toBase58();
const b = (v: unknown): bigint => BigInt((v as BN).toString());
const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function toExchangeEvent(name: string, raw: Raw): ExchangeEvent {
  const d = Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v])) as Raw;
  const n = name.charAt(0).toUpperCase() + name.slice(1);
  switch (n) {
    case "OrderPlaced":
      return {
        name: "OrderPlaced",
        market: s(d.market),
        order: s(d.order),
        maker: s(d.maker),
        outcome: d.outcome as number,
        side: d.side as number,
        priceBps: d.priceBps as number,
        quantity: b(d.quantity),
        seq: b(d.seq),
        expiresAt: b(d.expiresAt),
      };
    case "OrderFilled":
      return {
        name: "OrderFilled",
        market: s(d.market),
        outcome: d.outcome as number,
        buyOrder: s(d.buyOrder),
        sellOrder: s(d.sellOrder),
        buyer: s(d.buyer),
        seller: s(d.seller),
        quantity: b(d.quantity),
        priceBps: d.priceBps as number,
        quoteAmount: b(d.quoteAmount),
        buyerRefund: b(d.buyerRefund),
        makerOrder: s(d.makerOrder),
      };
    case "OrderCancelled":
      return {
        name: "OrderCancelled",
        market: s(d.market),
        order: s(d.order),
        maker: s(d.maker),
        swept: d.swept as boolean,
        remainingQty: b(d.remainingQty),
        returnedAmount: b(d.returnedAmount),
      };
    default:
      return {
        name: n as Exclude<ExchangeEvent["name"], "OrderPlaced" | "OrderFilled" | "OrderCancelled">,
        market: d.market ? s(d.market) : undefined,
        data: d,
      };
  }
}

/** Decodes every metrex_exchange event in one transaction's logs, with its dedup position. */
export function parseTxEvents(
  p: ExchangeProgram,
  tx: { signature: string; slot: number; blockTime: number | null; logs: readonly string[]; txOrder?: number },
): PositionedEvent[] {
  const out: PositionedEvent[] = [];
  for (const [ixIndex, eventIndex, data] of walkProgramData(tx.logs, p.programId.toBase58())) {
    const decoded = p.coder.events.decode(data);
    if (!decoded) continue;
    const e = toExchangeEvent(decoded.name, decoded.data as Raw);
    out.push({ ...e, pos: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, ixIndex, eventIndex, txOrder: tx.txOrder } });
  }
  return out;
}
