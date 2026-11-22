import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CATALOG, LISTINGS } from "@metrex/exchange";
import { expect, it } from "vitest";

it("gives each property a distinct market image", () => {
  const paths = [...CATALOG, ...LISTINGS].map(({ photo }) => photo.src);
  const hashes = paths.map((src) => {
    const image = readFileSync(new URL(`../public${src}`, import.meta.url));
    return createHash("sha256").update(image).digest("hex");
  });

  expect(new Set(paths).size).toBe(paths.length);
  expect(new Set(hashes).size).toBe(hashes.length);
});
