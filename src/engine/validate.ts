// Проверка приказов. Вызывается при приёме приказа и повторно в начале расчёта хода.
import type { Balance } from '../shared/balance.ts';
import type { GameState, Order, PlayerId, PlayerState, SubmittedOrder } from '../shared/types.ts';
import { dist, inBounds, sameTile } from './grid.ts';
import { pathCost } from './path.ts';
import type { Vision } from './vision.ts';
import { canSeeUnit } from './vision.ts';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const MAX_QUEUE = 3;

export function isUnitUnlocked(b: Balance, p: PlayerState, unitType: string): boolean {
  const rule = b.units[unitType];
  if (!rule) return false;
  return !rule.requires || p.researched.includes(rule.requires);
}

/** Золото, зарезервированное приказами найма (списывается при расчёте один раз). */
export function reservedGold(b: Balance, orders: Order[]): number {
  let sum = 0;
  for (const o of orders) if (o.kind === 'recruit') sum += b.units[o.unitType]?.cost.gold ?? 0;
  return sum;
}

export function validateOrder(
  b: Balance,
  state: GameState,
  playerId: PlayerId,
  order: Order,
  vision: Vision,
  otherOrders: Order[] = [],
): ValidationResult {
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.eliminated) return { ok: false, reason: 'not_a_player' };

  switch (order.kind) {
    case 'unit': {
      const unit = state.units.find(u => u.id === order.unitId);
      if (!unit || unit.hp <= 0) return { ok: false, reason: 'unit_not_found' };
      if (unit.owner !== playerId) return { ok: false, reason: 'not_owner' };
      if (!['move', 'attack', 'hold'].includes(order.mode)) return { ok: false, reason: 'bad_mode' };
      if (!Array.isArray(order.path) || order.path.length > 32) return { ok: false, reason: 'bad_path' };
      if (order.mode === 'hold') {
        if (order.path.length) return { ok: false, reason: 'hold_has_path' };
        return { ok: true };
      }
      for (const s of order.path) if (!inBounds(state.map, s.x, s.y)) return { ok: false, reason: 'out_of_bounds' };
      const pc = pathCost(b, state.map, unit, order.path);
      if (!pc.ok) return pc;
      if (pc.cost > b.units[unit.type].move + 1e-9) return { ok: false, reason: 'not_enough_movement' };
      // Нельзя прокладывать путь через видимых игроку чужих отрядов.
      // Невидимые отряды не учитываются — иначе проверка раскрыла бы их положение.
      for (const s of order.path) {
        const blocker = state.units.find(u => u.hp > 0 && u.owner !== playerId && u.x === s.x && u.y === s.y);
        if (blocker && canSeeUnit(b, state, playerId, vision, blocker)) return { ok: false, reason: 'path_through_enemy' };
      }
      if (order.mode === 'move') {
        if (!order.path.length) return { ok: false, reason: 'empty_path' };
        return { ok: true };
      }
      // attack
      if (!order.targetUnitId) return { ok: false, reason: 'no_target' };
      const target = state.units.find(u => u.id === order.targetUnitId);
      if (!target || target.hp <= 0 || !canSeeUnit(b, state, playerId, vision, target)) return { ok: false, reason: 'target_not_visible' };
      if (target.owner === playerId) return { ok: false, reason: 'friendly_target' };
      const end = order.path.length ? order.path[order.path.length - 1] : unit;
      if (sameTile(end, target)) return { ok: false, reason: 'path_ends_on_target' };
      if (dist(end, target) > b.units[unit.type].range) return { ok: false, reason: 'target_out_of_range' };
      return { ok: true };
    }
    case 'recruit': {
      const city = state.cities.find(c => c.id === order.cityId);
      if (!city || city.owner !== playerId) return { ok: false, reason: 'not_city_owner' };
      if (city.contestedBy) return { ok: false, reason: 'city_contested' };
      if (!b.units[order.unitType]) return { ok: false, reason: 'unknown_unit' };
      if (!isUnitUnlocked(b, player, order.unitType)) return { ok: false, reason: 'unit_locked' };
      if (city.queue.length >= MAX_QUEUE) return { ok: false, reason: 'queue_full' };
      if (b.economy.deficitRecruitBlocked && player.gold < 0) return { ok: false, reason: 'deficit' };
      const others = otherOrders.filter(o => !(o.kind === 'recruit' && o.cityId === order.cityId));
      const available = player.gold - reservedGold(b, others);
      if (available < b.units[order.unitType].cost.gold) return { ok: false, reason: 'not_enough_gold' };
      return { ok: true };
    }
    case 'research': {
      if (!Array.isArray(order.queue) || order.queue.length > 10) return { ok: false, reason: 'bad_queue' };
      const known = new Set(player.researched);
      const seen = new Set<string>();
      for (const t of order.queue) {
        const rule = b.techs[t];
        if (!rule) return { ok: false, reason: 'unknown_tech' };
        if (known.has(t) || seen.has(t)) return { ok: false, reason: 'tech_duplicate' };
        for (const r of rule.requires) if (!known.has(r) && !seen.has(r)) return { ok: false, reason: `tech_requires:${r}` };
        seen.add(t);
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unknown_order' };
  }
}

/** Проверка набора приказов игрока в детерминированном порядке. */
export function validateAll(b: Balance, state: GameState, orders: SubmittedOrder[], vision: Map<PlayerId, Vision>) {
  const accepted: SubmittedOrder[] = [];
  const rejected: { order: SubmittedOrder; reason: string }[] = [];
  const sorted = [...orders].sort((a, c) => (a.playerId < c.playerId ? -1 : a.playerId > c.playerId ? 1 : a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
  const acceptedByPlayer = new Map<PlayerId, Order[]>();
  for (const so of sorted) {
    const v = vision.get(so.playerId);
    if (!v) {
      rejected.push({ order: so, reason: 'not_a_player' });
      continue;
    }
    const prior = acceptedByPlayer.get(so.playerId) ?? [];
    const r = validateOrder(b, state, so.playerId, so.order, v, prior);
    if (r.ok) {
      accepted.push(so);
      prior.push(so.order);
      acceptedByPlayer.set(so.playerId, prior);
    } else rejected.push({ order: so, reason: r.reason });
  }
  return { accepted, rejected };
}

