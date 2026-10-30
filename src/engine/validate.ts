// Проверка приказов. Вызывается при приёме приказа и повторно в начале расчёта хода.
import type { Balance, Materials } from '../shared/balance.ts';
import { hasAbility } from '../shared/balance.ts';
import type { GameState, Order, PlayerId, PlayerState, SubmittedOrder, UnitState } from '../shared/types.ts';
import { Feature, Terrain } from '../shared/types.ts';
import { dist, featuresAt, idx, inBounds, isLandPassable, sameTile, terrainAt } from './grid.ts';
import { pathCost } from './path.ts';
import { canAttackAfterMove, commanderUnit, moveOf, moveProfile, rangeOf, roadGoldCost, traitsOf, techs, unitCost } from './stats.ts';
import type { Vision } from './vision.ts';
import { canSeeUnit } from './vision.ts';
import { findTreaty, isHostile, mayEnter, statusBetween } from './diplomacy.ts';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

// ---------- Доступность ----------

export function isTechAvailable(b: Balance, p: PlayerState, techId: string): boolean {
  const t = b.techs[techId];
  if (!t) return false;
  if (t.faction && t.faction !== p.faction) return false;
  if ((t.excludes ?? []).some(x => p.researched.includes(x))) return false;
  return true;
}

export function isUnitUnlocked(b: Balance, p: PlayerState, unitType: string): boolean {
  const rule = b.units[unitType];
  if (!rule || rule.recruitable === false) return false;
  if (rule.faction && rule.faction !== p.faction) return false;
  return !rule.requires || p.researched.includes(rule.requires);
}

export function isBuildingUnlocked(b: Balance, p: PlayerState, building: string): boolean {
  const rule = b.buildings[building];
  if (!rule) return false;
  return !rule.requires || p.researched.includes(rule.requires);
}

// ---------- Резерв ресурсов ----------

export type Resources = { gold: number } & Materials;

/** Ресурсы, зарезервированные приказами (списываются при расчёте один раз). */
export function reservedResources(b: Balance, state: GameState, playerId: PlayerId, orders: Order[]): Resources {
  const r: Resources = { gold: 0, wood: 0, iron: 0, crystal: 0 };
  for (const o of orders) {
    if (o.kind === 'recruit' && b.units[o.unitType]) {
      const c = unitCost(b, state, playerId, o.unitType);
      r.gold += c.gold; r.wood += c.wood; r.iron += c.iron; r.crystal += c.crystal;
    } else if (o.kind === 'construct' && b.buildings[o.building]) {
      const c = b.buildings[o.building].cost;
      r.wood += c.wood ?? 0; r.iron += c.iron ?? 0; r.crystal += c.crystal ?? 0;
    } else if (o.kind === 'unit' && o.mode === 'build') {
      if (o.build === 'road') r.gold += roadGoldCost(b, state, playerId);
      if (o.build === 'fort') { r.gold += b.forts.goldCost; r.wood += b.forts.woodCost; }
      if (o.build === 'forest') r.gold += b.plantForest.goldCost;
    }
  }
  return r;
}

/** Совместимость: только золото. */
export function reservedGold(b: Balance, orders: Order[], state?: GameState, playerId?: PlayerId): number {
  if (state && playerId) return reservedResources(b, state, playerId, orders).gold;
  let sum = 0;
  for (const o of orders) {
    if (o.kind === 'recruit') sum += b.units[o.unitType]?.cost.gold ?? 0;
    if (o.kind === 'unit' && o.mode === 'build') sum += o.build === 'fort' ? b.forts.goldCost : o.build === 'forest' ? b.plantForest.goldCost : b.roads.goldCost;
  }
  return sum;
}

function canAfford(p: PlayerState, need: Resources, reserved: Resources): boolean {
  return p.gold - reserved.gold >= need.gold && (['wood', 'iron', 'crystal'] as const).every(k => p.materials[k] - reserved[k] >= need[k]);
}

// ---------- Способности командира, влияющие на проверку ----------

/** Отряды, получающие «Ускоренный марш» в этом ходу (если среди приказов игрока есть эта способность). */
export function forcedMarchUnits(b: Balance, state: GameState, playerId: PlayerId, orders: Order[]): Set<string> {
  const o = orders.find(x => x.kind === 'commander' && x.action === 'ability' && x.ability === 'forced_march');
  if (!o) return new Set();
  const cmd = commanderUnit(state, playerId);
  if (!cmd) return new Set();
  return new Set(state.units.filter(u => u.owner === playerId && dist(u, cmd) <= b.commander.auraRadius).map(u => u.id));
}

