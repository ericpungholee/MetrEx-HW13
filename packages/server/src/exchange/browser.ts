// "@metrex/server/exchange/browser": the browser-safe part of the v2 chain client: typed account
// decoders and instruction builders. No node:fs, no keys, no oracle. The caller builds the Anchor
// Program from the committed IDL (app/lib/exchange-client.ts).
export * from "./accounts";
export * from "./ix";
