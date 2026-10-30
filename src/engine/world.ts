// Этап 5: флот и перевозка, обелиски Хранителей руин, руины, мировые события.
// Чистые функции без побочных эффектов, кроме явно названных (advance*, loot*).
import type { Balance, LootKind } from '../shared/balance.ts';
import { hasAbility } from '../shared/balance.ts';
import type { Coord, GameState, PlayerId, Structure, UnitState } from '../shared/types.ts';
import { Feature, NEUTRAL } from '../shared/types.ts';
import { dist, idx, inBounds } from './grid.ts';
import { hash32 } from './rng.ts';
import { playerOf, techs, traitsOf } from './stats.ts';

// ---------- Флот ----------

export function isNaval(b: Balance, unitType: string): boolean {
  return hasAbility(b, unitType, 'naval');
}

export function cargoOf(state: GameState, transportId: string): UnitState[] {
  return state.units.filter(u => u.carriedBy === transportId && u.hp > 0);
}

/** Свободные места на транспорте (null — это не транспорт). */
export function freeSeats(b: Balance, state: GameState, t: UnitState): number | null {
  if (!hasAbility(b, t.type, 'transport')) return null;
  return b.naval.transportCapacity - cargoOf(state, t.id).length;
}

/** Свой транспорт на клетке, на который сухопутный отряд может погрузиться. */
export function embarkTarget(b: Balance, state: GameState, u: UnitState, at: Coord): UnitState | null {
  if (u.carriedBy || isNaval(b, u.type)) return null;
  const t = state.units.find(x => x.hp > 0 && !x.carriedBy && x.x === at.x && x.y === at.y && x.owner === u.owner);
  if (!t) return null;
  const free = freeSeats(b, state, t);
  return free !== null && free > 0 ? t : null;
}

/** Отряды, занимающие клетку (груз транспорта клетку не занимает). */
export function onMap(u: UnitState): boolean {
  return !u.carriedBy;
}

// ---------- Обелиски ----------

export function obelisksOf(state: GameState, owner: PlayerId): Structure[] {
  return state.world.structures.filter(s => s.kind === 'obelisk' && s.owner === owner);
}

/**
 * Связанные обелиски: цепочка от своего (не оспариваемого) города, звенья не дальше linkRange.
 * Разрыв цепочки отключает дальние узлы.
 */
export function linkedObelisks(b: Balance, state: GameState, owner: PlayerId): Structure[] {
  const all = obelisksOf(state, owner);
  if (!all.length) return [];
  const range = b.obelisks.linkRange + techs(b, state, owner).obeliskLink;
  const cities = state.cities.filter(c => c.owner === owner && !c.contestedBy);
  const linked = new Set<Structure>();
  const queue = all.filter(o => cities.some(c => dist(c, o) <= range));
  for (const o of queue) linked.add(o);
  for (let h = 0; h < queue.length; h++) {
    for (const o of all) {
      if (linked.has(o) || dist(o, queue[h]) > range) continue;
      linked.add(o);
      queue.push(o);
    }
  }
  return all.filter(o => linked.has(o));
}

export function fieldRadius(b: Balance, state: GameState, owner: PlayerId): number {
  return b.obelisks.fieldRadius + techs(b, state, owner).obeliskField;
}

/** Отряд в поле резонанса (только для народа с обелисками). */
export function inResonance(b: Balance, state: GameState, u: { owner: PlayerId; x: number; y: number }): boolean {
  if (!traitsOf(b, state, u.owner).buildObelisk) return false;
  const r = fieldRadius(b, state, u.owner);
  return linkedObelisks(b, state, u.owner).some(o => dist(o, u) <= r);
}

export function resonanceMul(b: Balance, state: GameState, owner: PlayerId): number {
  return (traitsOf(b, state, owner).resonanceMul ?? 1) + techs(b, state, owner).resonanceBonus;
}

// ---------- Руины ----------

export function isLootableRuin(state: GameState, x: number, y: number): boolean {
  const i = idx(state.map, x, y);
  return !!(state.map.features[i] & Feature.Ruins) && !state.world.lootedRuins.includes(i);
}

/** Награда за руины: детерминированно по seed карты и клетке. */
export function ruinReward(b: Balance, state: GameState, owner: PlayerId, x: number, y: number): { kind: LootKind; amount: number } {
  const list = b.ruinsLoot.rewards;
  const r = list[hash32(`${state.map.seed}#ruin#${x},${y}#${state.world.lootedRuins.length}`) % list.length];
  const mul = (traitsOf(b, state, owner).lootMul ?? 1) + techs(b, state, owner).lootBonus;
  return { kind: r.kind, amount: Math.max(1, Math.round(r.amount * mul)) };
}

// ---------- Мировые события ----------

/** Выбор события на ход (или null). Детерминирован по seed и номеру хода. */
export function rollWorldEvent(b: Balance, seed: string, turn: number): string | null {
  const we = b.worldEvents;
  if (turn < we.firstTurn || (turn - we.firstTurn) % we.interval !== 0) return null;
  if ((hash32(`${seed}#event-chance#${turn}`) % 1000) / 1000 >= we.chance) return null;
  const entries = Object.entries(we.list).sort((a, c) => (a[0] < c[0] ? -1 : 1));
  const total = entries.reduce((s, [, e]) => s + e.weight, 0);
  let x = (hash32(`${seed}#event#${turn}`) % 10000) / 10000 * total;
  for (const [id, e] of entries) {
    x -= e.weight;
    if (x < 0) return id;
  }
  return entries[entries.length - 1][0];
}

export function eventActive(state: GameState, id: string): boolean {
  return state.world.events.some(e => e.id === id && e.startTurn <= state.turn && state.turn <= e.endTurn);
}

// ---------- Клетка и территория ----------

/** Ближайший чужой город игрока-противника в радиусе (для выжженной земли). */
export function nearestForeignCity(state: GameState, owner: PlayerId, at: Coord, radius: number) {
  let best: GameState['cities'][number] | null = null;
  for (const c of state.cities) {
    if (!c.owner || c.owner === NEUTRAL || c.owner === owner) continue;
    const d = dist(c, at);
    if (d > radius) continue;
    if (!best || d < dist(best, at) || (d === dist(best, at) && c.id < best.id)) best = c;
  }
  return best;
}

export function coastal(state: GameState, c: Coord): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = c.x + dx, y = c.y + dy;
    if ((dx || dy) && inBounds(state.map, x, y) && state.map.terrain[idx(state.map, x, y)] <= 1) return true;
  }
  return false;
}

export function playerFaction(state: GameState, owner: PlayerId): string | undefined {
  return playerOf(state, owner)?.faction;
}
