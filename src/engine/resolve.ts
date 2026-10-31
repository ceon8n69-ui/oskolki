// Серверный расчёт хода. Чистая функция: (состояние, приказы) → (новое состояние, события).
// Порядок фаз задокументирован в docs/TURN_RESOLUTION.md и не должен меняться без смены rulesVersion.
import type { Balance } from '../shared/balance.ts';
import { hasAbility } from '../shared/balance.ts';
import type {
  BuildKind,
  CityState,
  Coord,
  GameState,
  PlayerId,
  PlayerState,
  StoredEvent,
  SubmittedOrder,
  TurnEvent,
  UnitOrder,
  UnitState,
} from '../shared/types.ts';
import { Feature, NEUTRAL, Terrain } from '../shared/types.ts';
import { canonicalize } from './canonical.ts';
import type { CombatContext } from './combat.ts';
import { computeDamage, rankForXp } from './combat.ts';
import { newUnit } from './factory.ts';
import { DIRS8, dist, idx, inBounds, isLandPassable, landMoveCost } from './grid.ts';
import { hashParts, turnSeed } from './rng.ts';
import { planRoutes, updateRoutesAfterMove } from './routes.ts';
import {
  baseMaxHp, commanderAura, commanderUnit, moveOf, moveProfile, playerOf, rangeOf, techs, traitsOf, unitCost, waterDistance, worldEffect, worldHas,
} from './stats.ts';
import { cityBuildingEffect, computeSupply } from './supply.ts';
import { validateAll } from './validate.ts';
import { checkVictory, exertsZocOn, isHostile, mayEnter, objectiveHolder, treatyOf } from './diplomacy.ts';
import type { ExtraVision, Vision } from './vision.ts';
import { canSeeUnitAt, computeAllVision, updateExploredAndIntel } from './vision.ts';
import {
  embarkTarget, freeSeats, inResonance, isLootableRuin, isNaval, linkedObelisks, nearestForeignCity, onMap, rollWorldEvent, ruinReward,
} from './world.ts';

export const RULES_VERSION = 'rules-4.0.0';

export interface ResolveResult {
  state: GameState;
  events: StoredEvent[];
}

class EventLog {
  events: StoredEvent[] = [];
  phase = 'validate';
  push(event: TurnEvent, visibleTo: Iterable<PlayerId>): void {
    const set = [...new Set(visibleTo)].filter(p => p !== NEUTRAL).sort();
    this.events.push({ seq: this.events.length, phase: this.phase, visibleTo: set, event });
  }
}

/** Обстоятельства текущего хода, не входящие в состояние. */
interface TurnCtx {
  extraVision: ExtraVision[];
  siegeSupport: Set<string>;
  forcedMarch: Set<string>;
  rally: Map<PlayerId, Set<string>>;
  acted: Set<string>; // двигались или атаковали — не лечатся
  startPos: Map<string, Coord>;
  warcry: Set<string>;
  surge: Set<PlayerId>;
}

function removeStatus(u: UnitState, id: string): void {
  u.statuses = u.statuses.filter(s => s.id !== id);
}

function addStatus(u: UnitState, id: string, source: string, expiresTurn: number | null): void {
  removeStatus(u, id);
  u.statuses.push({ id, source, expiresTurn });
}

const sortById = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

