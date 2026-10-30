// Простой бот-противник. Видит только то, что видит его игрок (без чтения скрытых данных).
// Цель — живая партия для тестов и замещения выбывших игроков, а не сильная игра.
import type { Balance } from '../shared/balance.ts';
import type { Coord, GameState, Order, PlayerId } from '../shared/types.ts';
import { dist, idx } from '../engine/grid.ts';
import { dijkstra, findPath } from '../engine/path.ts';
import { knownBlockers } from '../engine/preview.ts';
import { canAttackAfterMove, commanderUnit, moveOf, moveProfile, rangeOf } from '../engine/stats.ts';
import { isBuildingUnlocked, isTechAvailable, isUnitUnlocked, validateOrder } from '../engine/validate.ts';
import { canSeeUnit, computeVision } from '../engine/vision.ts';
import { isHostile } from '../engine/diplomacy.ts';

/** Предпочтения найма: сначала уникальные юниты народа, затем сильные общие. */
const RECRUIT_PRIORITY = ['legionary', 'ranger', 'warden', 'ironclad', 'corsair', 'tidecaller', 'cavalry', 'archer', 'spearman', 'shieldbearer', 'infantry'];
const BUILD_PRIORITY = ['farm', 'barracks', 'market', 'mine', 'lumber_mill', 'walls', 'academy', 'forge', 'supply_depot'];
const PERK_PRIORITY = ['vs_infantry', 'hold_defense', 'suppress_resist', 'forest_move', 'vs_cavalry', 'vs_ranged'];

