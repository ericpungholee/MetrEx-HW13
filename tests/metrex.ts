// Anchor tests (spec §12.1). Workstream A owns this file and fills in every §12.1 item,
// with one named test per §6.3 invariant. Gate 0 only checks that the program loads.
import * as anchor from "@anchor-lang/core";
import { expect } from "chai";

describe("metrex", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Metrex as anchor.Program;

  it("loads the program from the workspace", () => {
    expect(program.programId).to.be.instanceOf(anchor.web3.PublicKey);
  });
});
