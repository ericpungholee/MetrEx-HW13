/** An error with an HTTP status, raised by route-handler logic. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (m: string) => new HttpError(400, m, "bad_request");
export const forbidden = (m: string) => new HttpError(403, m, "forbidden");
export const notFound = (m: string) => new HttpError(404, m, "not_found");
export const conflict = (m: string) => new HttpError(409, m, "conflict");
export const tooMany = (m: string) => new HttpError(429, m, "rate_limited");
export const unavailable = (m: string) => new HttpError(503, m, "unavailable");

/** Per-key in-process lock so two concurrent requests can't race the same market. */
export class KeyedLock {
  private readonly held = new Set<string>();
  async with<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.held.has(key)) throw conflict("Another request for this market is in progress");
    this.held.add(key);
    try {
      return await fn();
    } finally {
      this.held.delete(key);
    }
  }
}
