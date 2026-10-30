// Простой бот-противник. Видит только то, что видит его игрок (без чтения скрытых данных).
import type { Balance } from '../shared/balance.ts';
import type { Coord, GameState, Order, PlayerId } from '../shared/types.ts';
import { dist, idx } from '../engine/grid.ts';
import { dijkstra, findPath } from '../engine/path.ts';
import { knownBlockers } from '../engine/preview.ts';
import { isUnitUnlocked, validateOrder } from '../engine/validate.ts';
import { canSeeUnit, computeVision } from '../engine/vision.ts';

export function botOrders(b: Balance, state: GameState, playerId: PlayerId): Order[] {
  const me = state.players.find(p => p.id === playerId);
  if (!me || me.eliminated) return [];
  const vision = computeVision(b, state, playerId);
  const explored = state.explored[playerId];
  const orders: Order[] = [];
  const blockers = knownBlockers(b, state, playerId, vision);
  const enemies = state.units.filter(u => u.owner !== playerId && canSeeUnit(b, state, playerId, vision, u));
  const claimed = new Set<number>();
  const myUnits = state.units.filter(u => u.owner === playerId).sort((a, c) => (a.id < c.id ? -1 : 1));
  for (const u of state.units) if (u.owner === playerId) claimed.add(idx(state.map, u.x, u.y));

  const goals: Coord[] = state.cities
    .filter(c => c.owner !== playerId && explored?.[idx(state.map, c.x, c.y)])
    .map(c => ({ x: c.x, y: c.y }));

  for (const u of myUnits) {
    const rule = b.units[u.type];
    // 1. Атака с места.
    const inRange = enemies.filter(e => dist(u, e) <= rule.range).sort((a, c) => a.hp - c.hp);
    if (inRange.length) {
      orders.push({ kind: 'unit', unitId: u.id, mode: 'attack', path: [], targetUnitId: inRange[0].id });
      continue;
    }
    // 2. Подойти и атаковать.
    const { cost } = dijkstra(b, state.map, u, { budget: rule.move, blocked: blockers });
    let best: { path: Coord[]; target: string } | null = null;
    const near = enemies.filter(e => dist(u, e) <= rule.move + rule.range).sort((a, c) => a.hp - c.hp);
    if (near.length) {
      const W = state.map.width;
      const reach: number[] = [];
      for (let y = Math.max(0, u.y - rule.move); y <= Math.min(state.map.height - 1, u.y + rule.move); y++)
        for (let x = Math.max(0, u.x - rule.move); x <= Math.min(W - 1, u.x + rule.move); x++) {
          const i = y * W + x;
          if (Number.isFinite(cost[i]) && cost[i] > 0 && !claimed.has(i)) reach.push(i);
        }
      for (const e of near) {
        const spot = reach.find(i => dist({ x: i % W, y: Math.floor(i / W) }, e) <= rule.range);
        if (spot === undefined) continue;
        const p = findPath(b, state.map, u, { x: spot % W, y: Math.floor(spot / W) }, { budget: rule.move, blocked: blockers });
        if (p) {
          best = { path: p, target: e.id };
          break;
        }
      }
    }
    if (best) {
      const o: Order = { kind: 'unit', unitId: u.id, mode: 'attack', path: best.path, targetUnitId: best.target };
      if (validateOrder(b, state, playerId, o, vision).ok) {
        orders.push(o);
        claimed.add(idx(state.map, best.path[best.path.length - 1].x, best.path[best.path.length - 1].y));
        continue;
      }
    }
    // 3. Идти к ближайшему чужому городу (или стоять в обороне столицы).
    const target = goals.sort((a, c) => dist(u, a) - dist(u, c))[0];
    if (target) {
      // Ограниченный поиск: дальние цели не требуют обхода всей карты каждый ход.
      const full = findPath(b, state.map, u, target, { blocked: blockers, budget: rule.move * 12 });
      if (full && full.length) {
        // Берём префикс полного маршрута, укладывающийся в бюджет хода.
        const steps: Coord[] = [];
        for (const s of full) {
          const c = cost[idx(state.map, s.x, s.y)];
          if (!Number.isFinite(c) || c > rule.move) break;
          steps.push(s);
        }
        while (steps.length && claimed.has(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y))) steps.pop();
        if (steps.length) {
          const o: Order = { kind: 'unit', unitId: u.id, mode: 'move', path: steps };
          if (validateOrder(b, state, playerId, o, vision).ok) {
            orders.push(o);
            claimed.add(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y));
            continue;
          }
        }
      }
    }
    orders.push({ kind: 'unit', unitId: u.id, mode: 'hold', path: [] });
  }

  // Найм и исследования.
  const accepted: Order[] = [...orders];
  for (const c of state.cities.filter(c => c.owner === playerId && c.queue.length === 0)) {
    const type = ['archer', 'spearman', 'infantry'].find(t => isUnitUnlocked(b, me, t)) ?? 'infantry';
    const o: Order = { kind: 'recruit', cityId: c.id, unitType: type };
    if (myUnits.length < 8 && validateOrder(b, state, playerId, o, vision, accepted).ok) {
      orders.push(o);
      accepted.push(o);
    }
  }
  if (!me.researchQueue.length) {
    const next = Object.entries(b.techs).find(([id, t]) => !me.researched.includes(id) && t.requires.every(r => me.researched.includes(r)));
    if (next) orders.push({ kind: 'research', queue: [next[0]] });
  }
  return orders;
}