export function resolveTurn(b: Balance, input: GameState, orders: SubmittedOrder[]): ResolveResult {
  const state = canonicalize(structuredClone(input));
  const log = new EventLog();
  const seed = turnSeed(state.map.seed, state.turn);
  const players = state.players.map(p => p.id);
  const ctx: TurnCtx = { extraVision: [], siegeSupport: new Set(), forcedMarch: new Set(), rally: new Map(), acted: new Set(), startPos: new Map(), warcry: new Set(), surge: new Set() };
  for (const u of state.units) ctx.startPos.set(u.id, { x: u.x, y: u.y });

  // Истёкшие состояния (например, подавление прошлого хода).
  for (const u of state.units) u.statuses = u.statuses.filter(s => s.expiresTurn === null || s.expiresTurn >= state.turn);

  // ---------- 0. Сдача: до проверки приказов, остальные приказы сдавшегося отклоняются ----------
  for (const so of [...orders].filter(o => o.order.kind === 'surrender').sort((a, c) => (a.playerId < c.playerId ? -1 : 1))) applySurrender(state, so.playerId, log, players);

  // ---------- 1. Проверка приказов и списание ресурсов ----------
  const vision0 = computeAllVision(b, state);
  const { accepted, rejected } = validateAll(b, state, orders, vision0);
  for (const r of rejected) log.push({ t: 'order_rejected', playerId: r.order.playerId, orderId: r.order.id, reason: r.reason }, [r.order.playerId]);

  const unitOrders = new Map<string, UnitOrder>();
  const diplomacyOrders: SubmittedOrder[] = [];
  const builds = new Map<string, { u: UnitState; kind: BuildKind }>();
  for (const so of accepted) {
    const o = so.order;
    const p = playerOf(state, so.playerId)!;
    switch (o.kind) {
      case 'unit': {
        unitOrders.set(o.unitId, o);
        if (o.mode === 'build') {
          const u = state.units.find(x => x.id === o.unitId)!;
          const kind = o.build ?? 'road';
          const cost = buildCost(b, state, p.id, kind);
          p.gold -= cost.gold;
          p.materials.wood -= cost.wood;
          builds.set(u.id, { u, kind });
          log.push({ t: 'build_started', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, build: kind, goldSpent: cost.gold }, visibleToUnitAt(b, state, vision0, u, u, players));
        }
        break;
      }
      case 'recruit': {
        // Золото и материалы списываются один раз при постановке в очередь.
        const city = state.cities.find(c => c.id === o.cityId)!;
        const c = unitCost(b, state, p.id, o.unitType);
        p.gold -= c.gold;
        p.materials.wood -= c.wood;
        p.materials.iron -= c.iron;
        p.materials.crystal -= c.crystal;
        city.queue.push({ kind: 'unit', unitType: o.unitType, progress: 0, paid: true, orderId: so.id });
        log.push({ t: 'production_queued', cityId: city.id, owner: p.id, unitType: o.unitType, goldSpent: c.gold }, [p.id]);
        break;
      }
      case 'construct': {
        const city = state.cities.find(c => c.id === o.cityId)!;
        const c = b.buildings[o.building].cost;
        p.materials.wood -= c.wood ?? 0;
        p.materials.iron -= c.iron ?? 0;
        p.materials.crystal -= c.crystal ?? 0;
        city.queue.push({ kind: 'building', unitType: o.building, progress: 0, paid: true, orderId: so.id });
        log.push({ t: 'construction_queued', cityId: city.id, owner: p.id, building: o.building }, [p.id]);
        break;
      }
      case 'specialize': {
        const city = state.cities.find(c => c.id === o.cityId)!;
        city.specialization = o.specialization;
        const watchers = players.filter(pl => vision0.get(pl)!.visible[idx(state.map, city.x, city.y)]);
        log.push({ t: 'city_specialized', cityId: city.id, owner: p.id, specialization: o.specialization, at: { x: city.x, y: city.y } }, [...watchers, p.id]);
        break;
      }
      case 'promote': {
        const u = state.units.find(x => x.id === o.unitId)!;
        u.perks.push(o.perk);
        u.pendingPerks--;
        log.push({ t: 'perk_chosen', unitId: u.id, owner: u.owner, perk: o.perk }, [u.owner]);
        break;
      }
      case 'research':
        p.researchQueue = [...o.queue];
        break;
      case 'commander':
        applyCommanderOrder(b, state, p, o, ctx, log);
        break;
      case 'diplomacy':
        // Договоры вступают в силу в конце хода: этот ход считается по отношениям его начала.
        diplomacyOrders.push(so);
        break;
    }
  }
  for (const u of state.units) u.countersUsed = 0;

  // Видимость начала хода с учётом разведывательных импульсов.
  const vision0x = ctx.extraVision.length ? computeAllVision(b, state, ctx.extraVision) : vision0;

  // ---------- 2. Подготовка: маршруты, укрепление ----------
  log.phase = 'prepare';
  planRoutes(b, state, unitOrders, log, vision0x, ctx.forcedMarch);
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    const rallied = ctx.rally.get(u.owner)?.has(u.id) && (!o || !o.path.length) && o?.mode !== 'attack';
    if (o?.mode === 'hold' || rallied) {
      addStatus(u, 'fortified', o?.mode === 'hold' ? 'hold' : 'rally', null);
      log.push({ t: 'fortify', unitId: u.id, at: { x: u.x, y: u.y } }, visibleToUnitAt(b, state, vision0x, u, u, players));
    } else if (o && o.path.length) {
      removeStatus(u, 'fortified');
    }
  }

  // ---------- 3. Движение по шагам ----------
  log.phase = 'move';
  const moved = resolveMovement(b, state, unitOrders, seed, log, vision0x, players, ctx);
  for (const [id, m] of moved) if (m.executed > 0) ctx.acted.add(id);

  // ---------- 4. Видимость после движения ----------
  const vision1 = computeAllVision(b, state, ctx.extraVision);
  updateRoutesAfterMove(b, state, unitOrders, moved, log, vision1);

  // ---------- 5–7. Атаки по ступеням инициативы ----------
  log.phase = 'combat';
  const combatCtx: CombatContext = {
    siegeSupport: ctx.siegeSupport,
    warcry: ctx.warcry,
    seenAtStart: (attacker, targetOwner) => {
      const v = vision0x.get(targetOwner);
      const p = ctx.startPos.get(attacker.id) ?? attacker;
      return !!v && canSeeUnitAt(b, state, v, p.x, p.y);
    },
  };
  resolveCombat(b, state, unitOrders, seed, log, vision1, players, combatCtx, ctx);

  // ---------- 8. Захват объектов ----------
  log.phase = 'capture';
  resolveCapture(b, state, log, vision1, players);
  resolveStructures(b, state, log, vision1, players);
  lootRuins(b, state, log, vision1, players);

  // ---------- 9. Строительство, экономика, снабжение ----------
  log.phase = 'economy';
  for (const [id, { u, kind }] of [...builds].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const alive = state.units.find(x => x.id === id);
    if (!alive || alive.x !== u.x || alive.y !== u.y) {
      log.push({ t: 'build_failed', unitId: id, owner: u.owner, at: { x: u.x, y: u.y }, reason: alive ? 'moved' : 'destroyed' }, [u.owner]);
      continue;
    }
    const i = idx(state.map, u.x, u.y);
    const watchers = players.filter(p => vision1.get(p)!.visible[i]);
    if (kind === 'road') {
      state.map.features[i] |= Feature.Road;
      log.push({ t: 'road_built', at: { x: u.x, y: u.y }, by: u.owner }, [...watchers, u.owner]);
    } else if (kind === 'fort') {
      state.map.features[i] |= Feature.Fort;
      log.push({ t: 'fort_built', at: { x: u.x, y: u.y }, by: u.owner }, [...watchers, u.owner]);
    } else if (kind === 'forest') {
      state.map.terrain[i] = Terrain.Forest;
      log.push({ t: 'forest_planted', at: { x: u.x, y: u.y }, by: u.owner }, [...watchers, u.owner]);
    } else if (kind === 'scorch') {
      applyScorch(b, state, alive, log, watchers);
    } else if (kind === 'obelisk') {
      const sid = `s${state.world.nextStructureId++}`;
      state.world.structures.push({ id: sid, kind: 'obelisk', owner: u.owner, x: u.x, y: u.y, builtTurn: state.turn });
      log.push({ t: 'obelisk_built', at: { x: u.x, y: u.y }, by: u.owner, structureId: sid }, [...watchers, u.owner]);
    }
    ctx.acted.add(id);
    alive.xp += b.xp.perBuild;
  }
  resolveEconomy(b, state, log);
  resolveSupplyAndHealing(b, state, log, ctx);
  if (state.mode.victory === 'influence') scoreInfluence(state, log, players);

  // Выбывание
  for (const p of state.players) {
    if (p.eliminated) continue;
    const hasCity = state.cities.some(c => c.owner === p.id);
    const hasUnit = state.units.some(u => u.owner === p.id);
    if (!hasCity && !hasUnit) {
      p.eliminated = true;
      log.push({ t: 'player_eliminated', playerId: p.id }, players);
    }
  }

  // ---------- 10. Итог: дипломатия, условия победы ----------
  log.phase = 'finalize';
  resolveDiplomacy(b, state, diplomacyOrders, log, players);
  advanceWorldEvents(b, state, log, players);
  const fin = state.mode.finished ? null : checkVictory(b, state);
  if (fin) {
    state.mode.finished = { ...fin, turn: state.turn };
    log.push({ t: 'match_finished', winners: fin.winners, reason: fin.reason }, players);
  }
  const visionEnd = computeAllVision(b, state, ctx.extraVision);
  state.turn += 1;
  updateExploredAndIntel(b, state, visionEnd);
  canonicalize(state);
  return { state, events: log.events };
}

export function buildCost(b: Balance, state: GameState, owner: PlayerId, kind: BuildKind): { gold: number; wood: number } {
  if (kind === 'fort') return { gold: b.forts.goldCost, wood: b.forts.woodCost };
  if (kind === 'forest') return { gold: b.plantForest.goldCost, wood: 0 };
  if (kind === 'obelisk') return { gold: b.obelisks.goldCost, wood: 0 };
  if (kind === 'scorch') return { gold: 0, wood: 0 };
  const tr = playerOf(state, owner) ? b.factions[playerOf(state, owner)!.faction]?.traits : undefined;
  return { gold: Math.max(1, Math.round(b.roads.goldCost * (tr?.roadCostMul ?? 1) * techs(b, state, owner).roadCostMul)), wood: 0 };
}

