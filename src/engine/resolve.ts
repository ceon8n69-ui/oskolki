// Серверный расчёт хода. Чистая функция: (состояние, приказы) → (новое состояние, события).
// Порядок фаз задокументирован в docs/TURN_RESOLUTION.md и не должен меняться без смены rulesVersion.
import type { Balance } from '../shared/balance.ts';
import type {
  Coord,
  GameState,
  PlayerId,
  StoredEvent,
  SubmittedOrder,
  TurnEvent,
  UnitOrder,
  UnitState,
} from '../shared/types.ts';
import { NEUTRAL } from '../shared/types.ts';
import { canonicalize } from './canonical.ts';
import { computeDamage, rankForXp } from './combat.ts';
import { DIRS8, dist, idx, isLandPassable, landMoveCost } from './grid.ts';
import { hashParts, turnSeed } from './rng.ts';
import { validateAll } from './validate.ts';
import type { Vision } from './vision.ts';
import { canSeeUnitAt, computeAllVision, updateExploredAndIntel } from './vision.ts';

export const RULES_VERSION = 'rules-1.0.0';

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

function removeStatus(u: UnitState, id: string): void {
  u.statuses = u.statuses.filter(s => s.id !== id);
}

export function resolveTurn(b: Balance, input: GameState, orders: SubmittedOrder[]): ResolveResult {
  const state = canonicalize(structuredClone(input));
  const log = new EventLog();
  const seed = turnSeed(state.map.seed, state.turn);
  const players = state.players.map(p => p.id);

  // ---------- 1. Проверка приказов и резерв ресурсов ----------
  const vision0 = computeAllVision(b, state);
  const { accepted, rejected } = validateAll(b, state, orders, vision0);
  for (const r of rejected) log.push({ t: 'order_rejected', playerId: r.order.playerId, orderId: r.order.id, reason: r.reason }, [r.order.playerId]);

  const unitOrders = new Map<string, UnitOrder>();
  for (const so of accepted) if (so.order.kind === 'unit') unitOrders.set(so.order.unitId, so.order);

  // Найм: золото списывается здесь один раз, предмет встаёт в очередь города.
  for (const so of accepted) {
    const o = so.order;
    if (o.kind === 'recruit') {
      const p = state.players.find(pl => pl.id === so.playerId)!;
      const city = state.cities.find(c => c.id === o.cityId)!;
      const cost = b.units[o.unitType].cost.gold;
      p.gold -= cost;
      city.queue.push({ kind: 'unit', unitType: o.unitType, progress: 0, paid: true, orderId: so.id });
      log.push({ t: 'production_queued', cityId: city.id, owner: p.id, unitType: o.unitType, goldSpent: cost }, [p.id]);
    } else if (o.kind === 'research') {
      const p = state.players.find(pl => pl.id === so.playerId)!;
      p.researchQueue = [...o.queue];
    }
  }
  for (const u of state.units) u.countersUsed = 0;

  // ---------- 2. Подготовительные действия ----------
  log.phase = 'prepare';
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    if (o?.mode === 'hold') {
      if (!u.statuses.some(s => s.id === 'fortified')) {
        u.statuses.push({ id: 'fortified', source: 'hold', expiresTurn: null });
      }
      log.push({ t: 'fortify', unitId: u.id, at: { x: u.x, y: u.y } }, visibleToUnitAt(b, state, vision0, u, u, players));
    } else if (o && o.path.length) {
      removeStatus(u, 'fortified');
    }
  }

  // ---------- 3. Движение по шагам ----------
  log.phase = 'move';
  resolveMovement(b, state, unitOrders, seed, log, vision0, players);

  // ---------- 4. Видимость после движения ----------
  const vision1 = computeAllVision(b, state);

  // ---------- 5–7. Атаки по ступеням инициативы ----------
  log.phase = 'combat';
  resolveCombat(b, state, unitOrders, seed, log, vision1, players);

  // ---------- 8. Захват объектов ----------
  log.phase = 'capture';
  resolveCapture(b, state, log, vision1, players);

  // ---------- 9. Экономика, производство, исследования ----------
  log.phase = 'economy';
  resolveEconomy(b, state, log, players);

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

  // ---------- 10. Итог ----------
  log.phase = 'finalize';
  const visionEnd = computeAllVision(b, state);
  state.turn += 1;
  updateExploredAndIntel(b, state, visionEnd);
  canonicalize(state);
  return { state, events: log.events };
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

// ======================= Движение =======================

