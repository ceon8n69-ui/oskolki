// Морская часть бота: порт, транспорты, погрузка, переправа и высадка, боевые корабли.
// Работает только с тем, что видит игрок. Простая и предсказуемая — для живых партий на архипелаге.
import type { Balance } from '../shared/balance.ts';
import type { Coord, GameState, Order, PlayerId, UnitState } from '../shared/types.ts';
import { DIRS8, dist, idx, inBounds, isLandPassable } from '../engine/grid.ts';
import { dijkstra, reconstruct } from '../engine/path.ts';
import { moveOf, moveProfile } from '../engine/stats.ts';
import { cargoOf, freeSeats, isNaval } from '../engine/world.ts';

export interface NavalCtx {
  b: Balance;
  state: GameState;
  playerId: PlayerId;
  blockers: Set<number>;
  claimed: Set<number>;
  goals: Coord[];
  enemies: UnitState[];
  tryPush: (o: Order) => boolean;
  /** 1 — клетка своей суши (достижима по суше от столицы). */
  homeLand: Uint8Array;
}

/** Нужна ли переправа: ни одна известная цель не достижима по суше от столицы, а суша своего острова исчерпана. */
// Своя суша меняется редко (проходимость клеток почти постоянна) — кешируем между ходами.
const landCache = new Map<string, Uint8Array>();

export function homeLand(b: Balance, state: GameState, playerId: PlayerId): Uint8Array {
  const home = state.cities.find(c => c.owner === playerId && c.isCapital) ?? state.cities.find(c => c.owner === playerId)
    ?? state.units.find(u => u.owner === playerId && !u.carriedBy && !isNaval(b, u.type));
  const n = state.map.width * state.map.height;
  if (!home) return new Uint8Array(n);
  const profile = moveProfile(b, state, { type: 'infantry', owner: playerId });
  const key = `${state.map.seed}|${state.map.width}|${home.x},${home.y}|${JSON.stringify(profile)}`;
  const hit = landCache.get(key);
  if (hit) return hit;
  const { cost } = dijkstra(b, state.map, home, { profile });
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Number.isFinite(cost[i])) out[i] = 1;
  if (landCache.size > 256) landCache.delete(landCache.keys().next().value!);
  landCache.set(key, out);
  return out;
}

export function needsSea(state: GameState, playerId: PlayerId, goals: Coord[], land: Uint8Array): boolean {
  if (goals.some(g => land[idx(state.map, g.x, g.y)])) return false;
  // Целей по суше нет: если на своей суше осталось неисследованное — сначала разведка.
  const ex = state.explored[playerId];
  for (let i = 0; i < land.length; i++) if (land[i] && ex && !ex[i]) return false;
  return true;
}

/** Ход внутри бюджета по уже рассчитанной стоимости: префикс пути, не заканчивающийся на занятой клетке. */
function prefix(path: Coord[], cost: Float64Array, w: number, budget: number, claimed: Set<number>): Coord[] {
  const out: Coord[] = [];
  for (const s of path) {
    if (cost[s.y * w + s.x] > budget + 1e-9) break;
    out.push(s);
  }
  while (out.length && claimed.has(out[out.length - 1].y * w + out[out.length - 1].x)) out.pop();
  return out;
}