function visibleToUnitAt(b: Balance, state: GameState, vision: Map<PlayerId, Vision>, u: { owner: PlayerId }, at: Coord, players: PlayerId[], extra: Coord[] = [], extraVision?: Map<PlayerId, Vision>): PlayerId[] {
  const out: PlayerId[] = [u.owner];
  for (const p of players) {
    if (p === u.owner) continue;
    const v = vision.get(p)!;
    if (canSeeUnitAt(b, state, v, at.x, at.y)) {
      out.push(p);
      continue;
    }
    const v2 = extraVision?.get(p);
    for (const c of extra) {
      if (canSeeUnitAt(b, state, v, c.x, c.y) || (v2 && canSeeUnitAt(b, state, v2, c.x, c.y))) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

// ======================= Дипломатия и влияние =======================

function resolveDiplomacy(b: Balance, state: GameState, orders: SubmittedOrder[], log: EventLog, players: PlayerId[]): void {
  const next = state.turn + 1;
  for (const so of orders) {
    const o = so.order;
    if (o.kind !== 'diplomacy') continue;
    const t = treatyOf(b, state, so.playerId, o.target);
    const both = [so.playerId, o.target];
    if (o.action === 'propose') {
      t.proposal = { from: so.playerId, status: o.status!, turn: state.turn };
      log.push({ t: 'diplomacy_proposed', from: so.playerId, to: o.target, status: o.status! }, both);
    } else if (o.action === 'accept' && t.proposal && t.proposal.from === o.target) {
      const previous = t.status;
      t.status = t.proposal.status;
      t.since = next;
      t.proposal = null;
      t.pending = null;
      log.push({ t: 'diplomacy_changed', a: t.a, b: t.b, status: t.status, previous }, players);
    } else if (o.action === 'decline' && t.proposal) {
      log.push({ t: 'diplomacy_declined', from: so.playerId, to: o.target, status: t.proposal.status }, both);
      t.proposal = null;
    } else if (o.action === 'break' && t.status !== 'war' && !t.pending) {
      t.pending = { status: 'war', effectiveTurn: next + b.diplomacy.breakWarningTurns, by: so.playerId };
      t.proposal = null;
      log.push({ t: 'diplomacy_break_announced', from: so.playerId, to: o.target, status: 'war', effectiveTurn: t.pending.effectiveTurn }, players);
    }
  }
  for (const t of state.diplomacy) {
    if (t.pending && t.pending.effectiveTurn <= next) {
      const previous = t.status;
      t.status = t.pending.status;
      t.since = next;
      t.pending = null;
      log.push({ t: 'diplomacy_changed', a: t.a, b: t.b, status: t.status, previous }, players);
    }
    if (t.proposal && t.proposal.turn + b.diplomacy.proposalTtl < next) t.proposal = null;
  }
  // Пары без отличий от состояния по умолчанию не храним.
  state.diplomacy = state.diplomacy.filter(t => t.status !== b.diplomacy.default || t.pending || t.proposal);
}

function scoreInfluence(state: GameState, log: EventLog, players: PlayerId[]): void {
  const gained: Record<string, number> = {};
  for (const o of state.mode.objectives) {
    const holder = objectiveHolder(state, o);
    if (holder !== o.holder) {
      log.push({ t: 'objective_held', objectiveId: o.id, holder, previous: o.holder, at: { x: o.x, y: o.y } }, players);
      o.holder = holder;
    }
    if (holder) gained[holder] = (gained[holder] ?? 0) + o.points;
  }
  for (const [p, g] of Object.entries(gained).sort()) {
    state.mode.scores[p] = (state.mode.scores[p] ?? 0) + g;
    log.push({ t: 'influence', playerId: p, gained: g, total: state.mode.scores[p] }, [p]);
  }
}

// ======================= Командир =======================

function applyCommanderOrder(b: Balance, state: GameState, p: PlayerState, o: Extract<SubmittedOrder['order'], { kind: 'commander' }>, ctx: TurnCtx, log: EventLog): void {
  const cs = p.commander;
  if (o.action === 'direction') {
    const d = o.direction!;
    cs.directions[d] = (cs.directions[d] ?? 0) + 1;
    cs.pendingChoices--;
    log.push({ t: 'commander_direction', playerId: p.id, direction: d, level: cs.directions[d] }, [p.id]);
    return;
  }
  const id = o.ability!;
  const ab = b.commander.abilities[id];
  const cmd = commanderUnit(state, p.id)!;
  cs.points -= ab.cost;
  cs.cooldowns[id] = state.turn + ab.cooldown;
  const near = sortById(state.units.filter(u => u.owner === p.id && dist(u, cmd) <= b.commander.auraRadius));
  let affected: string[] = [];
  if (id === 'rally') {
    ctx.rally.set(p.id, new Set(near.map(u => u.id)));
    affected = near.map(u => u.id);
  } else if (id === 'siege_support') {
    for (const u of near) ctx.siegeSupport.add(u.id);
    affected = near.map(u => u.id);
  } else if (id === 'forced_march') {
    for (const u of near) ctx.forcedMarch.add(u.id);
    affected = near.map(u => u.id);
  } else if (id === 'warcry') {
    for (const u of near) ctx.warcry.add(u.id);
    affected = near.map(u => u.id);
  } else if (id === 'resonance_surge') {
    ctx.surge.add(p.id);
    affected = sortById(state.units.filter(u => u.owner === p.id && inResonance(b, state, u))).map(u => u.id);
  } else if (id === 'scout_pulse' && o.target) {
    ctx.extraVision.push({ owner: p.id, x: o.target.x, y: o.target.y, r: ab.radius ?? 3 });
  }
  log.push({ t: 'commander_ability', playerId: p.id, ability: id, at: { x: cmd.x, y: cmd.y }, target: o.target, affected }, [p.id]);
}

// ======================= Движение =======================

function resolveMovement(
  b: Balance,
  state: GameState,
  unitOrders: Map<string, UnitOrder>,
  seed: string,
  log: EventLog,
  vision0: Map<PlayerId, Vision>,
  players: PlayerId[],
  ctx: TurnCtx,
): Map<string, { executed: number; blocked: string | null }> {
  const map = state.map;
  const occupant = new Map<number, UnitState>();
  for (const u of state.units) if (onMap(u)) occupant.set(idx(map, u.x, u.y), u);
  const byId = new Map(state.units.map(u => [u.id, u]));

  interface Mover { u: UnitState; path: Coord[]; step: number; spent: number; budget: number; stopped: boolean; blockedReason?: string; profile: ReturnType<typeof moveProfile>; disembark: boolean }
  const movers: Mover[] = [];
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    if (!o || o.mode === 'hold' || o.mode === 'build' || !o.path.length) continue;
    // Высадка: один шаг с борта на сушу в первом такте, расходует весь ход.
    const disembark = !!u.carriedBy;
    movers.push({ u, path: disembark ? o.path.slice(0, 1) : o.path, step: 0, spent: 0, budget: disembark ? Infinity : moveOf(b, state, u, ctx.forcedMarch), stopped: false, profile: moveProfile(b, state, u), disembark });
  }
  movers.sort((a, c) => (a.u.id < c.u.id ? -1 : 1));
  const maxTicks = movers.reduce((m, x) => Math.max(m, x.path.length), 0);
  const zocUnits = state.units.filter(u => hasAbility(b, u.type, 'zoc') && onMap(u));

  for (let tick = 0; tick < maxTicks; tick++) {
    const active = movers.filter(m => !m.stopped && m.step < m.path.length);
    if (!active.length) break;
    const want = new Map<Mover, Coord>();
    const embarkWant = new Map<UnitState, Mover[]>(); // транспорт → желающие погрузиться
    for (const m of active) {
      const next = m.path[m.step];
      if (m.disembark && tick > 0) {
        m.stopped = true;
        continue;
      }
      const ship = !m.disembark && m.step === m.path.length - 1 && dist(m.u, next) === 1 ? embarkTarget(b, state, m.u, next) : null;
      if (ship) {
        if (m.spent + b.naval.embarkCost > m.budget + 1e-9) {
          m.stopped = true;
          continue;
        }
        (embarkWant.get(ship) ?? embarkWant.set(ship, []).get(ship)!).push(m);
        continue;
      }
      const c = landMoveCost(b, map, m.u, next, m.profile);
      if (c === null || m.spent + c > m.budget + 1e-9 || dist(m.u, next) !== 1) {
        m.stopped = true;
        continue;
      }
      if (!mayEnter(b, state, m.u.owner, m.u, next)) {
        m.stopped = true;
        m.blockedReason = 'territory_closed';
        log.push({ t: 'move_blocked', unitId: m.u.id, owner: m.u.owner, at: { x: m.u.x, y: m.u.y }, wanted: next, tick, reason: 'territory_closed' }, [m.u.owner]);
        continue;
      }
      want.set(m, next);
    }
    const blocked = new Map<Mover, string>();

    // а) несколько претендентов на одну клетку — по инициативе, ничья — по seed хода
    const byTarget = new Map<number, Mover[]>();
    for (const [m, t] of want) {
      const i = idx(map, t.x, t.y);
      (byTarget.get(i) ?? byTarget.set(i, []).get(i)!).push(m);
    }
    for (const list of byTarget.values()) {
      if (list.length < 2) continue;
      list.sort((a, c) => {
        const ia = b.units[a.u.type].initiative;
        const ic = b.units[c.u.type].initiative;
        if (ia !== ic) return ic - ia;
        return hashParts(seed, tick, a.u.id) - hashParts(seed, tick, c.u.id) || (a.u.id < c.u.id ? -1 : 1);
      });
      for (const loser of list.slice(1)) blocked.set(loser, 'contested_tile');
    }

    // б) встречное движение вражеских отрядов — оба блокируются
    for (const [m, t] of want) {
      if (blocked.has(m)) continue;
      const other = occupant.get(idx(map, t.x, t.y));
      if (!other || other.owner === m.u.owner) continue;
      const om = movers.find(x => x.u === other);
      const ot = om ? want.get(om) : undefined;
      if (om && ot && ot.x === m.u.x && ot.y === m.u.y) {
        blocked.set(m, 'head_on');
        blocked.set(om, 'head_on');
      }
    }

    // Погрузка: транспорт должен стоять на месте в этом такте; места — по инициативе, ничья — по seed хода.
    const embarks: { m: Mover; ship: UnitState }[] = [];
    for (const [ship, list] of embarkWant) {
      const sm = movers.find(x => x.u === ship);
      const shipLeaves = !!sm && want.has(sm) && !blocked.has(sm);
      list.sort((a, c) => b.units[c.u.type].initiative - b.units[a.u.type].initiative || hashParts(seed, tick, a.u.id) - hashParts(seed, tick, c.u.id) || (a.u.id < c.u.id ? -1 : 1));
      const seats = freeSeats(b, state, ship) ?? 0;
      list.forEach((m, k) => {
        if (shipLeaves) blocked.set(m, 'transport_left');
        else if (k >= seats) blocked.set(m, 'transport_full');
        else embarks.push({ m, ship });
      });
      for (const m of list) if (blocked.has(m)) want.set(m, { x: ship.x, y: ship.y });
    }
    const embarking = new Set(embarks.map(e => e.m.u));

    // в) занятые клетки: блок, пока занимающий не уходит успешно (фиксированная точка)
    const leaving = (u: UnitState): boolean => {
      if (embarking.has(u)) return true;
      const m = movers.find(x => x.u === u);
      return !!m && want.has(m) && !blocked.has(m);
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const [m, t] of want) {
        if (blocked.has(m)) continue;
        const occ = occupant.get(idx(map, t.x, t.y));
        if (occ && occ !== m.u && !leaving(occ)) {
          blocked.set(m, occ.owner === m.u.owner ? 'occupied_friendly' : 'unexpected_obstacle');
          changed = true;
        }
      }
    }

    // Применяем: сначала освобождаем клетки, потом занимаем.
    const moves: { m: Mover; from: Coord; to: Coord }[] = [];
    for (const [m, t] of want) {
      if (blocked.has(m)) continue;
      moves.push({ m, from: { x: m.u.x, y: m.u.y }, to: t });
    }
    for (const mv of moves) {
      const fi = idx(map, mv.from.x, mv.from.y);
      if (occupant.get(fi) === mv.m.u) occupant.delete(fi);
    }
    for (const e of embarks) {
      const fi = idx(map, e.m.u.x, e.m.u.y);
      if (occupant.get(fi) === e.m.u) occupant.delete(fi);
    }
    const disembarked: { m: Mover; from: Coord; to: Coord; ship: string }[] = [];
    for (const mv of moves) {
      mv.m.spent += mv.m.disembark ? 0 : landMoveCost(b, map, mv.from, mv.to, mv.m.profile)!;
      mv.m.u.x = mv.to.x;
      mv.m.u.y = mv.to.y;
      mv.m.step++;
      if (mv.m.disembark) {
        disembarked.push({ m: mv.m, from: mv.from, to: mv.to, ship: mv.m.u.carriedBy! });
        delete mv.m.u.carriedBy;
        mv.m.u.route = null;
        mv.m.stopped = true;
      }
      occupant.set(idx(map, mv.to.x, mv.to.y), mv.m.u);
    }
    const embarkedNow: { m: Mover; from: Coord; ship: UnitState }[] = [];
    for (const e of embarks) {
      const from = { x: e.m.u.x, y: e.m.u.y };
      e.m.u.carriedBy = e.ship.id;
      e.m.u.route = null;
      e.m.spent += b.naval.embarkCost;
      e.m.step++;
      e.m.stopped = true;
      removeStatus(e.m.u, 'fortified');
      embarkedNow.push({ m: e.m, from, ship: e.ship });
    }
    // Груз движется вместе с транспортом.
    for (const u of state.units) {
      if (!u.carriedBy) continue;
      const t = byId.get(u.carriedBy);
      if (t) {
        u.x = t.x;
        u.y = t.y;
      }
    }
    // События движения: видны тем, кто видел отряд в начале или видит его клетку после шага.
    const visionNow = computeAllVision(b, state, ctx.extraVision);
    for (const mv of moves) {
      if (mv.m.disembark) continue;
      log.push(
        { t: 'move', unitId: mv.m.u.id, owner: mv.m.u.owner, from: mv.from, to: mv.to, tick },
        visibleToUnitAt(b, state, vision0, mv.m.u, mv.from, players, [mv.to], visionNow),
      );
    }
    for (const d of disembarked) {
      log.push(
        { t: 'disembarked', unitId: d.m.u.id, owner: d.m.u.owner, transportId: d.ship, from: d.from, to: d.to, tick },
        visibleToUnitAt(b, state, visionNow, d.m.u, d.to, players),
      );
    }
    for (const e of embarkedNow) {
      log.push(
        { t: 'embarked', unitId: e.m.u.id, owner: e.m.u.owner, transportId: e.ship.id, from: e.from, to: { x: e.ship.x, y: e.ship.y }, tick },
        visibleToUnitAt(b, state, vision0, e.m.u, e.from, players),
      );
    }
    // Зона контроля: вошедший на клетку рядом с противником, держащим ЗК, останавливается.
    for (const mv of moves) {
      if (hasAbility(b, mv.m.u.type, 'ignore_zoc') || mv.m.step >= mv.m.path.length) continue;
      const holder = zocUnits.find(z => z.hp > 0 && z.owner !== mv.m.u.owner && dist(z, mv.m.u) === 1 && exertsZocOn(b, state, z.owner, mv.m.u.owner));
      if (holder) {
        mv.m.stopped = true;
        mv.m.blockedReason = 'zoc';
        log.push({ t: 'zoc_stop', unitId: mv.m.u.id, owner: mv.m.u.owner, at: { x: mv.m.u.x, y: mv.m.u.y }, tick }, [mv.m.u.owner]);
      }
    }
    for (const [m, reason] of blocked) {
      m.stopped = true;
      m.blockedReason = reason;
      const wanted = want.get(m)!;
      // Причину «скрытое препятствие» видит только владелец; положение блокирующего не раскрывается.
      log.push({ t: 'move_blocked', unitId: m.u.id, owner: m.u.owner, at: { x: m.u.x, y: m.u.y }, wanted, tick, reason }, [m.u.owner]);
    }
  }
  return new Map(movers.map(m => [m.u.id, { executed: m.step, blocked: m.blockedReason ?? null }]));
}

// ======================= Бой =======================

interface Attack {
  attacker: UnitState;
  target: UnitState;
  order: UnitOrder;
}

function resolveCombat(
  b: Balance,
  state: GameState,
  unitOrders: Map<string, UnitOrder>,
  seed: string,
  log: EventLog,
  vision1: Map<PlayerId, Vision>,
  players: PlayerId[],
  combatCtx: CombatContext,
  ctx: TurnCtx,
): void {
  const byId = new Map(state.units.map(u => [u.id, u]));
  const attacks: Attack[] = [];
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    if (o?.mode !== 'attack' || !o.targetUnitId) continue;
    const t = byId.get(o.targetUnitId);
    if (!t) continue;
    attacks.push({ attacker: u, target: t, order: o });
  }
  const tiers = [...new Set(attacks.map(a => b.units[a.attacker.type].initiative))].sort((a, c) => c - a);
  const xpGain = new Map<string, number>();
  const addXp = (u: UnitState, n: number) => xpGain.set(u.id, (xpGain.get(u.id) ?? 0) + n);

  for (const tier of tiers) {
    const inTier = attacks
      .filter(a => b.units[a.attacker.type].initiative === tier)
      .sort((a, c) => hashParts(seed, 'atk', a.attacker.id) - hashParts(seed, 'atk', c.attacker.id) || (a.attacker.id < c.attacker.id ? -1 : 1));
    const hp0 = new Map(state.units.map(u => [u.id, u.hp]));
    const dmg = new Map<string, number>();
    const valid: { a: Attack; damage: number; counter: number; counterPossible: boolean; exchange: boolean }[] = [];

    for (const a of inTier) {
      if ((hp0.get(a.attacker.id) ?? 0) <= 0) continue; // погиб до своей ступени — не атакует
      const fail = (reason: string) => log.push({ t: 'attack_failed', attackerId: a.attacker.id, owner: a.attacker.owner, reason, at: { x: a.attacker.x, y: a.attacker.y } }, [a.attacker.owner]);
      if ((hp0.get(a.target.id) ?? 0) <= 0) {
        fail('target_destroyed');
        continue;
      }
      if (a.attacker.carriedBy) {
        fail('attacker_embarked');
        continue;
      }
      if (a.target.carriedBy) {
        fail('target_embarked');
        continue;
      }
      // Цель ушла из зоны — автоматического преследования нет.
      if (dist(a.attacker, a.target) > rangeOf(b, state, a.attacker)) {
        fail('target_out_of_range');
        continue;
      }
      if (!canSeeUnitAt(b, state, vision1.get(a.attacker.owner)!, a.target.x, a.target.y)) {
        fail('target_not_visible');
        continue;
      }
      const r = computeDamage(b, state, a.attacker, a.target, hp0.get(a.attacker.id)!, hp0.get(a.target.id)!, combatCtx);
      const exchange = inTier.some(o => o.attacker === a.target && o.target === a.attacker);
      valid.push({ a, damage: r.damage, counter: r.counter, counterPossible: r.counterPossible, exchange });
      ctx.acted.add(a.attacker.id);
    }
    // Основные удары ступени применяются вместе.
    for (const v of valid) {
      dmg.set(v.a.target.id, (dmg.get(v.a.target.id) ?? 0) + v.damage);
      log.push(
        { t: 'attack', attackerId: v.a.attacker.id, targetId: v.a.target.id, from: { x: v.a.attacker.x, y: v.a.attacker.y }, to: { x: v.a.target.x, y: v.a.target.y }, damage: v.damage, tier, kind: v.exchange ? 'exchange' : 'primary', attackerType: v.a.attacker.type, targetType: v.a.target.type },
        visibleToUnitAt(b, state, vision1, v.a.attacker, v.a.attacker, players, [v.a.target]).concat(v.a.target.owner),
      );
      addXp(v.a.attacker, b.xp.perCombat);
      addXp(v.a.target, b.xp.perCombat);
    }
    for (const [id, d] of dmg) byId.get(id)!.hp -= d;
    // Контратаки: цель выжила, достаёт атакующего, лимит не исчерпан, не было обмена ударами.
    const counterDmg = new Map<string, number>();
    for (const v of valid) {
      const t = v.a.target;
      if (v.exchange || t.hp <= 0 || !v.counterPossible) continue;
      if (t.countersUsed >= b.combat.maxCountersPerTurn) continue;
      t.countersUsed++;
      counterDmg.set(v.a.attacker.id, (counterDmg.get(v.a.attacker.id) ?? 0) + v.counter);
      log.push(
        { t: 'attack', attackerId: t.id, targetId: v.a.attacker.id, from: { x: t.x, y: t.y }, to: { x: v.a.attacker.x, y: v.a.attacker.y }, damage: v.counter, tier, kind: 'counter', attackerType: t.type, targetType: v.a.attacker.type },
        visibleToUnitAt(b, state, vision1, t, t, players, [v.a.attacker]).concat(v.a.attacker.owner),
      );
    }
    for (const [id, d] of counterDmg) byId.get(id)!.hp -= d;
    // Подавление и отталкивание — для выживших целей.
    for (const v of valid) {
      const t = v.a.target;
      if (t.hp <= 0 || t.owner === v.a.attacker.owner) continue;
      if (hasAbility(b, v.a.attacker.type, 'suppress') && !t.perks?.includes('suppress_resist') && !t.statuses.some(s => s.id === 'suppressed')) {
        addStatus(t, 'suppressed', v.a.attacker.id, state.turn + 1);
        log.push({ t: 'suppressed', unitId: t.id, owner: t.owner, at: { x: t.x, y: t.y } }, visibleToUnitAt(b, state, vision1, t, t, players).concat(v.a.attacker.owner));
      }
      if (v.a.order.ability === 'knockback' && v.a.attacker.hp > 0 && !hasAbility(b, t.type, 'heavy')) {
        const dx = Math.sign(t.x - v.a.attacker.x), dy = Math.sign(t.y - v.a.attacker.y);
        const to = { x: t.x + dx, y: t.y + dy };
        const free = inBounds(state.map, to.x, to.y) && isLandPassable(b, state.map, to.x, to.y, moveProfile(b, state, t)) && !state.units.some(u => u.hp > 0 && u.x === to.x && u.y === to.y);
        if (free) {
          const from = { x: t.x, y: t.y };
          t.x = to.x;
          t.y = to.y;
          removeStatus(t, 'fortified');
          log.push({ t: 'knockback', unitId: t.id, owner: t.owner, from, to }, visibleToUnitAt(b, state, vision1, t, from, players, [to]).concat(v.a.attacker.owner));
        }
      }
    }
    // Груз гибнет вместе с транспортом.
    for (const u of state.units) if (u.carriedBy && u.hp > 0 && (byId.get(u.carriedBy)?.hp ?? 0) <= 0) u.hp = 0;
    // Потери ступени.
    for (const u of sortById(state.units)) {
      if (u.hp > 0) continue;
      log.push({ t: 'unit_destroyed', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, unitType: u.type }, visibleToUnitAt(b, state, vision1, u, u, players));
      // Опыт за уничтожение — тем, кто нанёс урон в этой ступени.
      for (const v of valid) {
        if (v.a.target !== u || v.a.attacker.hp <= 0) continue;
        addXp(v.a.attacker, b.units[v.a.attacker.type].xpOnKill);
        if (u.owner !== NEUTRAL) grantMomentum(b, state, v.a.attacker, log);
      }
      if (u.type === 'commander') {
        const p = playerOf(state, u.owner);
        if (p && p.commander.unitId === u.id) {
          p.commander.unitId = null;
          p.commander.respawnTurn = state.turn + b.commander.respawnTurns;
          log.push({ t: 'commander_fallen', playerId: p.id, at: { x: u.x, y: u.y }, respawnTurn: p.commander.respawnTurn }, visibleToUnitAt(b, state, vision1, u, u, players));
        }
      }
    }
    state.units = state.units.filter(u => u.hp > 0);
  }
  // Атака снимает укрепление.
  for (const a of attacks) removeStatus(a.attacker, 'fortified');
  applyXp(b, state, xpGain, log);
}