function inTerritory(b: Balance, state: GameState, playerId: PlayerId, at: { x: number; y: number }): boolean {
  return state.cities.some(c => c.owner === playerId && !c.contestedBy && dist(c, at) <= b.roads.territoryRadius);
}

function canBuild(b: Balance, state: GameState, unit: UnitState, kind: string): string | null {
  const tr = traitsOf(b, state, unit.owner);
  const builder = hasAbility(b, unit.type, 'build') || b.roads.builders.includes(unit.type);
  if (kind === 'road') return builder ? null : 'unit_cannot_build';
  if (kind === 'fort') return hasAbility(b, unit.type, 'build_fort') || (tr.buildFort && builder) ? null : 'unit_cannot_build';
  if (kind === 'forest') {
    if (hasAbility(b, unit.type, 'plant_forest')) return null;
    return tr.plantForest && builder && techs(b, state, unit.owner).plantForestAny ? null : 'unit_cannot_build';
  }
  return 'unknown_build';
}

// ---------- Проверка ----------

export function validateOrder(
  b: Balance,
  state: GameState,
  playerId: PlayerId,
  order: Order,
  vision: Vision,
  otherOrders: Order[] = [],
): ValidationResult {
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.eliminated) return fail('not_a_player');
  const reservedBy = (exclude: (o: Order) => boolean) => reservedResources(b, state, playerId, otherOrders.filter(o => !exclude(o)));

  switch (order.kind) {
    case 'unit': {
      const unit = state.units.find(u => u.id === order.unitId);
      if (!unit || unit.hp <= 0) return fail('unit_not_found');
      if (unit.owner !== playerId) return fail('not_owner');
      if (!['move', 'attack', 'hold', 'build'].includes(order.mode)) return fail('bad_mode');
      const long = order.mode === 'move' && order.longRoute === true;
      const maxLen = long ? b.routes.maxLength : 32;
      if (!Array.isArray(order.path) || order.path.length > maxLen) return fail('bad_path');
      if (order.mode === 'hold') return order.path.length ? fail('hold_has_path') : { ok: true };
      if (order.mode === 'build') {
        if (order.path.length) return fail('build_has_path');
        const kind = order.build ?? 'road';
        const who = canBuild(b, state, unit, kind);
        if (who) return fail(who);
        if (!isLandPassable(b, state.map, unit.x, unit.y)) return fail('impassable');
        const f = featuresAt(state.map, unit.x, unit.y);
        const onCity = state.cities.some(c => c.x === unit.x && c.y === unit.y);
        if (kind === 'road') {
          if (f & (Feature.Road | Feature.Bridge)) return fail('road_exists');
          if (!inTerritory(b, state, playerId, unit)) return fail('outside_territory');
        } else if (kind === 'fort') {
          if (f & Feature.Fort) return fail('fort_exists');
          if (onCity) return fail('fort_in_city');
        } else if (kind === 'forest') {
          if (terrainAt(state.map, unit.x, unit.y) !== Terrain.Plains || onCity) return fail('forest_needs_plains');
          if (!inTerritory(b, state, playerId, unit)) return fail('outside_territory');
        }
        const need = reservedResources(b, state, playerId, [order]);
        if (!canAfford(player, need, reservedBy(o => o.kind === 'unit' && o.unitId === unit.id))) return fail(need.wood ? 'not_enough_resources' : 'not_enough_gold');
        return { ok: true };
      }
      for (const s of order.path) if (!inBounds(state.map, s.x, s.y)) return fail('out_of_bounds');
      const profile = moveProfile(b, state, unit);
      const pc = pathCost(b, state.map, unit, order.path, profile);
      if (!pc.ok) return pc;
      if (long) {
        // Маршрут прокладывается только по исследованным клеткам: иначе проверка раскрыла бы местность.
        const ex = state.explored[playerId];
        for (const s of order.path) if (!ex || !ex[idx(state.map, s.x, s.y)]) return fail('route_through_unexplored');
      } else {
        const budget = moveOf(b, state, unit, forcedMarchUnits(b, state, playerId, otherOrders));
        if (pc.cost > budget + 1e-9) return fail('not_enough_movement');
      }
      // Договоры: перемирие закрывает чужую территорию.
      {
        let prev: { x: number; y: number } = unit;
        for (const s of order.path) {
          if (!mayEnter(b, state, playerId, prev, s)) return fail('territory_closed');
          prev = s;
        }
      }
      // Нельзя прокладывать путь через видимых игроку чужих отрядов.
      // Невидимые отряды не учитываются — иначе проверка раскрыла бы их положение.
      for (const s of order.path) {
        const blocker = state.units.find(u => u.hp > 0 && u.owner !== playerId && u.x === s.x && u.y === s.y);
        if (blocker && canSeeUnit(b, state, playerId, vision, blocker)) return fail('path_through_enemy');
      }
      if (order.mode === 'move') return order.path.length ? { ok: true } : fail('empty_path');
      // attack
      if (!order.targetUnitId) return fail('no_target');
      const target = state.units.find(u => u.id === order.targetUnitId);
      if (!target || target.hp <= 0 || !canSeeUnit(b, state, playerId, vision, target)) return fail('target_not_visible');
      if (target.owner === playerId) return fail('friendly_target');
      if (!isHostile(b, state, playerId, target.owner)) return fail('treaty_forbids_attack');
      if (order.path.length && !canAttackAfterMove(b, state, unit)) return fail('cannot_attack_after_move');
      if (order.ability === 'knockback' && !hasAbility(b, unit.type, 'knockback')) return fail('ability_unavailable');
      const end = order.path.length ? order.path[order.path.length - 1] : unit;
      if (sameTile(end, target)) return fail('path_ends_on_target');
      if (dist(end, target) > rangeOf(b, state, unit)) return fail('target_out_of_range');
      return { ok: true };
    }
    case 'recruit': {
      const city = state.cities.find(c => c.id === order.cityId);
      if (!city || city.owner !== playerId) return fail('not_city_owner');
      if (city.contestedBy) return fail('city_contested');
      if (!b.units[order.unitType]) return fail('unknown_unit');
      if (!isUnitUnlocked(b, player, order.unitType)) return fail('unit_locked');
      if (city.queue.length >= b.cities.maxQueue) return fail('queue_full');
      if (b.economy.deficitRecruitBlocked && player.gold < 0) return fail('deficit');
      const c = unitCost(b, state, playerId, order.unitType);
      const reserved = reservedBy(o => o.kind === 'recruit' && o.cityId === order.cityId);
      if (player.gold - reserved.gold < c.gold) return fail('not_enough_gold');
      if (!canAfford(player, { gold: c.gold, wood: c.wood, iron: c.iron, crystal: c.crystal }, reserved)) return fail('not_enough_resources');
      return { ok: true };
    }
    case 'construct': {
      const city = state.cities.find(c => c.id === order.cityId);
      if (!city || city.owner !== playerId) return fail('not_city_owner');
      if (city.contestedBy) return fail('city_contested');
      const rule = b.buildings[order.building];
      if (!rule) return fail('unknown_building');
      if (!isBuildingUnlocked(b, player, order.building)) return fail('building_locked');
      if (city.buildings.includes(order.building) || city.queue.some(q => q.kind === 'building' && q.unitType === order.building)) return fail('building_exists');
      if (city.queue.length >= b.cities.maxQueue) return fail('queue_full');
      const need = { gold: 0, wood: rule.cost.wood ?? 0, iron: rule.cost.iron ?? 0, crystal: rule.cost.crystal ?? 0 };
      if (!canAfford(player, need, reservedBy(o => o.kind === 'construct' && o.cityId === order.cityId))) return fail('not_enough_resources');
      return { ok: true };
    }
    case 'specialize': {
      const city = state.cities.find(c => c.id === order.cityId);
      if (!city || city.owner !== playerId) return fail('not_city_owner');
      if (!b.specializations[order.specialization]) return fail('unknown_specialization');
      if (city.specialization) return fail('already_specialized');
      if (city.level < b.cities.specializeMinLevel) return fail('city_level_too_low');
      return { ok: true };
    }
    case 'promote': {
      const u = state.units.find(x => x.id === order.unitId);
      if (!u || u.owner !== playerId) return fail('not_owner');
      if (u.pendingPerks <= 0) return fail('no_promotion');
      if (!b.perks[order.perk]) return fail('unknown_perk');
      if (u.perks.includes(order.perk)) return fail('perk_owned');
      return { ok: true };
    }
    case 'commander': {
      const cs = player.commander;
      if (order.action === 'direction') {
        if (!order.direction || !b.commander.directions[order.direction]) return fail('unknown_direction');
        if (cs.pendingChoices <= 0) return fail('no_choice_available');
        if ((cs.directions[order.direction] ?? 0) >= 3) return fail('direction_maxed');
        return { ok: true };
      }
      const ab = order.ability ? b.commander.abilities[order.ability] : undefined;
      if (!ab || !order.ability) return fail('unknown_ability');
      if (!b.factions[player.faction].commander.abilities.includes(order.ability)) return fail('ability_unavailable');
      const cmd = commanderUnit(state, playerId);
      if (!cmd) return fail('commander_absent');
      if ((cs.cooldowns[order.ability] ?? 0) > state.turn) return fail('ability_on_cooldown');
      if (cs.points < ab.cost) return fail('not_enough_command_points');
      if (order.ability === 'scout_pulse') {
        const t = order.target;
        if (!t || !inBounds(state.map, t.x, t.y)) return fail('bad_target');
        if (dist(cmd, t) > (ab.range ?? 8)) return fail('target_out_of_range');
      }
      return { ok: true };
    }
    case 'diplomacy': {
      const other = state.players.find(p => p.id === order.target);
      if (!other || other.id === playerId) return fail('bad_target');
      if (other.eliminated) return fail('target_eliminated');
      const t = findTreaty(state, playerId, other.id);
      const current = statusBetween(b, state, playerId, other.id);
      if (order.action === 'propose') {
        const st = order.status;
        if (!st || !b.diplomacy.statuses[st]) return fail('unknown_status');
        if (st === 'war') return fail('use_break');
        if (st === current) return fail('already_in_status');
        if (st === 'alliance' && !state.mode.alliances) return fail('alliances_disabled');
        if (t?.pending) return fail('break_pending');
        return { ok: true };
      }
      if (order.action === 'accept') {
        if (!t?.proposal || t.proposal.from !== other.id) return fail('no_proposal');
        if (t.proposal.turn >= state.turn) return fail('proposal_not_delivered');
        if (t.proposal.status === 'alliance' && !state.mode.alliances) return fail('alliances_disabled');
        return { ok: true };
      }
      if (order.action === 'decline') return t?.proposal && t.proposal.from === other.id ? { ok: true } : fail('no_proposal');
      if (order.action === 'break') {
        if (current === 'war') return fail('already_at_war');
        if (t?.pending) return fail('break_pending');
        return { ok: true };
      }
      return fail('unknown_action');
    }
    case 'research': {
      if (!Array.isArray(order.queue) || order.queue.length > 10) return fail('bad_queue');
      const known = new Set(player.researched);
      const seen = new Set<string>();
      for (const t of order.queue) {
        const rule = b.techs[t];
        if (!rule) return fail('unknown_tech');
        if (!isTechAvailable(b, player, t)) return fail('tech_unavailable');
        if ((rule.excludes ?? []).some(x => seen.has(x))) return fail('tech_excluded');
        if (known.has(t) || seen.has(t)) return fail('tech_duplicate');
        for (const r of rule.requires) if (!known.has(r) && !seen.has(r)) return fail(`tech_requires:${r}`);
        seen.add(t);
      }
      return { ok: true };
    }
    default:
      return fail('unknown_order');
  }
}

/** Приказы командира проверяются первыми: «Ускоренный марш» влияет на проверку путей. */
function orderRank(o: Order): number {
  return o.kind === 'commander' ? 0 : 1;
}

/** Проверка набора приказов в детерминированном порядке. */
export function validateAll(b: Balance, state: GameState, orders: SubmittedOrder[], vision: Map<PlayerId, Vision>) {
  const accepted: SubmittedOrder[] = [];
  const rejected: { order: SubmittedOrder; reason: string }[] = [];
  const sorted = [...orders].sort((a, c) =>
    a.playerId < c.playerId ? -1 : a.playerId > c.playerId ? 1 : orderRank(a.order) - orderRank(c.order) || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
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
