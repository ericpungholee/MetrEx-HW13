// Shared demo password for close/resolve (spec §9.2). Constant-time compare; deny if unset.

import { createHash, timingSafeEqual } from "node:crypto";

export const DEMO_PASSWORD_HEADER = "x-demo-password";

export function checkDemoPassword(
  header: string | null | undefined,
  expected: string | undefined = process.env.DEMO_PASSWORD,
): boolean {
  if (!expected || expected.length === 0) return false;
  if (typeof header !== "string" || header.length === 0) return false;
  // Hash both sides so lengths match and the compare is constant-time.
  const a = createHash("sha256").update(header, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Process-wide budget for invalid operator credentials, shared across both operator routes. */
export class OperatorPasswordBudget {
  private failures: number[] = [];

  constructor(readonly maxFailures = 10, readonly windowMs = 60_000) {}

  check(header: string | null, password: string, now = Date.now()): "allowed" | "wrong" | "limited" {
    this.failures = this.failures.filter((t) => t > now - this.windowMs);
    if (this.failures.length >= this.maxFailures) return "limited";
    if (checkDemoPassword(header, password)) return "allowed";
    this.failures.push(now);
    return "wrong";
  }
}
