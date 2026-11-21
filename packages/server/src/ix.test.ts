// Builds every instruction offline and checks it against the frozen IDL account list.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodeLabel, findOfferPda, findVaultPda, Side } from "@metrex/shared";
import {
  acceptOfferIx,
  cancelListingIx,
  cancelOfferIx,
  closeMarketIx,
  createMarketIx,
  initializeConfigIx,
  listPositionIx,
  placeOfferIx,
  registerPropertyIx,
  resolveMarketIx,
} from "./ix";
import { getProgram, loadIdl } from "./program";
import { musdAta } from "./token";

// Never contacted: every account is supplied, so building needs no RPC.
const program = getProgram(new Connection("http://127.0.0.1:1"));
const k = () => Keypair.generate().publicKey;
const idl = loadIdl() as unknown as { instructions: { name: string; accounts: { name: string }[] }[] };
const accountCount = (name: string) => idl.instructions.find((i) => i.name === name)?.accounts.length;

describe("instruction builders", () => {
  const mint = k();

  it("place_offer derives offer, vault and the underwriter ATA", async () => {
    const underwriter = k();
    const market = k();
    const ix = await placeOfferIx(program, { underwriter, market, offerNonce: 42n, coverage: 4_000_000_000n, premiumBps: 400, mint });
    expect(ix.programId.equals(program.programId)).toBe(true);
    expect(ix.keys).toHaveLength(accountCount("place_offer")!);
    const offer = findOfferPda(program.programId, market, underwriter, 42n)[0];
    expect(ix.keys[3]!.pubkey.equals(offer)).toBe(true);
    expect(ix.keys[5]!.pubkey.equals(findVaultPda(program.programId, offer)[0])).toBe(true);
    expect(ix.keys[6]!.pubkey.equals(musdAta(underwriter, mint))).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
  });

  it("every builder matches the IDL account count", async () => {
    const cases: [string, Promise<{ keys: unknown[] }>][] = [
      ["initialize_config", initializeConfigIx(program, { admin: k(), oracle: k(), controller: k(), mint })],
      [
        "register_property",
        registerPropertyIx(program, k(), {
          propertyId: 1,
          label: encodeLabel("Palisades · Home #1042"),
          latE6: 1,
          lonE6: 2,
          scenarioId: 1,
          triggerDistanceM: 500,
        }),
      ],
      ["create_market", createMarketIx(program, { homeowner: k(), marketNonce: 1n, propertyId: 1, coverageTarget: 10n })],
      ["cancel_offer", cancelOfferIx(program, { underwriter: k(), offer: k(), mint })],
      ["accept_offer", acceptOfferIx(program, { homeowner: k(), market: k(), offer: k(), mint })],
      ["close_market", closeMarketIx(program, { demoController: k(), market: k() })],
      [
        "resolve_market",
        resolveMarketIx(program, { oracleAuthority: k(), market: k(), triggered: true, evidenceHash: new Uint8Array(32) }),
      ],
      ["list_position", listPositionIx(program, { seller: k(), market: k(), offer: k(), side: Side.Risk, price: 1n })],
      ["cancel_listing", cancelListingIx(program, { seller: k(), listing: k() })],
    ];
    for (const [name, p] of cases) {
      const ix = await p;
      expect(ix.keys, name).toHaveLength(accountCount(name)!);
    }
  });

  it("resolve_market encodes triggered + the 32-byte hash", async () => {
    const hash = Uint8Array.from({ length: 32 }, (_, i) => i);
    const ix = await resolveMarketIx(program, { oracleAuthority: k(), market: k(), triggered: true, evidenceHash: hash });
    // 8-byte discriminator, bool, [u8; 32]
    expect(ix.data.length).toBe(8 + 1 + 32);
    expect(ix.data[8]).toBe(1);
    expect(Array.from(ix.data.subarray(9))).toEqual(Array.from(hash));
    await expect(
      resolveMarketIx(program, { oracleAuthority: k(), market: k(), triggered: false, evidenceHash: new Uint8Array(31) }),
    ).rejects.toThrow(/32 bytes/);
  });

  it("initialize_config passes the program and its ProgramData", async () => {
    const ix = await initializeConfigIx(program, { admin: k(), oracle: k(), controller: k(), mint });
    expect(ix.keys[3]!.pubkey.equals(new PublicKey(loadIdl().address))).toBe(true);
  });
});
