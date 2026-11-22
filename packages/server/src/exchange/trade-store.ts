// Replayable local cache of finalized receipts. The keeper/indexer is the only writer.
// A newline commits a batch, including its cursors, so a crash can only lose the last batch.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildChart, compareEventPos, type ChartState, type OrderFilledEvent, type PositionedEvent } from "@metrex/exchange";
import { heartbeatDir } from "./heartbeat";
import type { IndexedTrade, PendingReceipt, TxRow } from "./trades";

export interface TradeBatch {
  discovered?: PendingReceipt[];
  receipts?: TxRow[];
  head?: { signature: string; order: number };
  history?: { before: string | null; order: number };
}

export class TradeStore {
  private offset = 0;
  readonly pending = new Map<string, PendingReceipt>();
  readonly known = new Set<string>();
  head: TradeBatch["head"];
  history: TradeBatch["history"];
  private readonly marketEvents = new Map<string, PositionedEvent[]>();
  private readonly ordered = new Map<string, PositionedEvent[]>();
  private readonly charts = new Map<string, ChartState>();
  constructor(
    readonly path: string,
    private readonly decode: (row: TxRow) => PositionedEvent[],
    readonly writer = false,
  ) {
    this.reload();
    if (writer && this.partial) truncateSync(path, this.offset);
  }

  private partial = false;

  get backfilled(): boolean {
    return this.history?.before === null && this.pending.size === 0;
  }

  reload(): void {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      const end = fstatSync(fd).size;
      // A multi-day journal can exceed Node's maximum string length. Replay it in
      // bounded chunks while keeping incomplete batches invisible to readers.
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(0, end - this.offset)));
      let cursor = this.offset;
      let tail = "";
      while (cursor < end) {
        const length = readSync(fd, chunk, 0, Math.min(chunk.length, end - cursor), cursor);
        if (length === 0) break;
        cursor += length;
        // Journal fields are ASCII signatures, numeric fields and base64 program logs.
        const lines = (tail + chunk.toString("utf8", 0, length)).split("\n");
        tail = lines.pop()!;
        for (const line of lines) this.apply(JSON.parse(line) as TradeBatch);
        this.offset = cursor - Buffer.byteLength(tail);
      }
      this.partial = cursor > this.offset;
    } finally {
      closeSync(fd);
    }
  }

  append(batch: TradeBatch): void {
    if (!this.writer) throw new Error("Trade history is read-only");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(batch) + "\n";
    appendFileSync(this.path, line, { mode: 0o600, flush: true });
    this.offset += Buffer.byteLength(line);
    this.apply(batch);
  }

  private apply(batch: TradeBatch): void {
    if (batch.head) this.head = batch.head;
    if (batch.history) this.history = batch.history;
    for (const row of batch.discovered ?? []) {
      if (row.failed) this.known.add(row.signature);
      else if (!this.known.has(row.signature) && !this.pending.has(row.signature)) this.pending.set(row.signature, row);
    }
    for (const receipt of batch.receipts ?? []) {
      if (this.known.has(receipt.signature)) continue;
      for (const event of this.decode(receipt)) {
        if (!event.market) continue;
        let events = this.marketEvents.get(event.market);
        if (!events) this.marketEvents.set(event.market, (events = []));
        events.push(event);
        this.ordered.delete(event.market);
        this.charts.delete(event.market);
      }
      this.pending.delete(receipt.signature);
      this.known.add(receipt.signature);
    }
  }

  events(market: string): PositionedEvent[] {
    let events = this.ordered.get(market);
    if (!events) {
      events = [...(this.marketEvents.get(market) ?? [])].sort((a, b) => compareEventPos(a.pos, b.pos));
      this.ordered.set(market, events);
    }
    return events;
  }

  trades(market: string): IndexedTrade[] {
    return this.events(market)
      .filter((e): e is OrderFilledEvent & { pos: PositionedEvent["pos"] } => e.name === "OrderFilled")
      .map((fill) => ({ signature: fill.pos.signature, slot: fill.pos.slot, blockTime: fill.pos.blockTime, finalized: true, fill }));
  }

  chart(market: string): ChartState {
    let chart = this.charts.get(market);
    if (!chart) {
      chart = buildChart(this.events(market));
      this.charts.set(market, chart);
    }
    return chart;
  }
}

export const tradeStorePath = (program: string) => join(heartbeatDir(), `trades-${program}-v1.jsonl`);
