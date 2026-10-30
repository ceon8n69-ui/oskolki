import { BALANCE } from '../src/shared/balance.ts';
import type { CityState, GameState, SubmittedOrder, UnitOrder, UnitState, Order } from '../src/shared/types.ts';
import { Terrain } from '../src/shared/types.ts';
import { computeAllVision, updateExploredAndIntel } from '../src/engine/vision.ts';
import { RULES_VERSION } from '../src/engine/resolve.ts';

export const b = BALANCE;

/** Плоская карта из равнин с возможностью задать клетки местности. */
export function flatState(opts: {
  w?: number;
  h?: number;
  units?: Partial<UnitState>[];
  cities?: Partial<CityState>[];
  terrain?: { x: number; y: number; t: number }[];
  players?: string[];
} = {}): GameState {
  const w = opts.w ?? 12;
  const h = opts.h ?? 12;
  const terrain = new Uint8Array(w * h).fill(Terrain.Plains);
  for (const t of opts.terrain ?? []) terrain[t.y * w + t.x] = t.t;
  const players = (opts.players ?? ['A', 'B']).map((id, i) => ({
    id, name: id, faction: 'union', color: ['#00f', '#f00', '#0f0'][i] ?? '#888', gold: 50, knowledge: 0,
    researched: [] as string[], researchQueue: [] as string[], researchProgress: 0, isBot: false, eliminated: false,
  }));
  let n = 1;
  const units: UnitState[] = (opts.units ?? []).map(u => ({
    id: u.id ?? `u${n++}`, owner: u.owner ?? 'A', type: u.type ?? 'infantry', x: u.x ?? 0, y: u.y ?? 0,
    hp: u.hp ?? b.units[u.type ?? 'infantry'].hp, xp: u.xp ?? 0, rank: u.rank ?? 0, statuses: u.statuses ?? [], countersUsed: 0, createdTurn: 1,
  }));
  const cities: CityState[] = (opts.cities ?? []).map((c, i) => ({
    id: c.id ?? `c${i + 1}`, name: c.name ?? `City${i}`, owner: c.owner === undefined ? 'A' : c.owner, x: c.x ?? 0, y: c.y ?? 0,
    level: c.level ?? 1, isCapital: c.isCapital ?? false, contestedBy: c.contestedBy ?? null, contestedSinceTurn: c.contestedSinceTurn ?? null,
    productionStock: 0, queue: c.queue ?? [],
  }));
  const state: GameState = {
    matchId: 'test', turn: 1, balanceVersion: b.version, rulesVersion: RULES_VERSION,
    map: { width: w, height: h, chunkSize: 16, seed: 'test-seed', generatorVersion: 'test', terrain, features: new Uint8Array(w * h) },
    players, units, cities, explored: {}, intel: {}, nextIds: { unit: 1000 },
  };
  updateExploredAndIntel(b, state, computeAllVision(b, state));
  return state;
}

let oid = 0;
export function so(playerId: string, order: Order): SubmittedOrder {
  return { id: `o${++oid}`, playerId, order };
}
export function move(unitId: string, path: [number, number][]): UnitOrder {
  return { kind: 'unit', unitId, mode: 'move', path: path.map(([x, y]) => ({ x, y })) };
}
export function attack(unitId: string, targetUnitId: string, path: [number, number][] = []): UnitOrder {
  return { kind: 'unit', unitId, mode: 'attack', targetUnitId, path: path.map(([x, y]) => ({ x, y })) };
}
export function hold(unitId: string): UnitOrder {
  return { kind: 'unit', unitId, mode: 'hold', path: [] };
}
export function unit(state: GameState, id: string): UnitState | undefined {
  return state.units.find(u => u.id === id);
}
