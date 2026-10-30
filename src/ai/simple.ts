// Простой бот-противник. Видит только то, что видит его игрок (без чтения скрытых данных).
// Цель — живая партия для тестов и замещения выбывших игроков, а не сильная игра.
import type { Balance } from '../shared/balance.ts';
import type { Coord, GameState, Order, PlayerId } from '../shared/types.ts';
import { dist, idx } from '../engine/grid.ts';
import { dijkstra, findPath, reconstruct } from '../engine/path.ts';
import { knownBlockers } from '../engine/preview.ts';
import { canAttackAfterMove, commanderUnit, moveOf, moveProfile, rangeOf } from '../engine/stats.ts';
import { isBuildingUnlocked, isTechAvailable, isUnitUnlocked, validateOrder } from '../engine/validate.ts';
import { canSeeUnit, computeVision } from '../engine/vision.ts';
import { isHostile } from '../engine/diplomacy.ts';
import { hashParts } from '../engine/rng.ts';
import { coastal, fieldRadius, inResonance, isNaval, linkedObelisks, nearestForeignCity, obelisksOf } from '../engine/world.ts';
import type { NavalCtx } from './naval.ts';
import { embarkOrder, homeLand, needsSea, transportOrders, warshipOrders } from './naval.ts';
import { traitsOf } from '../engine/stats.ts';
import { hasAbility } from '../shared/balance.ts';