/** Начислить опыт; при повышении ранга растёт здоровье и появляется выбор улучшения (у командира — направления). */
function grantXp(b: Balance, state: GameState, u: UnitState, amount: number, log: EventLog): boolean {
  const before = u.rank;
  u.xp += Math.round(amount * techs(b, state, u.owner).xpMul);
  u.rank = rankForXp(b, u.xp);
  const gained = u.rank - before;
  if (gained <= 0) return false;
  const newMax = baseMaxHp(b, state, u.owner, u.type, u.rank);
  u.hp += newMax - u.maxHp;
  u.maxHp = newMax;
  if (u.type === 'commander') {
    const p = playerOf(state, u.owner);
    if (p) p.commander.pendingChoices += gained;
  } else {
    u.pendingPerks += gained;
  }
  log.push({ t: 'promotion_available', unitId: u.id, owner: u.owner }, [u.owner]);
  return true;
}

function applyXp(b: Balance, state: GameState, gain: Map<string, number>, log: EventLog): void {
  for (const [id, amount] of [...gain].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
    const u = state.units.find(x => x.id === id);
    if (!u || u.owner === NEUTRAL) continue;
    const rankUp = grantXp(b, state, u, amount, log);
    log.push({ t: 'xp', unitId: u.id, amount, rankUp }, [u.owner]);
  }
}

