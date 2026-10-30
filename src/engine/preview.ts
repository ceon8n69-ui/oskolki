// Предпросмотр для интерфейса: доступные клетки и прогноз боя. Учитывает только то, что игрок видит.
import type { Balance } from '../shared/balance.ts';
import { hasAbility } from '../shared/balance.ts';
import type { AttackPreview } from '../shared/protocol.ts';
import type { Coord, GameState, Order, PlayerId } from '../shared/types.ts';
import { computeDamage } from './combat.ts';
import { DIRS8, idx, isLandPassable } from './grid.ts';
import { freeSeats, isNaval } from './world.ts';
import { reachable } from './path.ts';
import { moveOf, moveProfile } from './stats.ts';
import { forcedMarchUnits, validateOrder } from './validate.ts';
import type { Vision } from './vision.ts';
import { canSeeUnit } from './vision.ts';

export const SIMULTANEOUS_WARNING = 'Прогноз по текущему состоянию: одновременные приказы противника могут изменить результат.';

export function knownBlockers(b: Balance, state: GameState, playerId: PlayerId, vision: Vision): Set<number> {
  const out = new Set<number>();
  for (const u of state.units) {
    if (u.owner !== playerId && canSeeUnit(b, state, playerId, vision, u)) out.add(idx(state.map, u.x, u.y));
  }
  return out;
}

/** Клетки рядом с видимыми противниками, держащими зону контроля: войти можно, пройти дальше — нет. */
export function knownZoc(b: Balance, state: GameState, playerId: PlayerId, vision: Vision): Set<number> {
  const out = new Set<number>();
  for (const e of state.units) {
    if (e.owner === playerId || !hasAbility(b, e.type, 'zoc') || !canSeeUnit(b, state, playerId, vision, e)) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = e.x + dx, y = e.y + dy;
      if ((dx || dy) && x >= 0 && y >= 0 && x < state.map.width && y < state.map.height) out.add(idx(state.map, x, y));
    }
  }
  return out;
}

export function moveOptions(b: Balance, state: GameState, playerId: PlayerId, unitId: string, vision: Vision, orders: Order[] = []): { x: number; y: number; cost: number; embark?: boolean; disembark?: boolean }[] {
  const u = state.units.find(x => x.id === unitId && x.owner === playerId);
  if (!u) return [];
  const budget = moveOf(b, state, u, forcedMarchUnits(b, state, playerId, orders));
  const profile = moveProfile(b, state, u);
  const blockers = knownBlockers(b, state, playerId, vision);
  // С борта — только высадка на соседнюю свободную сушу.
  if (u.carriedBy) {
    const out: { x: number; y: number; cost: number; disembark?: boolean }[] = [];
    for (const [dx, dy] of DIRS8) {
      const x = u.x + dx, y = u.y + dy;
      if (!isLandPassable(b, state.map, x, y, profile) || blockers.has(idx(state.map, x, y))) continue;
      if (state.units.some(o => o.owner === playerId && !o.carriedBy && o.x === x && o.y === y)) continue;
      out.push({ x, y, cost: budget, disembark: true });
    }
    return out;
  }
  const stopTiles = hasAbility(b, u.type, 'ignore_zoc') ? undefined : knownZoc(b, state, playerId, vision);
  const r = reachable(b, state.map, u, budget, blockers, { profile, stopTiles });
  const out: { x: number; y: number; cost: number; embark?: boolean }[] = [...r].map(([i, cost]) => ({ x: i % state.map.width, y: Math.floor(i / state.map.width), cost }));
  // Погрузка на свои транспорты рядом с достижимыми клетками.
  if (!isNaval(b, u.type)) {
    for (const t of state.units) {
      if (t.owner !== playerId || (freeSeats(b, state, t) ?? 0) <= 0) continue;
      let best = Infinity;
      for (const [dx, dy] of DIRS8) {
        const x = t.x + dx, y = t.y + dy;
        if (x === u.x && y === u.y) best = 0;
        else if (x >= 0 && y >= 0 && x < state.map.width && y < state.map.height) best = Math.min(best, r.get(idx(state.map, x, y)) ?? Infinity);
      }
      if (best + b.naval.embarkCost <= budget + 1e-9) out.push({ x: t.x, y: t.y, cost: best + b.naval.embarkCost, embark: true });
    }
  }
  return out;
}

/**
 * Прогноз боя. Засада в прогнозе не показывается: иначе прогноз раскрывал бы, видит ли противник отряд.
 */
export function previewAttack(b: Balance, state: GameState, playerId: PlayerId, unitId: string, path: Coord[], targetUnitId: string, vision: Vision, orders: Order[] = []): AttackPreview {
  const v = validateOrder(b, state, playerId, { kind: 'unit', unitId, mode: 'attack', path, targetUnitId }, vision, orders);
  if (!v.ok) return { ok: false, reason: v.reason, warning: SIMULTANEOUS_WARNING };
  const attacker = structuredClone(state.units.find(u => u.id === unitId)!);
  const end = path.length ? path[path.length - 1] : attacker;
  attacker.x = end.x;
  attacker.y = end.y;
  if (path.length) attacker.statuses = attacker.statuses.filter(s => s.id !== 'fortified');
  // Состояние «после подхода»: соседство для прикрытия и строя считается от новой клетки.
  const st: GameState = { ...state, units: state.units.map(u => (u.id === unitId ? attacker : u)) };
  const target = st.units.find(u => u.id === targetUnitId)!;
  const r = computeDamage(b, st, attacker, target);
  return { ok: true, damage: r.damage, counter: r.counter, counterPossible: r.counterPossible && target.hp - r.damage > 0, modifiers: r.modifiers, warning: SIMULTANEOUS_WARNING };
}
