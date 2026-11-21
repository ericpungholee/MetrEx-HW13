// Property labels are `[u8; 32]`, UTF-8, zero-padded (spec §5.2).

import { LABEL_BYTES } from "./constants";

export function encodeLabel(label: string): number[] {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > LABEL_BYTES) {
    throw new RangeError(`Label is ${bytes.length} bytes; max ${LABEL_BYTES}`);
  }
  const out = new Array<number>(LABEL_BYTES).fill(0);
  bytes.forEach((b, i) => {
    out[i] = b;
  });
  return out;
}

export function decodeLabel(bytes: ArrayLike<number>): string {
  const arr = Uint8Array.from(Array.from(bytes));
  const end = arr.indexOf(0);
  return new TextDecoder().decode(end === -1 ? arr : arr.subarray(0, end));
}