// ======================= Захват =======================

function resolveCapture(b: Balance, state: GameState, log: EventLog, vision: Map<PlayerId, Vision>, players: PlayerId[]): void {
  for (const city of sortById(state.cities)) {
    const occ = state.units.find(u => u.x === city.x && u.y === city.y && onMap(u) && !isNaval(b, u.type));
    const watchers = players.filter(p => vision.get(p)!.visible[idx(state.map, city.x, city.y)]);
    const ownerList = city.owner && city.owner !== NEUTRAL ? [city.owner] : [];
    if (occ && occ.owner !== NEUTRAL && occ.owner !== city.owner && isHostile(b, state, occ.owner, city.owner)) {
      const holding = city.contestedBy === occ.owner && city.contestedSinceTurn !== null && city.contestedSinceTurn <= state.turn - b.capture.holdTurns;
      if (holding) {
        const from = city.owner;
        city.owner = occ.owner;
        city.contestedBy = null;
        city.contestedSinceTurn = null;
        city.queue = [];
        city.productionStock = 0;
        log.push({ t: 'city_captured', cityId: city.id, from, to: occ.owner, at: { x: city.x, y: city.y } }, [...watchers, ...ownerList, occ.owner]);
        grantXp(b, state, occ, b.xp.perCapture, log);
        if (from && from !== NEUTRAL) grantMomentum(b, state, occ, log);
        const plunder = traitsOf(b, state, occ.owner).plunderGold;
        const p = playerOf(state, occ.owner);
        if (plunder && p) {
          const gold = (plunder + techs(b, state, occ.owner).plunderBonus) * Math.max(1, city.level);
          p.gold += gold;
          log.push({ t: 'plunder', playerId: p.id, cityId: city.id, gold }, [p.id]);
        }
      } else if (city.contestedBy !== occ.owner) {
        city.contestedBy = occ.owner;
        city.contestedSinceTurn = state.turn;
        log.push({ t: 'city_contested', cityId: city.id, by: occ.owner, owner: city.owner, at: { x: city.x, y: city.y } }, [...watchers, ...ownerList, occ.owner]);
      }
    } else if (city.contestedBy) {
      city.contestedBy = null;
      city.contestedSinceTurn = null;
      log.push({ t: 'city_contest_cleared', cityId: city.id, at: { x: city.x, y: city.y } }, [...watchers, ...ownerList]);
    }
  }
}

