// Seeded pseudo-random numbers (docs/spec-simulation.md §2). Pure. Personalities, bulletins and
// decisions are reproducible from `SIM_SEED`; nothing here is cryptographic.

/** 32-bit FNV-1a of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  uniform(lo: number, hi: number): number;
  int(lo: number, hiInclusive: number): number;
  normal(mean?: number, sd?: number): number;
  /** Log-uniform in [lo, hi]. */
  logUniform(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: readonly T[]): T[];
}

/** sfc32 seeded from a string. */
export function rngFrom(seed: string): Rng {
  let a = hash32(`${seed}#a`), b = hash32(`${seed}#b`), c = hash32(`${seed}#c`), d = hash32(`${seed}#d`) | 1;
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  const r: Rng = {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    normal: (mean = 0, sd = 1) => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    logUniform: (lo, hi) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * next()),
    chance: (p) => next() < p,
    pick: (xs) => {
      if (!xs.length) throw new Error("pick from empty list");
      return xs[Math.floor(next() * xs.length)] as (typeof xs)[number];
    },
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
  };
  return r;
}