function resolveMovement(
  b: Balance,
  state: GameState,
  unitOrders: Map<string, UnitOrder>,
  seed: string,
  log: EventLog,
  vision0: Map<PlayerId, Vision>,
  players: PlayerId[],
): void {
  const map = state.map;
  const occupant = new Map<number, UnitState>();
  for (const u of state.units) occupant.set(idx(map, u.x, u.y), u);

  interface Mover { u: UnitState; path: Coord[]; step: number; spent: number; budget: number; stopped: boolean }
  const movers: Mover[] = [];
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    if (!o || o.mode === 'hold' || !o.path.length) continue;
    movers.push({ u, path: o.path, step: 0, spent: 0, budget: b.units[u.type].move, stopped: false });
  }
  movers.sort((a, c) => (a.u.id < c.u.id ? -1 : 1));
  const maxTicks = movers.reduce((m, x) => Math.max(m, x.path.length), 0);

  for (let tick = 0; tick < maxTicks; tick++) {
    const active = movers.filter(m => !m.stopped && m.step < m.path.length);
    if (!active.length) break;
    const want = new Map<Mover, Coord>();
    for (const m of active) {
      const next = m.path[m.step];
      const c = landMoveCost(b, map, m.u, next);
      if (c === null || m.spent + c > m.budget + 1e-9 || dist(m.u, next) !== 1) {
        m.stopped = true;
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

    // в) занятые клетки: блок, пока занимающий не уходит успешно (фиксированная точка)
    const leaving = (u: UnitState): boolean => {
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
    for (const mv of moves) {
      mv.m.spent += landMoveCost(b, map, mv.from, mv.to)!;
      mv.m.u.x = mv.to.x;
      mv.m.u.y = mv.to.y;
      mv.m.step++;
      occupant.set(idx(map, mv.to.x, mv.to.y), mv.m.u);
    }
    // События движения: видны тем, кто видел отряд в начале или видит его клетку после шага.
    const visionNow = computeAllVision(b, state);
    for (const mv of moves) {
      log.push(
        { t: 'move', unitId: mv.m.u.id, owner: mv.m.u.owner, from: mv.from, to: mv.to, tick },
        visibleToUnitAt(b, state, vision0, mv.m.u, mv.from, players, [mv.to], visionNow),
      );
    }
    for (const [m, reason] of blocked) {
      m.stopped = true;
      const wanted = want.get(m)!;
      // Причину «скрытое препятствие» видит только владелец; положение блокирующего не раскрывается.
      log.push({ t: 'move_blocked', unitId: m.u.id, owner: m.u.owner, at: { x: m.u.x, y: m.u.y }, wanted, tick, reason }, [m.u.owner]);
    }
  }
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
      if ((hp0.get(a.target.id) ?? 0) <= 0) {
        log.push({ t: 'attack_failed', attackerId: a.attacker.id, owner: a.attacker.owner, reason: 'target_destroyed', at: { x: a.attacker.x, y: a.attacker.y } }, [a.attacker.owner]);
        continue;
      }
      if (dist(a.attacker, a.target) > b.units[a.attacker.type].range) {
        // Цель ушла из зоны — автоматического преследования нет.
        log.push({ t: 'attack_failed', attackerId: a.attacker.id, owner: a.attacker.owner, reason: 'target_out_of_range', at: { x: a.attacker.x, y: a.attacker.y } }, [a.attacker.owner]);
        continue;
      }
      if (!canSeeUnitAt(b, state, vision1.get(a.attacker.owner)!, a.target.x, a.target.y)) {
        log.push({ t: 'attack_failed', attackerId: a.attacker.id, owner: a.attacker.owner, reason: 'target_not_visible', at: { x: a.attacker.x, y: a.attacker.y } }, [a.attacker.owner]);
        continue;
      }
      const r = computeDamage(b, state, a.attacker, a.target, hp0.get(a.attacker.id)!, hp0.get(a.target.id)!);
      const exchange = inTier.some(o => o.attacker === a.target && o.target === a.attacker);
      valid.push({ a, damage: r.damage, counter: r.counter, counterPossible: r.counterPossible, exchange });
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
    // Потери ступени.
    for (const u of [...state.units]) {
      if (u.hp > 0) continue;
      log.push({ t: 'unit_destroyed', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, unitType: u.type }, visibleToUnitAt(b, state, vision1, u, u, players));
      // Опыт за уничтожение — тем, кто нанёс урон в этой ступени.
      for (const v of valid) if (v.a.target === u && v.a.attacker.hp > 0) addXp(v.a.attacker, b.units[v.a.attacker.type].xpOnKill);
    }
    state.units = state.units.filter(u => u.hp > 0);
  }
  // Атака снимает укрепление.
  for (const a of attacks) removeStatus(a.attacker, 'fortified');
  applyXp(b, state, xpGain, log);
}

function applyXp(b: Balance, state: GameState, gain: Map<string, number>, log: EventLog): void {
  for (const [id, amount] of [...gain].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
    const u = state.units.find(x => x.id === id);
    if (!u || u.owner === NEUTRAL) continue;
    const before = u.rank;
    u.xp += amount;
    u.rank = rankForXp(b, u.xp);
    const rankUp = u.rank > before;
    if (rankUp) u.hp += (b.ranks.hpBonus[u.rank] ?? 0) - (b.ranks.hpBonus[before] ?? 0);
    log.push({ t: 'xp', unitId: u.id, amount, rankUp }, [u.owner]);
  }
}

// ======================= Захват =======================

function resolveCapture(b: Balance, state: GameState, log: EventLog, vision: Map<PlayerId, Vision>, players: PlayerId[]): void {
  for (const city of [...state.cities].sort((a, c) => (a.id < c.id ? -1 : 1))) {
    const occ = state.units.find(u => u.x === city.x && u.y === city.y);
    const watchers = players.filter(p => vision.get(p)!.visible[idx(state.map, city.x, city.y)]);
    const ownerList = city.owner && city.owner !== NEUTRAL ? [city.owner] : [];
    if (occ && occ.owner !== NEUTRAL && occ.owner !== city.owner) {
      const holding = city.contestedBy === occ.owner && city.contestedSinceTurn !== null && city.contestedSinceTurn <= state.turn - b.capture.holdTurns;
      if (holding) {
        const from = city.owner;
        city.owner = occ.owner;
        city.contestedBy = null;
        city.contestedSinceTurn = null;
        city.queue = [];
        city.productionStock = 0;
        log.push({ t: 'city_captured', cityId: city.id, from, to: occ.owner, at: { x: city.x, y: city.y } }, [...watchers, ...ownerList, occ.owner]);
        occ.xp += b.xp.perCapture;
        const r = rankForXp(b, occ.xp);
        if (r > occ.rank) {
          occ.hp += (b.ranks.hpBonus[r] ?? 0) - (b.ranks.hpBonus[occ.rank] ?? 0);
          occ.rank = r;
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

export interface IncomeBreakdown {
  gold: number;
  upkeep: number;
  knowledge: number;
  production: Record<string, number>;
}

export function incomeFor(b: Balance, state: GameState, playerId: PlayerId): IncomeBreakdown {
  let gold = 0;
  let knowledge = 0;
  const production: Record<string, number> = {};
  for (const c of state.cities) {
    if (c.owner !== playerId) continue;
    const mul = c.contestedBy ? b.cities.occupiedIncomeMultiplier : 1;
    gold += ((b.cities.goldPerLevel[c.level] ?? 0) + (c.isCapital ? b.cities.capitalBonusGold : 0)) * mul;
    knowledge += (b.cities.knowledgePerLevel[c.level] ?? 0) * mul;
    production[c.id] = (b.cities.productionPerLevel[c.level] ?? 0) * mul;
  }
  let upkeep = 0;
  for (const u of state.units) if (u.owner === playerId) upkeep += b.units[u.type].upkeep;
  return { gold: Math.floor(gold), upkeep, knowledge: Math.floor(knowledge), production };
}

function resolveEconomy(b: Balance, state: GameState, log: EventLog, players: PlayerId[]): void {
  for (const p of state.players) {
    if (p.eliminated) continue;
    const inc = incomeFor(b, state, p.id);
    p.gold += inc.gold - inc.upkeep;
    const deficit = p.gold < 0;
    log.push({ t: 'income', playerId: p.id, gold: inc.gold, upkeep: inc.upkeep, knowledge: inc.knowledge, deficit }, [p.id]);

    // Исследования: общий пул прогресса, смена очереди не дублирует прогресс.
    p.researchProgress += inc.knowledge;
    while (p.researchQueue.length) {
      const tech = p.researchQueue[0];
      const rule = b.techs[tech];
      if (!rule || p.researched.includes(tech) || !rule.requires.every(r => p.researched.includes(r))) {
        p.researchQueue.shift();
        continue;
      }
      if (p.researchProgress < rule.cost) break;
      p.researchProgress -= rule.cost;
      p.researched.push(tech);
      p.researchQueue.shift();
      log.push({ t: 'research_completed', playerId: p.id, techId: tech }, [p.id]);
    }

    // Производство в городах.
    for (const c of state.cities.filter(c => c.owner === p.id).sort((a, x) => (a.id < x.id ? -1 : 1))) {
      const head = c.queue[0];
      if (!head) continue;
      head.progress += inc.production[c.id] ?? 0;
      const need = b.units[head.unitType].cost.production;
      if (head.progress < need) continue;
      const spot = spawnSpot(b, state, c);
      if (!spot) {
        log.push({ t: 'production_blocked', cityId: c.id, owner: p.id, reason: 'no_space' }, [p.id]);
        continue;
      }
      c.queue.shift();
      const id = `u${state.nextIds.unit++}`;
      const rule = b.units[head.unitType];
      state.units.push({ id, owner: p.id, type: head.unitType, x: spot.x, y: spot.y, hp: rule.hp, xp: 0, rank: 0, statuses: [], countersUsed: 0, createdTurn: state.turn });
      log.push({ t: 'unit_recruited', unitId: id, owner: p.id, cityId: c.id, at: spot, unitType: head.unitType }, [p.id]);
    }
  }
  void players;
}

function spawnSpot(b: Balance, state: GameState, c: { x: number; y: number }): Coord | null {
  const free = (x: number, y: number) => isLandPassable(b, state.map, x, y) && !state.units.some(u => u.x === x && u.y === y);
  if (free(c.x, c.y)) return { x: c.x, y: c.y };
  for (const [dx, dy] of DIRS8) if (free(c.x + dx, c.y + dy)) return { x: c.x + dx, y: c.y + dy };
  return null;
}

