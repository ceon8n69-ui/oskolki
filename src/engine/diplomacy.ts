// Дипломатия, территории, очки влияния и условия победы.
import type { Balance } from '../shared/balance.ts';
import type { Coord, GameState, MatchMode, Objective, PlayerId, Treaty, TreatyStatus } from '../shared/types.ts';
import { NEUTRAL } from '../shared/types.ts';
import { dist } from './grid.ts';

export function pairKey(a: PlayerId, b: PlayerId): [PlayerId, PlayerId] {
  return a < b ? [a, b] : [b, a];
}

export function findTreaty(state: GameState, a: PlayerId, b: PlayerId): Treaty | undefined {
  const [x, y] = pairKey(a, b);
  return state.diplomacy.find(t => t.a === x && t.b === y);
}

/** Получить (или создать в состоянии) запись пары. */
export function treatyOf(b: Balance, state: GameState, a: PlayerId, c: PlayerId): Treaty {
  const found = findTreaty(state, a, c);
  if (found) return found;
  const [x, y] = pairKey(a, c);
  const t: Treaty = { a: x, b: y, status: b.diplomacy.default, since: 0, pending: null, proposal: null };
  state.diplomacy.push(t);
  return t;
}

export function statusBetween(b: Balance, state: GameState, a: PlayerId | null, c: PlayerId | null): TreatyStatus | 'self' {
  if (a === null || c === null) return 'war'; // нейтральные города и отряды — всегда цели
  if (a === c) return 'self';
  if (a === NEUTRAL || c === NEUTRAL) return 'war';
  return findTreaty(state, a, c)?.status ?? b.diplomacy.default;
}

export function isHostile(b: Balance, state: GameState, a: PlayerId | null, c: PlayerId | null): boolean {
  const s = statusBetween(b, state, a, c);
  return s !== 'self' && b.diplomacy.statuses[s].attack;
}

export function exertsZocOn(b: Balance, state: GameState, holder: PlayerId, mover: PlayerId): boolean {
  const s = statusBetween(b, state, holder, mover);
  return s !== 'self' && b.diplomacy.statuses[s].zoc;
}

export function allies(b: Balance, state: GameState, p: PlayerId): PlayerId[] {
  return state.players.filter(o => o.id !== p && statusBetween(b, state, p, o.id) === 'alliance').map(o => o.id);
}

/** Владелец территории на клетке: ближайший город в радиусе territoryRadius (при равенстве — меньший id). */
export function territoryOwner(b: Balance, state: GameState, at: Coord): PlayerId | null {
  let best: { owner: PlayerId; d: number; id: string } | null = null;
  for (const c of state.cities) {
    if (!c.owner || c.owner === NEUTRAL) continue;
    const d = dist(c, at);
    if (d > b.roads.territoryRadius) continue;
    if (!best || d < best.d || (d === best.d && c.id < best.id)) best = { owner: c.owner, d, id: c.id };
  }
  return best?.owner ?? null;
}

/** Можно ли отряду игрока войти на клетку с учётом договоров (перемирие закрывает территорию). */
export function mayEnter(b: Balance, state: GameState, mover: PlayerId, from: Coord, to: Coord): boolean {
  const owner = territoryOwner(b, state, to);
  if (!owner || owner === mover) return true;
  const s = statusBetween(b, state, mover, owner);
  if (s === 'self' || b.diplomacy.statuses[s].enterTerritory) return true;
  // Уже находящийся внутри может двигаться по этой территории, чтобы выйти.
  return territoryOwner(b, state, from) === owner;
}

// ---------- Влияние и победа ----------

export function defaultMode(): MatchMode {
  return { victory: 'elimination', turnLimit: null, alliances: false, objectives: [], scores: {}, finished: null };
}

/** Держатель цели: святилище — чей отряд стоит на клетке; город — владелец, если город не оспаривается. */
export function objectiveHolder(state: GameState, o: Objective): PlayerId | null {
  if (o.kind === 'city') {
    const c = state.cities.find(x => x.id === o.cityId);
    if (!c || !c.owner || c.owner === NEUTRAL || c.contestedBy) return null;
    return c.owner;
  }
  const u = state.units.find(x => x.x === o.x && x.y === o.y && x.hp > 0);
  return u && u.owner !== NEUTRAL ? u.owner : null;
}

/** Победители, если партия закончилась; иначе null. Союзники побеждают вместе. */
export function checkVictory(b: Balance, state: GameState): { winners: PlayerId[]; reason: string } | null {
  const alive = state.players.filter(p => !p.eliminated).map(p => p.id);
  const bloc = (p: PlayerId) => [p, ...allies(b, state, p).filter(x => alive.includes(x))].sort();
  if (alive.length === 0) return { winners: [], reason: 'all_eliminated' };
  // Остался один игрок или один союз.
  const first = bloc(alive[0]);
  if (alive.every(p => first.includes(p))) return { winners: first, reason: alive.length === 1 ? 'last_standing' : 'last_alliance' };
  const m = state.mode;
  if (m.victory === 'capitals') {
    const capitals = state.cities.filter(c => c.isCapital);
    for (const p of alive) {
      const group = bloc(p);
      if (capitals.length && capitals.every(c => c.owner && group.includes(c.owner) && !c.contestedBy)) return { winners: group, reason: 'capitals' };
    }
  }
  if (m.turnLimit !== null && state.turn >= m.turnLimit) {
    if (m.victory === 'influence') {
      // Лидер по очкам; ничья — по числу городов, затем по числу отрядов, затем по id.
      const score = (p: PlayerId) => m.scores[p] ?? 0;
      const cities = (p: PlayerId) => state.cities.filter(c => c.owner === p).length;
      const units = (p: PlayerId) => state.units.filter(u => u.owner === p).length;
      const ranked = [...alive].sort((x, y) => score(y) - score(x) || cities(y) - cities(x) || units(y) - units(x) || (x < y ? -1 : 1));
      return { winners: [ranked[0]], reason: 'influence_turn_limit' };
    }
    const cities = (p: PlayerId) => state.cities.filter(c => c.owner === p).length;
    const ranked = [...alive].sort((x, y) => cities(y) - cities(x) || (x < y ? -1 : 1));
    return { winners: [ranked[0]], reason: 'turn_limit' };
  }
  return null;
}

/** Выбор целей влияния при старте: святилища и стратегические города, разнесённые по карте. */
export function pickObjectives(b: Balance, state: GameState, shrineTiles: Coord[], seedPick: (n: number) => number): Objective[] {
  const want = Math.max(b.influence.minObjectives, Math.round(state.players.length * b.influence.objectivesPerPlayer));
  const capitals = state.cities.filter(c => c.isCapital);
  const out: Objective[] = [];
  const farFromAll = (c: Coord) =>
    out.every(o => dist(o, c) >= b.influence.minSpacing) && capitals.every(k => dist(k, c) >= 4);
  const shrines = [...shrineTiles];
  while (out.length < want && shrines.length) {
    const s = shrines.splice(seedPick(shrines.length), 1)[0];
    if (farFromAll(s)) out.push({ id: `o${out.length + 1}`, kind: 'shrine', x: s.x, y: s.y, cityId: null, points: b.influence.shrinePoints, holder: null });
  }
  const neutral = state.cities.filter(c => !c.owner);
  while (out.length < want && neutral.length) {
    const c = neutral.splice(seedPick(neutral.length), 1)[0];
    if (farFromAll(c)) out.push({ id: `o${out.length + 1}`, kind: 'city', x: c.x, y: c.y, cityId: c.id, points: b.influence.cityPoints, holder: null });
  }
  return out;
}
