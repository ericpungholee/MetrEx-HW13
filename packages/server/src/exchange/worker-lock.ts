import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import type { PublicKey } from "@solana/web3.js";

/** An exclusive, host-local lease released by the OS on exit, including after a crash. */
export async function lockWorker(prog: PublicKey, identities: readonly (PublicKey | string)[]): Promise<() => void> {
  const ports = new Set(identities.map((key) => {
    const hash = createHash("sha256").update(prog.toBuffer()).update(typeof key === "string" ? key : key.toBuffer()).digest();
    return 20_000 + hash.readUInt32BE() % 30_000;
  }));
  const sockets: Server[] = [];
  const close = () => sockets.forEach((socket) => socket.close());
  try {
    for (const port of [...ports].sort((a, b) => a - b)) {
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      server.unref();
      sockets.push(server);
    }
    return close;
  } catch (cause) {
    close();
    throw new Error("Cannot acquire the worker lease. Check for another process using these identities or the lease port.", { cause });
  }
}