function nearestUnexplored(state: GameState, playerId: PlayerId, from: Coord): Coord | null {
  const ex = state.explored[playerId];
  if (!ex) return null;
  let best: Coord | null = null;
  let bd = Infinity;
  const W = state.map.width;
  for (let i = 0; i < ex.length; i++) {
    if (ex[i]) continue;
    const c = { x: i % W, y: Math.floor(i / W) };
    const d = dist(c, from);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

function landNear(state: GameState, b: Balance, c: Coord): boolean {
  for (const [dx, dy] of DIRS8) if (isLandPassable(b, state.map, c.x + dx, c.y + dy)) return true;
  return false;
}

/** Корабль идёт к цели: ближайшая к ней достижимая клетка воды. */
function sailToward(ctx: NavalCtx, ship: UnitState, target: Coord, wantCoast: boolean): boolean {
  const { b, state } = ctx;
  const move = moveOf(b, state, ship);
  const { cost, prev } = dijkstra(b, state.map, ship, { profile: { naval: true }, blocked: ctx.blockers, budget: move * 20 });
  const W = state.map.width;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < cost.length; i++) {
    if (!Number.isFinite(cost[i]) || ctx.claimed.has(i)) continue;
    const c = { x: i % W, y: Math.floor(i / W) };
    if (wantCoast && !landNear(state, b, c)) continue;
    const score = dist(c, target) * 100 + cost[i];
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || best === idx(state.map, ship.x, ship.y)) return false;
  const path = reconstruct(state.map, prev, { x: best % W, y: Math.floor(best / W) });
  if (!path) return false;
  const steps = prefix(path, cost, W, move, ctx.claimed);
  if (!steps.length) return false;
  if (!ctx.tryPush({ kind: 'unit', unitId: ship.id, mode: 'move', path: steps })) return false;
  const last = steps[steps.length - 1];
  ctx.claimed.add(last.y * W + last.x);
  return true;
}

/** Ближайшая цель за морем (или неисследованная область). */
function seaTarget(ctx: NavalCtx, from: Coord): Coord | null {
  const g = [...ctx.goals].sort((a, c) => dist(from, a) - dist(from, c))[0];
  return g ?? nearestUnexplored(ctx.state, ctx.playerId, from);
}

/** Приказы транспорту и его грузу. */
export function transportOrders(ctx: NavalCtx, t: UnitState, waiting: UnitState[]): void {
  const { b, state } = ctx;
  const cargo = cargoOf(state, t.id).sort((a, c) => (a.id < c.id ? -1 : 1));
  const W = state.map.width;
  if (cargo.length) {
    const target = seaTarget(ctx, t);
    const nearbyWaiting = waiting.some(u => dist(u, t) <= 4);
    const full = (freeSeats(b, state, t) ?? 0) <= 0;
    // Чужой берег рядом (не своя суша) и цель близко (или целей нет) — высадка.
    const foreign = (s: Coord) => !ctx.homeLand[s.y * W + s.x];
    const nearTarget = !ctx.goals.length || (target !== null && dist(t, target) <= 5);
    if (nearTarget) {
      let landed = 0;
      for (const u of cargo) {
        const spots = DIRS8.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy }))
          .filter(s => inBounds(state.map, s.x, s.y) && foreign(s) && isLandPassable(b, state.map, s.x, s.y, moveProfile(b, state, u)) && !ctx.claimed.has(s.y * W + s.x) && !ctx.blockers.has(s.y * W + s.x))
          .sort((a, c) => (target ? dist(a, target) - dist(c, target) : 0) || a.y - c.y || a.x - c.x);
        for (const s of spots) {
          if (ctx.tryPush({ kind: 'unit', unitId: u.id, mode: 'move', path: [s] })) {
            ctx.claimed.add(s.y * W + s.x);
            landed++;
            break;
          }
        }
      }
      if (landed) {
        ctx.tryPush({ kind: 'unit', unitId: t.id, mode: 'hold', path: [] });
        return;
      }
    }
    // Ждём попутчиков, пока есть место и они рядом.
    if (!full && nearbyWaiting && landNear(state, b, t)) {
      ctx.tryPush({ kind: 'unit', unitId: t.id, mode: 'hold', path: [] });
      return;
    }
    if (target && sailToward(ctx, t, target, true)) return;
    ctx.tryPush({ kind: 'unit', unitId: t.id, mode: 'hold', path: [] });
    return;
  }
  // Пустой транспорт идёт к ближайшему ожидающему отряду и встаёт у берега.
  const u = [...waiting].sort((a, c) => dist(a, t) - dist(c, t))[0];
  if (u && dist(u, t) > 1 && sailToward(ctx, t, u, true)) return;
  ctx.tryPush({ kind: 'unit', unitId: t.id, mode: 'hold', path: [] });
}

/** Сухопутный отряд идёт к транспорту и грузится. true — приказ отдан. */
export function embarkOrder(ctx: NavalCtx, u: UnitState, seats: Map<string, number>): boolean {
  const { b, state } = ctx;
  const W = state.map.width;
  const ships = state.units
    .filter(t => t.owner === ctx.playerId && !t.carriedBy && (seats.get(t.id) ?? freeSeats(b, state, t) ?? 0) > 0)
    .sort((a, c) => dist(a, u) - dist(c, u) || (a.id < c.id ? -1 : 1));
  const t = ships[0];
  if (!t) return false;
  const move = moveOf(b, state, u);
  const profile = moveProfile(b, state, u);
  const { cost, prev } = dijkstra(b, state.map, u, { blocked: ctx.blockers, profile, budget: move * 10 });
  let best: Coord | null = null;
  let bc = Infinity;
  for (const [dx, dy] of DIRS8) {
    const s = { x: t.x + dx, y: t.y + dy };
    if (!inBounds(state.map, s.x, s.y)) continue;
    const c = s.x === u.x && s.y === u.y ? 0 : cost[idx(state.map, s.x, s.y)];
    if (c < bc) {
      bc = c;
      best = s;
    }
  }
  if (!best || !Number.isFinite(bc)) return false;
  const free = seats.get(t.id) ?? freeSeats(b, state, t) ?? 0;
  if (bc + b.naval.embarkCost <= move) {
    const path = bc === 0 ? [] : reconstruct(state.map, prev, best) ?? [];
    if (ctx.tryPush({ kind: 'unit', unitId: u.id, mode: 'move', path: [...path, { x: t.x, y: t.y }] })) {
      seats.set(t.id, free - 1);
      return true;
    }
  }
  const path = reconstruct(state.map, prev, best);
  if (!path) return false;
  const steps = prefix(path, cost, W, move, ctx.claimed);
  if (!steps.length) return false;
  if (!ctx.tryPush({ kind: 'unit', unitId: u.id, mode: 'move', path: steps })) return false;
  ctx.claimed.add(steps[steps.length - 1].y * W + steps[steps.length - 1].x);
  return true;
}

/** Боевой корабль без цели для атаки: к видимому противнику на воде или у берега, иначе — охрана транспортов или разведка. */
export function warshipOrders(ctx: NavalCtx, w: UnitState): void {
  const { state } = ctx;
  const foe = ctx.enemies.filter(e => isNaval(ctx.b, e.type) || landNear(state, ctx.b, e)).sort((a, c) => dist(a, w) - dist(c, w))[0];
  const escort = state.units.filter(t => t.owner === ctx.playerId && cargoOf(state, t.id).length).sort((a, c) => dist(a, w) - dist(c, w))[0];
  const target = foe ?? (escort && dist(escort, w) > 2 ? escort : null) ?? nearestUnexplored(state, ctx.playerId, w);
  if (target && sailToward(ctx, w, target, false)) return;
  ctx.tryPush({ kind: 'unit', unitId: w.id, mode: 'hold', path: [] });
}