// ======================= Экономика =======================

export interface CityIncome {
  gold: number;
  production: number;
  knowledge: number;
  food: number;
  wood: number;
  iron: number;
  crystal: number;
}

export interface IncomeBreakdown {
  gold: number;
  upkeep: number;
  knowledge: number;
  production: Record<string, number>;
  materials: { wood: number; iron: number; crystal: number };
  cities: Record<string, CityIncome>;
}

export function cityIncome(b: Balance, state: GameState, c: CityState): CityIncome {
  const zero = { gold: 0, production: 0, knowledge: 0, food: 0, wood: 0, iron: 0, crystal: 0 };
  if (!c.owner || c.owner === NEUTRAL) return zero;
  const mul = c.contestedBy ? b.cities.occupiedIncomeMultiplier : 1;
  if (mul === 0) return zero;
  const tc = techs(b, state, c.owner);
  const spec = c.specialization ? b.specializations[c.specialization]?.effects ?? {} : {};
  const coastal = waterDistance(state.map)[idx(state.map, c.x, c.y)] <= 1;
  const gold = ((b.cities.goldPerLevel[c.level] ?? 0) + (c.isCapital ? b.cities.capitalBonusGold : 0) + cityBuildingEffect(b, c, 'gold') + tc.goldPerCity + (coastal ? tc.coastalGold : 0) + worldEffect(b, state, 'gold')) * (spec.goldMul ?? 1);
  const production = ((b.cities.productionPerLevel[c.level] ?? 0) + cityBuildingEffect(b, c, 'production')) * (spec.productionMul ?? 1);
  const knowledge = ((b.cities.knowledgePerLevel[c.level] ?? 0) + cityBuildingEffect(b, c, 'knowledge')) * (spec.knowledgeMul ?? 1);
  const food = b.cities.baseFood + cityBuildingEffect(b, c, 'food') + tc.foodPerCity + worldEffect(b, state, 'food');
  // Материалы с месторождений вокруг города.
  let woodTiles = 0, ironTiles = 0, crystalTiles = 0;
  const r = b.cities.materialRadius;
  for (let y = c.y - r; y <= c.y + r; y++) for (let x = c.x - r; x <= c.x + r; x++) {
    if (!inBounds(state.map, x, y)) continue;
    const f = state.map.features[idx(state.map, x, y)];
    if (f & Feature.ResourceWood) woodTiles++;
    if (f & Feature.ResourceIron) ironTiles++;
    if (f & Feature.ResourceCrystal) crystalTiles++;
  }
  const wood = Math.min(woodTiles, 1) + cityBuildingEffect(b, c, 'woodPerTile') * woodTiles;
  const iron = Math.min(ironTiles, 1) + cityBuildingEffect(b, c, 'ironPerTile') * ironTiles + cityBuildingEffect(b, c, 'iron');
  const crystal = cityBuildingEffect(b, c, 'crystalPerTile') * crystalTiles;
  return {
    gold: Math.floor(gold * mul), production: Math.floor(production * mul), knowledge: Math.floor(knowledge * mul),
    food: Math.floor(food * mul), wood: Math.floor(wood * mul), iron: Math.floor(iron * mul), crystal: Math.floor(crystal * mul),
  };
}

export function incomeFor(b: Balance, state: GameState, playerId: PlayerId): IncomeBreakdown {
  let gold = 0, knowledge = 0, relief = 0;
  const production: Record<string, number> = {};
  const materials = { wood: 0, iron: 0, crystal: 0 };
  const cities: Record<string, CityIncome> = {};
  for (const c of state.cities) {
    if (c.owner !== playerId) continue;
    const ci = cityIncome(b, state, c);
    cities[c.id] = ci;
    gold += ci.gold;
    knowledge += ci.knowledge;
    production[c.id] = ci.production;
    materials.wood += ci.wood;
    materials.iron += ci.iron;
    materials.crystal += ci.crystal;
    if (!c.contestedBy && c.specialization) relief += b.specializations[c.specialization]?.effects.upkeepRelief ?? 0;
  }
  // Обелиски на руинах — источники знаний.
  const tc = techs(b, state, playerId);
  for (const o of linkedObelisks(b, state, playerId)) {
    if (state.map.features[idx(state.map, o.x, o.y)] & Feature.Ruins) knowledge += b.obelisks.ruinsKnowledge + tc.ruinsKnowledge;
  }
  let upkeep = 0;
  for (const u of state.units) if (u.owner === playerId) upkeep += b.units[u.type].upkeep;
  // Пепельные орды: каждый город сверх предела удержания стоит золота.
  const tr = traitsOf(b, state, playerId);
  if (tr.frontLimit !== undefined && tr.frontPenaltyGold) {
    const owned = state.cities.filter(c => c.owner === playerId).length;
    upkeep += Math.max(0, owned - tr.frontLimit - tc.frontLimitBonus) * tr.frontPenaltyGold;
  }
  return { gold, upkeep: Math.max(0, upkeep - relief), knowledge, production, materials, cities };
}

