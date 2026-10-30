// Детерминированные хэши и генератор случайных чисел. Никакого Math.random в правилах.

/** 32-битный FNV-1a от строки. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Хэш нескольких частей → [0, 2^32). */
export function hashParts(...parts: (string | number)[]): number {
  return hash32(parts.join('|'));
}

/** mulberry32 — быстрый детерминированный ГПСЧ. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function turnSeed(matchSeed: string, turn: number): string {
  return `${matchSeed}#turn${turn}`;
}
