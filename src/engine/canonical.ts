// Каноническая форма состояния: порядок массивов не зависит от того, откуда состояние загружено
// (из памяти, из снимка или из таблиц PostgreSQL). Нужна для воспроизводимости и хэшей.
import type { GameState } from '../shared/types.ts';

/** Сравнение идентификаторов вида u2 < u10. */
export function idCompare(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function canonicalize(state: GameState): GameState {
  state.units.sort((a, b) => idCompare(a.id, b.id));
  for (const u of state.units) if (u.route === undefined) u.route = null;
  state.cities.sort((a, b) => idCompare(a.id, b.id));
  for (const p of state.players) p.researched.sort();
  return state;
}

/** JSON с отсортированными ключами объектов. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
