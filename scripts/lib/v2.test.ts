import { describe, expect, it } from "vitest";
import { DEMO_BOTS, requoteRound, OrderSide, Outcome } from "@metrex/exchange";
import { checkBotsQuoting, checkDepthGuarantee } from "./v2";

const bots = Object.fromEntries(DEMO_BOTS.map((p) => [`bot-${p.name}`, p.name]));
const ladder = () => requoteRound(DEMO_BOTS, requoteRound(DEMO_BOTS, [], new Map(), { skewEnabled: false }), new Map(), { skewEnabled: false });

describe("prepare-demo-v2 checks (§8.3, §12 step 5)", () => {
  it("accepts the shipped ladder on both books", () => {
    expect(checkDepthGuarantee(ladder(), bots)).toEqual([]);
    expect(checkBotsQuoting(ladder(), bots)).toEqual([]);
  });
  it("rejects drift: an extra user bid at 410 would change the partial fill", () => {
    const b = [...ladder(), { id: "u", maker: "user", outcome: Outcome.Yes, side: OrderSide.Buy, priceBps: 410, remaining: 50n, seq: 99n, isBot: false }];
    const bad = checkDepthGuarantee(b, bots);
    expect(bad.some((x) => x.includes("YES bids"))).toBe(true);
    expect(bad.some((x) => x.includes("exactly 100"))).toBe(true);
  });
  it("reports a missing bot level", () => {
    const b = ladder().filter((o) => !(o.maker === "bot-B" && o.outcome === Outcome.No && o.side === OrderSide.Sell));
    expect(checkBotsQuoting(b, bots)).toEqual(["bot B missing NO ask"]);
  });
});