/** Предпочтения найма: сначала уникальные юниты народа, затем сильные общие. */
const RECRUIT_PRIORITY = ['legionary', 'ranger', 'warden', 'ironclad', 'corsair', 'tidecaller', 'raider', 'firebrand', 'sentinel', 'cavalry', 'archer', 'spearman', 'shieldbearer', 'infantry'];
const BUILD_PRIORITY = ['farm', 'barracks', 'market', 'mine', 'lumber_mill', 'walls', 'academy', 'forge', 'supply_depot'];
const NAVAL_UNITS = ['transport', 'warship'];
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
  const tr = traitsOf(b, state, playerId);

  // Флот: нужна ли переправа, кто ждёт транспорт.
  const land = homeLand(b, state, playerId);
  const sea = needsSea(state, playerId, goals, land);
  const naval: NavalCtx = { b, state, playerId, blockers, claimed, goals, enemies, tryPush, homeLand: land };
  const seats = new Map<string, number>();
  const waiting = sea ? myUnits.filter(u => !u.carriedBy && !isNaval(b, u.type) && u !== cmd && land[idx(state.map, u.x, u.y)] === 1) : [];
  let obeliskBuilt = false;
  let longSearches = 0;
  let explores = 0;

  for (const u of myUnits) {
    // Груз и транспорты — морская часть.
    if (u.carriedBy) continue;
    if (hasAbility(b, u.type, 'transport')) {
      transportOrders(naval, u, waiting);
      continue;
    }
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
    // Отряд на долгом маршруте без угроз рядом идёт дальше сам — новый поиск пути не нужен.
    if (u.route?.path.length && !enemies.some(e => dist(e, u) <= b.routes.threatRadius + move)) continue;
    // 3а. Особые действия народов: обелиск Хранителей руин, выжженная земля Пепельных орд.
    if (tr.buildObelisk && !obeliskBuilt && u !== cmd && !isNaval(b, u.type) && me.gold >= b.obelisks.goldCost + 12) {
      const linked = linkedObelisks(b, state, playerId);
      const own = obelisksOf(state, playerId);
      const covered = linked.some(o => dist(o, u) <= fieldRadius(b, state, playerId));
      const near = state.cities.some(c => c.owner === playerId && dist(c, u) <= b.obelisks.linkRange) || linked.some(o => dist(o, u) <= b.obelisks.linkRange);
      const fewEnough = own.length < state.cities.filter(c => c.owner === playerId).length * 2 + 1;
      if (!covered && near && fewEnough && tryPush({ kind: 'unit', unitId: u.id, mode: 'build', build: 'obelisk', path: [] })) {
        obeliskBuilt = true;
        continue;
      }
    }
    if (tr.scorch && !isNaval(b, u.type) && u !== cmd) {
      const city = nearestForeignCity(state, playerId, u, b.scorch.radius);
      const quiet = !enemies.some(e => dist(e, u) <= 2);
      if (city && quiet && isHostile(b, state, playerId, city.owner) && hashParts(state.map.seed, state.turn, u.id) % 3 === 0
        && tryPush({ kind: 'unit', unitId: u.id, mode: 'build', build: 'scorch', path: [] })) continue;
    }
    // 3б. Переправа: сухопутные — к транспорту, боевые корабли — по морю.
    if (hasAbility(b, u.type, 'naval')) {
      warshipOrders(naval, u);
      continue;
    }
    if (sea && waiting.includes(u) && embarkOrder(naval, u, seats)) continue;
    // 3. Идти к ближайшему достижимому чужому городу; разведчики и отряды без целей — исследуют карту.
    const scout = b.units[u.type].class === 'scout';
    const goTo = (path: Coord[] | null): boolean => {
      if (!path || !path.length) return false;
      const steps: Coord[] = [];
      for (const s of path) {
        const c = cost[idx(state.map, s.x, s.y)];
        if (!Number.isFinite(c) || c > move) break;
        steps.push(s);
      }
      while (steps.length && claimed.has(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y))) steps.pop();
      if (!steps.length) return false;
      // Длинный путь по разведанным клеткам — долгим маршрутом: следующие ходы он продолжается без нового поиска.
      const longPath = path.length > steps.length && path.length <= b.routes.maxLength && explored && path.every(c => explored[idx(state.map, c.x, c.y)]);
      if (longPath && path.slice(0, steps.length).every((c, k) => c.x === steps[k].x && c.y === steps[k].y)
        && tryPush({ kind: 'unit', unitId: u.id, mode: 'move', path, longRoute: true, stopOnThreat: true })) {
        claimed.add(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y));
        return true;
      }
      if (!tryPush({ kind: 'unit', unitId: u.id, mode: 'move', path: steps })) return false;
      claimed.add(idx(state.map, steps[steps.length - 1].x, steps[steps.length - 1].y));
      return true;
    };
    const towardGoal = (): boolean => {
      // Ограниченный поиск: дальние цели не требуют обхода всей карты каждый ход.
      const sorted = [...goals].sort((a, c) => dist(u, a) - dist(u, c));
      for (const target of sorted.slice(0, 2)) {
        if (goTo(findPath(b, state.map, u, target, { blocked: blockers, budget: move * 12, profile }))) return true;
      }
      // Дальний поход: несколько отрядов за ход ищут путь без жёсткого ограничения.
      if (sorted.length && longSearches < 3) {
        longSearches++;
        if (goTo(findPath(b, state.map, u, sorted[0], { blocked: blockers, budget: move * 40, profile }))) return true;
      }
      return false;
    };
    const explore = (): boolean => {
      // Разведка дорогая (поиск по области): разведчики всегда, остальные — несколько за ход.
      if (!explored || (!scout && explores >= 4)) return false;
      explores++;
      const W = state.map.width;
      const { cost: ec, prev } = dijkstra(b, state.map, u, { blocked: blockers, budget: move * 8, profile });
      let best = -1;
      let bestScore = Infinity;
      const R = move * 8;
      for (let y = Math.max(0, u.y - R); y <= Math.min(state.map.height - 1, u.y + R); y++) for (let x = Math.max(0, u.x - R); x <= Math.min(W - 1, u.x + R); x++) {
        const i = y * W + x;
        if (!Number.isFinite(ec[i]) || ec[i] === 0 || claimed.has(i)) continue;
        let frontier = false;
        for (let dy = -1; dy <= 1 && !frontier; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < state.map.height && !explored[ny * W + nx]) { frontier = true; break; }
        }
        if (!frontier) continue;
        const score = ec[i] + (hashParts(u.id, i) % 4);
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) return false;
      return goTo(reconstruct(state.map, prev, { x: best % W, y: Math.floor(best / W) }));
    };
    if (scout ? explore() || towardGoal() : towardGoal() || explore()) continue;
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
  const abilities = b.factions[me.faction].commander.abilities;
  if (cmd && enemies.some(e => dist(e, cmd) <= 4)) {
    if (abilities.includes('warcry')) tryPush({ kind: 'commander', action: 'ability', ability: 'warcry' });
    else if (abilities.includes('rally')) tryPush({ kind: 'commander', action: 'ability', ability: 'rally' });
  }
  if (abilities.includes('resonance_surge') && myUnits.filter(u => u.hp < u.maxHp && inResonance(b, state, u)).length >= 2) {
    tryPush({ kind: 'commander', action: 'ability', ability: 'resonance_surge' });
  }

  // Города: найм, постройки, специализация.
  const ships = myUnits.filter(u => isNaval(b, u.type));
  const transports = ships.filter(u => hasAbility(b, u.type, 'transport')).length;
  for (const c of state.cities.filter(c => c.owner === playerId && c.queue.length === 0).sort((a, x) => (a.id < x.id ? -1 : 1))) {
    let queued = false;
    // Переправа: порт в прибрежном городе, затем транспорты и боевой корабль.
    if (sea && coastal(state, c)) {
      if (!c.buildings.includes('port')) queued = isBuildingUnlocked(b, me, 'port') && tryPush({ kind: 'construct', cityId: c.id, building: 'port' });
      else if (transports < 2) queued = tryPush({ kind: 'recruit', cityId: c.id, unitType: 'transport' });
      else if (ships.length < 3) queued = tryPush({ kind: 'recruit', cityId: c.id, unitType: 'warship' });
    }
    if (!queued && myUnits.length < 10) {
      for (const type of RECRUIT_PRIORITY) {
        if (!isUnitUnlocked(b, me, type) || NAVAL_UNITS.includes(type)) continue;
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
  if (sea && !me.researched.includes('navigation') && me.researchQueue[0] !== 'navigation') {
    tryPush({ kind: 'research', queue: ['navigation'] });
  } else if (!me.researchQueue.length) {
    // Сначала технологии своего народа, затем общие — по стоимости.
    const available = Object.entries(b.techs)
      .filter(([id, t]) => !me.researched.includes(id) && isTechAvailable(b, me, id) && t.requires.every(r => me.researched.includes(r)))
      .sort((a, c) => Number(!!c[1].faction) - Number(!!a[1].faction) || a[1].cost - c[1].cost || (a[0] < c[0] ? -1 : 1));
    if (available[0]) tryPush({ kind: 'research', queue: [available[0][0]] });
  }
  return orders;
}
