import { BALANCE } from '../src/shared/balance.ts';
import type { CityState, GameState, SubmittedOrder, UnitOrder, UnitState, Order } from '../src/shared/types.ts';
import { Terrain } from '../src/shared/types.ts';
import { computeAllVision, updateExploredAndIntel } from '../src/engine/vision.ts';
import { RULES_VERSION } from '../src/engine/resolve.ts';
import { newCity, newPlayer, newUnit } from '../src/engine/factory.ts';
import { defaultMode } from '../src/engine/diplomacy.ts';

export const b = BALANCE;

/** Плоская карта из равнин с возможностью задать клетки местности. */
export function flatState(opts: {
  w?: number;
  h?: number;
  units?: (Partial<UnitState> & { owner?: string })[];
  cities?: Partial<CityState>[];
  terrain?: { x: number; y: number; t: number }[];
  players?: string[];
  factions?: Record<string, string>;
  noCommanders?: boolean;
} = {}): GameState {
  const w = opts.w ?? 12;
  const h = opts.h ?? 12;
  const terrain = new Uint8Array(w * h).fill(Terrain.Plains);
  for (const t of opts.terrain ?? []) terrain[t.y * w + t.x] = t.t;
  const players = (opts.players ?? ['A', 'B']).map((id, i) => {
    const p = newPlayer(b, { id, name: id, faction: opts.factions?.[id] ?? 'union', color: ['#00f', '#f00', '#0f0'][i] ?? '#888', isBot: false });
    p.gold = 50;
    p.materials = { wood: 10, iron: 10, crystal: 10 };
    p.commander.pendingChoices = 0;
    return p;
  });
  const state: GameState = {
    matchId: 'test', turn: 1, balanceVersion: b.version, rulesVersion: RULES_VERSION,
    map: { width: w, height: h, chunkSize: 16, seed: 'test-seed', generatorVersion: 'test', terrain, features: new Uint8Array(w * h) },
    players, units: [], cities: [], explored: {}, intel: {}, nextIds: { unit: 1000 },
    diplomacy: [], mode: defaultMode(),
  };
  let n = 1;
  for (const u of opts.units ?? []) {
    const unit = newUnit(b, state, { id: u.id ?? `u${n++}`, owner: u.owner ?? 'A', type: u.type ?? 'infantry', x: u.x ?? 0, y: u.y ?? 0, createdTurn: 1 });
    Object.assign(unit, { ...u, maxHp: u.maxHp ?? unit.maxHp, hp: u.hp ?? unit.maxHp });
    state.units.push(unit);
    if (unit.type === 'commander') state.players.find(p => p.id === unit.owner)!.commander.unitId = unit.id;
  }
  state.cities = (opts.cities ?? []).map((c, i) => newCity({ id: c.id ?? `c${i + 1}`, name: c.name ?? `City${i}`, x: c.x ?? 0, y: c.y ?? 0, ...c, owner: c.owner === undefined ? 'A' : c.owner }));
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