function resolveEconomy(b: Balance, state: GameState, log: EventLog): void {
  for (const p of state.players) {
    if (p.eliminated) continue;
    const inc = incomeFor(b, state, p.id);
    p.gold += inc.gold - inc.upkeep;
    p.materials.wood += inc.materials.wood;
    p.materials.iron += inc.materials.iron;
    p.materials.crystal += inc.materials.crystal;
    const deficit = p.gold < 0;
    log.push({ t: 'income', playerId: p.id, gold: inc.gold, upkeep: inc.upkeep, knowledge: inc.knowledge, deficit }, [p.id]);
    if (inc.materials.wood || inc.materials.iron || inc.materials.crystal) log.push({ t: 'materials', playerId: p.id, ...inc.materials }, [p.id]);

    // Исследования: общий пул прогресса, смена очереди не дублирует прогресс.
    p.researchProgress += inc.knowledge;
    while (p.researchQueue.length) {
      const tech = p.researchQueue[0];
      const rule = b.techs[tech];
      const blockedByExclusion = (rule?.excludes ?? []).some(x => p.researched.includes(x));
      if (!rule || p.researched.includes(tech) || blockedByExclusion || (rule.faction && rule.faction !== p.faction) || !rule.requires.every(r => p.researched.includes(r))) {
        p.researchQueue.shift();
        continue;
      }
      if (p.researchProgress < rule.cost) break;
      p.researchProgress -= rule.cost;
      p.researched.push(tech);
      p.researchQueue.shift();
      log.push({ t: 'research_completed', playerId: p.id, techId: tech }, [p.id]);
    }

    for (const c of sortById(state.cities.filter(c => c.owner === p.id))) {
      const ci = inc.cities[c.id];
      // Рост города за счёт еды.
      if (!c.contestedBy && c.level < b.cities.maxLevel) {
        c.food += ci.food;
        const need = b.cities.growthThresholds[c.level + 1] ?? Infinity;
        if (c.food >= need) {
          c.food -= need;
          c.level++;
          log.push({ t: 'city_grew', cityId: c.id, owner: p.id, level: c.level, at: { x: c.x, y: c.y } }, [p.id]);
        }
      }
      // Производство.
      const head = c.queue[0];
      if (!head) continue;
      head.progress += ci.production + (head.kind === 'unit' ? cityBuildingEffect(b, c, 'unitProduction') : 0);
      if (head.kind === 'building') {
        if (head.progress < b.buildings[head.unitType].cost.production) continue;
        c.queue.shift();
        c.buildings.push(head.unitType);
        log.push({ t: 'building_completed', cityId: c.id, owner: p.id, building: head.unitType, at: { x: c.x, y: c.y } }, [p.id]);
        continue;
      }
      if (head.progress < b.units[head.unitType].cost.production) continue;
      const spot = spawnSpot(b, state, c, isNaval(b, head.unitType));
      if (!spot) {
        log.push({ t: 'production_blocked', cityId: c.id, owner: p.id, reason: 'no_space' }, [p.id]);
        continue;
      }
      c.queue.shift();
      const u = newUnit(b, state, { id: `u${state.nextIds.unit++}`, owner: p.id, type: head.unitType, x: spot.x, y: spot.y, xp: cityBuildingEffect(b, c, 'recruitXp') });
      state.units.push(u);
      log.push({ t: 'unit_recruited', unitId: u.id, owner: p.id, cityId: c.id, at: spot, unitType: head.unitType }, [p.id]);
    }

    // Командир: очки командования и восстановление после гибели.
    const cs = p.commander;
    cs.points = Math.min(b.commander.maxPoints, cs.points + b.commander.pointsPerTurn);
    if (!cs.unitId && cs.respawnTurn !== null && state.turn >= cs.respawnTurn && p.gold >= b.commander.respawnGold) {
      const home = state.cities.find(c => c.owner === p.id && c.isCapital && !c.contestedBy) ?? sortById(state.cities).find(c => c.owner === p.id && !c.contestedBy);
      const spot = home && spawnSpot(b, state, home);
      if (home && spot) {
        p.gold -= b.commander.respawnGold;
        const u = newUnit(b, state, { id: `u${state.nextIds.unit++}`, owner: p.id, type: 'commander', x: spot.x, y: spot.y });
        state.units.push(u);
        cs.unitId = u.id;
        cs.respawnTurn = null;
        log.push({ t: 'commander_respawned', playerId: p.id, unitId: u.id, at: spot }, [p.id]);
      }
    }
  }
}

// ======================= Снабжение и лечение =======================

function resolveSupplyAndHealing(b: Balance, state: GameState, log: EventLog, ctx: TurnCtx): void {
  const grids = new Map<PlayerId, Uint8Array>();
  for (const p of state.players) if (!p.eliminated) grids.set(p.id, computeSupply(b, state, p.id));
  const fieldHealing = worldHas(b, state, 'fieldHealing') ? worldEffect(b, state, 'fieldHealing') : 1;
  for (const u of sortById(state.units)) {
    if (u.owner === NEUTRAL || u.carriedBy) continue;
    const grid = grids.get(u.owner);
    if (!grid) continue;
    const inSupply = grid[idx(state.map, u.x, u.y)] === 1;
    const at = { x: u.x, y: u.y };
    // Всплеск резонанса: лечит отряды в поле обелисков даже после боя.
    if (ctx.surge.has(u.owner) && u.hp < u.maxHp && inResonance(b, state, u)) {
      const amount = Math.min(3, u.maxHp - u.hp);
      u.hp += amount;
      log.push({ t: 'healed', unitId: u.id, owner: u.owner, amount }, [u.owner]);
    }
    // Корабли несут припасы с собой: штрафов снабжения нет, лечатся только в зоне.
    if (isNaval(b, u.type) && !inSupply) continue;
    if (inSupply) {
      if (u.supplyOut > 0) {
        u.supplyOut = 0;
        removeStatus(u, 'low_supply');
        removeStatus(u, 'unsupplied');
        log.push({ t: 'supply_restored', unitId: u.id, owner: u.owner, at }, [u.owner]);
      }
    } else {
      u.supplyOut++;
      if (u.supplyOut === b.supply.unsuppliedAfter) {
        removeStatus(u, 'low_supply');
        addStatus(u, 'unsupplied', 'supply', null);
        log.push({ t: 'supply_warning', unitId: u.id, owner: u.owner, at, level: 'none' }, [u.owner]);
      } else if (u.supplyOut === b.supply.lowSupplyAfter) {
        addStatus(u, 'low_supply', 'supply', null);
        log.push({ t: 'supply_warning', unitId: u.id, owner: u.owner, at, level: 'low' }, [u.owner]);
      }
    }
    // Лечение: только не действовавшие отряды в зоне снабжения.
    if (!inSupply || ctx.acted.has(u.id) || u.hp >= u.maxHp) continue;
    let heal = b.healing.inSupply + techs(b, state, u.owner).healBonus + (traitsOf(b, state, u.owner).healBonus ?? 0) + commanderAura(b, state, u.owner, u, 'logistics');
    const city = state.cities.find(c => c.x === u.x && c.y === u.y && c.owner === u.owner);
    if (!city) heal = Math.floor(heal * fieldHealing);
    if (city) {
      heal += b.healing.inOwnCity;
      if (city.specialization) heal += b.specializations[city.specialization]?.effects.garrisonHeal ?? 0;
    }
    const amount = Math.min(heal, u.maxHp - u.hp);
    if (amount > 0) {
      u.hp += amount;
      log.push({ t: 'healed', unitId: u.id, owner: u.owner, amount }, [u.owner]);
    }
  }
}

