// Canonical JSON and hashing (spec §8.4). Browser-safe: no Node built-ins.
//
// Rules:
// - Objects: keys sorted lexicographically (by UTF-16 code unit, i.e. JS default
//   string order; identical to byte order for the ASCII keys we use) at every level.
// - No insignificant whitespace.
// - Numbers must be safe integers. Non-integers, NaN, +-Infinity and integers beyond
//   Number.MAX_SAFE_INTEGER throw. -0 is accepted and serialized as `0` (it is the
//   same integer value; JSON.stringify already renders it as "0").
// - Allowed values: null, boolean, safe-integer number, string, array, plain object.
//   `undefined`, bigint, functions, symbols, Dates, Maps etc. throw.
// - Strings are escaped exactly as JSON.stringify does. Output is UTF-8 encoded.

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(`Canonical JSON allows only safe integers; ${path} = ${String(value)}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => write(v, `${path}[${i}]`)).join(",")}]`;
      }
      if (!isPlainObject(value)) {
        throw new Error(`Canonical JSON allows only plain objects; ${path} is not one`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${write(obj[k], `${path}.${k}`)}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`Canonical JSON cannot encode ${typeof value} at ${path}`);
  }
}

/** Canonical JSON string of `value` (spec §8.4). Throws on non-canonical input. */
export function canonicalize(value: unknown): string {
  return write(value, "$");
}

/** UTF-8 bytes of the canonical JSON of `value`. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** SHA-256 digest (32 bytes). */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/** Lowercase hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Parse a 64-char lowercase/uppercase hex SHA-256 into 32 bytes. */
export function hexToBytes32(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Expected 64 hex characters");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
