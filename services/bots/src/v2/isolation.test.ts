// Information isolation (spec-v2 §8.4, flaw #14): bot code never imports settlement data.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoOracleData } from "./guard";

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(n) ? [p] : [];
  });
}

const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1] as string);

describe("bots-isolation (§8.4)", () => {
  it("no file under services/bots/src imports @metrex/geo, the oracle or data/", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      if (f.endsWith("isolation.test.ts")) continue;
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        if (/^@metrex\/geo(\/|$)/.test(s) || /oracle/.test(s) || /(^|\/)data(\/|$)/.test(s) || /packages\/server\/src\/oracle/.test(s)) {
          bad.push(`${relative(SRC, f)} → ${s}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("v2 bot code imports only the oracle-free @metrex/server/exchange entry", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "v2"))) {
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        if (s === "@metrex/server" || (s.startsWith("@metrex/server/") && s !== "@metrex/server/exchange")) bad.push(`${relative(SRC, f)} → ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the oracle-free entry itself never reaches the oracle, geo or data", () => {
    const dir = join(SRC, "../../../packages/server/src/exchange");
    const bad: string[] = [];
    for (const f of files(dir)) {
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        if (/^@metrex\/geo/.test(s) || /oracle/.test(s) || s === ".." || s === "../index") bad.push(`${relative(dir, f)} → ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the worker refuses to start when METREX_ORACLE_DATA_DIR is set", () => {
    expect(() => assertNoOracleData({ METREX_ORACLE_DATA_DIR: "/secret" })).toThrow(/METREX_ORACLE_DATA_DIR/);
    expect(() => assertNoOracleData({ METREX_ORACLE_DATA_DIR: "  " })).not.toThrow();
    expect(() => assertNoOracleData({})).not.toThrow();
  });
});
