import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";

// CLAUDE.md "Frontend": fixtures exist only behind NEXT_PUBLIC_USE_FIXTURES=1 and
// production builds must fail with it on.
const fixturesOn = process.env.NEXT_PUBLIC_USE_FIXTURES === "1";

export default function config(phase: string): NextConfig {
  const production =
    phase === PHASE_PRODUCTION_BUILD ||
    phase === PHASE_PRODUCTION_SERVER ||
    process.env.NODE_ENV === "production";
  if (fixturesOn && production) {
    throw new Error(
      "NEXT_PUBLIC_USE_FIXTURES=1 is not allowed in a production build or server. " +
        "Fixtures are for local development only; unset it and build again.",
    );
  }
  return {
    reactStrictMode: true,
    allowedDevOrigins: ["127.0.0.1", "localhost"],
    // Don't let `next dev` write an AGENTS.md into app/ (the repo's CLAUDE.md is authoritative).
    agentRules: false,
    // Workspace packages ship TypeScript source.
    transpilePackages: ["@metrex/shared", "@metrex/geo", "@metrex/server"],
    // The app imports the committed IDL from ../target, so the workspace root is the root.
    turbopack: { root: path.join(__dirname, "..") },
    outputFileTracingRoot: path.join(__dirname, ".."),
    outputFileTracingIncludes: {
      "/api/**/*": ["../pnpm-workspace.yaml", "../target/idl/metrex.json"],
    },
  };
}