function spawnSpot(b: Balance, state: GameState, c: { x: number; y: number }, naval = false): Coord | null {
  const free = (x: number, y: number) => isLandPassable(b, state.map, x, y, naval ? { naval: true } : undefined) && !state.units.some(u => onMap(u) && u.x === x && u.y === y);
  if (!naval && free(c.x, c.y)) return { x: c.x, y: c.y };
  for (const [dx, dy] of DIRS8) if (free(c.x + dx, c.y + dy)) return { x: c.x + dx, y: c.y + dy };
  return null;
}

// ======================= Этап 5: натиск, выжженная земля, обелиски, руины, события =======================

/** Пепельные орды: уничтожение врага или захват города даёт +1 к движению на следующий ход. */
function grantMomentum(b: Balance, state: GameState, u: UnitState, log: EventLog): void {
  if (!traitsOf(b, state, u.owner).momentumMove || u.hp <= 0) return;
  // Натиск не продлевается цепочкой: отряд, уже действующий с натиском в этот ход, новый не получает.
  if (u.statuses.some(s => s.id === 'momentum' && s.expiresTurn === state.turn)) return;
  const had = u.statuses.some(s => s.id === 'momentum' && s.expiresTurn === state.turn + 1);
  addStatus(u, 'momentum', 'momentum', state.turn + 1);
  if (!had) log.push({ t: 'momentum', unitId: u.id, owner: u.owner }, [u.owner]);
}

function applyScorch(b: Balance, state: GameState, u: UnitState, log: EventLog, watchers: PlayerId[]): void {
  const i = idx(state.map, u.x, u.y);
  state.map.features[i] &= ~(Feature.Road | Feature.Fort | Feature.ResourceWood);
  if (state.map.terrain[i] === Terrain.Forest) state.map.terrain[i] = Terrain.Plains;
  const city = nearestForeignCity(state, u.owner, u, b.scorch.radius);
  let foodLost = 0;
  if (city && isHostile(b, state, u.owner, city.owner)) {
    foodLost = Math.min(city.food, b.scorch.foodLoss);
    city.food -= foodLost;
  }
  const gold = b.scorch.gold + techs(b, state, u.owner).scorchGold;
  const p = playerOf(state, u.owner);
  if (p) p.gold += gold;
  const victims = city?.owner ? [city.owner] : [];
  log.push({ t: 'scorched', at: { x: u.x, y: u.y }, by: u.owner, cityId: foodLost ? city!.id : null, foodLost, gold }, [...watchers, u.owner, ...victims]);
}

/** Обелиск разрушается, если на его клетке закончил ход отряд противника. */
function resolveStructures(b: Balance, state: GameState, log: EventLog, vision: Map<PlayerId, Vision>, players: PlayerId[]): void {
  const keep = [];
  for (const s of state.world.structures) {
    const enemy = sortById(state.units).find(u => u.hp > 0 && onMap(u) && u.x === s.x && u.y === s.y && u.owner !== s.owner && u.owner !== NEUTRAL && isHostile(b, state, u.owner, s.owner));
    if (!enemy) {
      keep.push(s);
      continue;
    }
    const watchers = players.filter(p => vision.get(p)!.visible[idx(state.map, s.x, s.y)]);
    log.push({ t: 'structure_destroyed', structureId: s.id, kind: s.kind, owner: s.owner, at: { x: s.x, y: s.y }, by: enemy.owner }, [...watchers, s.owner, enemy.owner]);
  }
  state.world.structures = keep;
}

/** Первый отряд, закончивший ход на неразграбленных руинах, получает награду. */
function lootRuins(b: Balance, state: GameState, log: EventLog, vision: Map<PlayerId, Vision>, players: PlayerId[]): void {
  for (const u of sortById(state.units)) {
    if (u.hp <= 0 || !onMap(u) || u.owner === NEUTRAL || isNaval(b, u.type)) continue;
    if (!isLootableRuin(state, u.x, u.y)) continue;
    const p = playerOf(state, u.owner);
    if (!p) continue;
    const r = ruinReward(b, state, u.owner, u.x, u.y);
    state.world.lootedRuins.push(idx(state.map, u.x, u.y));
    if (r.kind === 'gold') p.gold += r.amount;
    else if (r.kind === 'knowledge') p.researchProgress += r.amount;
    else if (r.kind === 'xp') grantXp(b, state, u, r.amount, log);
    else p.materials[r.kind] += r.amount;
    const watchers = players.filter(pl => vision.get(pl)!.visible[idx(state.map, u.x, u.y)]);
    log.push({ t: 'ruins_looted', at: { x: u.x, y: u.y }, playerId: p.id, unitId: u.id, reward: r.kind, amount: r.amount }, [...watchers, p.id]);
  }
}

/** Мировые события: окончание действующих и объявление нового на следующий ход. Видны всем. */
function advanceWorldEvents(b: Balance, state: GameState, log: EventLog, players: PlayerId[]): void {
  const next = state.turn + 1;
  const ended = state.world.events.filter(e => e.endTurn < next);
  for (const e of ended) log.push({ t: 'world_event', eventId: e.id, phase: 'end', endTurn: e.endTurn }, players);
  state.world.events = state.world.events.filter(e => e.endTurn >= next);
  const id = rollWorldEvent(b, state.map.seed, next);
  if (!id || state.world.events.some(e => e.id === id)) return;
  const ev = { id, startTurn: next, endTurn: next + b.worldEvents.duration - 1 };
  state.world.events.push(ev);
  if (b.worldEvents.list[id].effects.restoreRuins) state.world.lootedRuins = [];
  log.push({ t: 'world_event', eventId: id, phase: 'start', endTurn: ev.endTurn }, players);
}


/**
 * Сдача игрока. Правила выбытия: отряды распускаются, города становятся нейтральными (без гарнизона,
 * очередь и запас производства сбрасываются), обелиски разрушаются, договоры расторгаются.
 * Повторная сдача ничего не меняет.
 */
function applySurrender(state: GameState, playerId: PlayerId, log: EventLog, players: PlayerId[]): void {
  const p = playerOf(state, playerId);
  if (!p || p.eliminated) return;
  p.eliminated = true;
  const unitsDisbanded = state.units.filter(u => u.owner === playerId).length;
  state.units = state.units.filter(u => u.owner !== playerId);
  let citiesReleased = 0;
  for (const c of state.cities) {
    if (c.owner === playerId) {
      c.owner = null;
      c.queue = [];
      c.productionStock = 0;
      c.contestedBy = null;
      c.contestedSinceTurn = null;
      citiesReleased++;
    } else if (c.contestedBy === playerId) {
      c.contestedBy = null;
      c.contestedSinceTurn = null;
    }
  }
  state.world.structures = state.world.structures.filter(s => s.owner !== playerId);
  state.diplomacy = state.diplomacy.filter(t => t.a !== playerId && t.b !== playerId);
  p.commander.unitId = null;
  p.commander.respawnTurn = null;
  log.push({ t: 'player_surrendered', playerId, citiesReleased, unitsDisbanded }, players);
  log.push({ t: 'player_eliminated', playerId }, players);
}