export function botOrders(b: Balance, state: GameState, playerId: PlayerId): Order[] {
  const me = state.players.find(p => p.id === playerId);
  if (!me || me.eliminated) return [];
  const vision = computeVision(b, state, playerId);
  const explored = state.explored[playerId];
  const orders: Order[] = [];
  const blockers = knownBlockers(b, state, playerId, vision);
  const enemies = state.units.filter(u => u.owner !== playerId && isHostile(b, state, playerId, u.owner) && canSeeUnit(b, state, playerId, vision, u));
  const claimed = new Set<number>();
  const myUnits = state.units.filter(u => u.owner === playerId).sort((a, c) => (a.id < c.id ? -1 : 1));
  for (const u of myUnits) claimed.add(idx(state.map, u.x, u.y));
  const tryPush = (o: Order): boolean => {
    if (!validateOrder(b, state, playerId, o, vision, orders).ok) return false;
    orders.push(o);
    return true;
  };

  const goals: Coord[] = state.cities
    .filter(c => c.owner !== playerId && isHostile(b, state, playerId, c.owner) && explored?.[idx(state.map, c.x, c.y)])
    .map(c => ({ x: c.x, y: c.y }));
  const cmd = commanderUnit(state, playerId);

  for (const u of myUnits) {
    const range = rangeOf(b, state, u);
    const move = moveOf(b, state, u);
    const profile = moveProfile(b, state, u);
    // Улучшение при повышении ранга.
    if (u.pendingPerks > 0) {
      const perk = PERK_PRIORITY.find(p => !u.perks.includes(p));
      if (perk) tryPush({ kind: 'promote', unitId: u.id, perk });
    }
    // Командир держится у столицы и не лезет в бой первым.
    if (u === cmd) {
      orders.push({ kind: 'unit', unitId: u.id, mode: 'hold', path: [] });
      continue;
    }
    // 1. Атака с места.
    const inRange = enemies.filter(e => dist(u, e) <= range).sort((a, c) => a.hp - c.hp);
    if (inRange.length && tryPush({ kind: 'unit', unitId: u.id, mode: 'attack', path: [], targetUnitId: inRange[0].id })) continue;
    // 2. Подойти и атаковать.
    const { cost } = dijkstra(b, state.map, u, { budget: move, blocked: blockers, profile });
    let best: { path: Coord[]; target: string } | null = null;
    const near = canAttackAfterMove(b, state, u) ? enemies.filter(e => dist(u, e) <= move + range).sort((a, c) => a.hp - c.hp) : [];
    if (near.length) {
      const W = state.map.width;
      const reach: number[] = [];
      for (let y = Math.max(0, u.y - move); y <= Math.min(state.map.height - 1, u.y + move); y++)
        for (let x = Math.max(0, u.x - move); x <= Math.min(W - 1, u.x + move); x++) {
          const i = y * W + x;
          if (Number.isFinite(cost[i]) && cost[i] > 0 && !claimed.has(i)) reach.push(i);
        }
      for (const e of near) {
        const spot = reach.find(i => dist({ x: i % W, y: Math.floor(i / W) }, e) <= range);
        if (spot === undefined) continue;
        const p = findPath(b, state.map, u, { x: spot % W, y: Math.floor(spot / W) }, { budget: move, blocked: blockers, profile });
        if (p) {
          best = { path: p, target: e.id };
          break;
        }
      }
    }
    if (best && tryPush({ kind: 'unit', unitId: u.id, mode: 'attack', path: best.path, targetUnitId: best.target })) {
      claimed.add(idx(state.map, best.path[best.path.length - 1].x, best.path[best.path.length - 1].y));
      continue;
    }
    // 3. Идти к ближайшему чужому городу.
    const target = [...goals].sort((a, c) => dist(u, a) - dist(u, c))[0];
    if (target) {
      // Ограниченный поиск: дальние цели не требуют обхода всей карты каждый ход.
      const full = findPath(b, state.map, u, target, { blocked: blockers, budget: move * 12, profile });
      if (full && full.length) {
        // Префикс полного маршрута, укладывающийся в бюджет хода.
        const steps: Coord[] = [];
        for (const s of full) {
          const c = cost[idx(state.map, s.x, s.y)];
          if (!Number.isFinite(c) || c > move) break;
          steps.push(s);
        }
        while (steps.length && claimed.has(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y))) steps.pop();
        if (steps.length && tryPush({ kind: 'unit', unitId: u.id, mode: 'move', path: steps })) {
          claimed.add(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y));
          continue;
        }
      }
    }
    orders.push({ kind: 'unit', unitId: u.id, mode: 'hold', path: [] });
  }

  // Дипломатия: перемирие с более сильным соседом принимаем, союзы и перемирия со слабыми — отклоняем.
  const myStrength = myUnits.length;
  for (const t of state.diplomacy) {
    if (!t.proposal || t.proposal.from === playerId || (t.a !== playerId && t.b !== playerId) || t.proposal.turn >= state.turn) continue;
    const other = t.proposal.from;
    const theirStrength = state.units.filter(u => u.owner === other).length;
    const accept = t.proposal.status === 'truce' && theirStrength >= myStrength;
    tryPush({ kind: 'diplomacy', action: accept ? 'accept' : 'decline', target: other });
  }

  // Командир: направление развития и «Приказ укрепиться», если рядом враг.
  if (me.commander.pendingChoices > 0) {
    const dir = (me.commander.directions.tactics ?? 0) <= (me.commander.directions.logistics ?? 0) ? 'tactics' : 'logistics';
    tryPush({ kind: 'commander', action: 'direction', direction: dir });
  }
  if (cmd && enemies.some(e => dist(e, cmd) <= 4) && b.factions[me.faction].commander.abilities.includes('rally')) {
    tryPush({ kind: 'commander', action: 'ability', ability: 'rally' });
  }

  // Города: найм, постройки, специализация.
  for (const c of state.cities.filter(c => c.owner === playerId && c.queue.length === 0).sort((a, x) => (a.id < x.id ? -1 : 1))) {
    let queued = false;
    if (myUnits.length < 10) {
      for (const type of RECRUIT_PRIORITY) {
        if (!isUnitUnlocked(b, me, type)) continue;
        if (tryPush({ kind: 'recruit', cityId: c.id, unitType: type })) {
          queued = true;
          break;
        }
      }
    }
    if (!queued) {
      const building = BUILD_PRIORITY.find(x => isBuildingUnlocked(b, me, x) && !c.buildings.includes(x));
      if (building) tryPush({ kind: 'construct', cityId: c.id, building });
    }
    if (!c.specialization && c.level >= b.cities.specializeMinLevel) {
      tryPush({ kind: 'specialize', cityId: c.id, specialization: c.isCapital ? 'industrial' : 'trade' });
    }
  }
  if (!me.researchQueue.length) {
    // Сначала технологии своего народа, затем общие — по стоимости.
    const available = Object.entries(b.techs)
      .filter(([id, t]) => !me.researched.includes(id) && isTechAvailable(b, me, id) && t.requires.every(r => me.researched.includes(r)))
      .sort((a, c) => Number(!!c[1].faction) - Number(!!a[1].faction) || a[1].cost - c[1].cost || (a[0] < c[0] ? -1 : 1));
    if (available[0]) tryPush({ kind: 'research', queue: [available[0][0]] });
  }
  return orders;
}
