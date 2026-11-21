// Program events (spec-v2 §6.9) as plain typed records, plus a pure log walker that attributes
// every `Program data:` line to its top-level instruction (§7.2 dedup key). Decoding the base64
// payload is injected (the Anchor coder lives in the server), so this module stays I/O-free.

export interface OrderPlacedEvent {
  name: "OrderPlaced";
  market: string;
  order: string;
  maker: string;
  outcome: number;
  side: number;
  priceBps: number;
  quantity: bigint;
  seq: bigint;
  expiresAt: bigint;
}

export interface OrderFilledEvent {
  name: "OrderFilled";
  market: string;
  outcome: number;
  /** `11111111111111111111111111111111` (default) for a direct taker's side. */
  buyOrder: string;
  sellOrder: string;
  buyer: string;
  seller: string;
  quantity: bigint;
  priceBps: number;
  quoteAmount: bigint;
  buyerRefund: bigint;
  /** The older or resting order. */
  makerOrder: string;
}

export interface OrderCancelledEvent {
  name: "OrderCancelled";
  market: string;
  order: string;
  maker: string;
  swept: boolean;
  remainingQty: bigint;
  returnedAmount: bigint;
}

export interface OtherEvent {
  name:
    | "RoundCreated"
    | "MarketCreated"
    | "SharesSplit"
    | "SharesMerged"
    | "RoundClosed"
    | "MarketResolved"
    | "SharesRedeemed";
  market?: string;
  data: Record<string, unknown>;
}

export type ExchangeEvent = OrderPlacedEvent | OrderFilledEvent | OrderCancelledEvent | OtherEvent;

/** Where an event came from. `(signature, ixIndex, eventIndex)` is unique (§7.2). */
export interface EventPosition {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Top-level instruction index within the transaction. */
  ixIndex: number;
  /** Event index within that instruction. */
  eventIndex: number;
  /** Position of the transaction within its slot (from signature paging order), if known. */
  txOrder?: number;
}

export type PositionedEvent = ExchangeEvent & { pos: EventPosition };

export const eventKey = (p: Pick<EventPosition, "signature" | "ixIndex" | "eventIndex">): string =>
  `${p.signature}:${p.ixIndex}:${p.eventIndex}`;

/**
 * Walks transaction logs and returns `[ixIndex, eventIndex, base64]` for every `Program data:`
 * line emitted while `programId` is the executing program. CPI depth is tracked with a stack.
 */
export function walkProgramData(logs: readonly string[], programId: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  const stack: string[] = [];
  let ix = -1;
  const perIx = new Map<number, number>();
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth === 1) {
        ix++;
        stack.length = 0;
      }
      stack.length = depth - 1;
      stack.push(invoke[1] as string);
      continue;
    }
    if (/^Program (\S+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const data = /^Program data: (\S+)$/.exec(line);
    if (data && stack[stack.length - 1] === programId && ix >= 0) {
      const n = perIx.get(ix) ?? 0;
      perIx.set(ix, n + 1);
      out.push([ix, n, data[1] as string]);
    }
  }
  return out;
}

/** Keeps the first occurrence of each event key, preserving order. */
export function dedupeEvents<T extends { pos: EventPosition }>(events: Iterable<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    const k = eventKey(e.pos);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Chain order: slot, then transaction order within the slot, then instruction and event index. */
export function compareEventPos(a: EventPosition, b: EventPosition): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.signature !== b.signature) return (a.txOrder ?? 0) - (b.txOrder ?? 0); // stable sort keeps input order otherwise
  if (a.ixIndex !== b.ixIndex) return a.ixIndex - b.ixIndex;
  return a.eventIndex - b.eventIndex;
}
