// Производные характеристики: учёт народа, технологий, улучшений и командира.
// Все функции чистые и детерминированные; правила боя и движения берут параметры только отсюда.
import type { Balance, FactionTraits, Materials, TechModifiers } from '../shared/balance.ts';
import { hasAbility } from '../shared/balance.ts';
import type { Coord, GameState, MapData, PlayerId, PlayerState, UnitState } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { dist, idx, inBounds } from './grid.ts';

export function playerOf(state: GameState, id: PlayerId): PlayerState | undefined {
  return state.players.find(p => p.id === id);
}

export function traitsOf(b: Balance, state: GameState, owner: PlayerId): FactionTraits {
  const p = playerOf(state, owner);
  return (p && b.factions[p.faction]?.traits) || {};
}

/** Сводные модификаторы технологий игрока. Числа складываются, множители перемножаются, флаги — «или». */
export interface TechSummary {
  attackBonus: number;
  cityDefenseBonus: number;
  goldPerCity: number;
  rangeBonus: Record<string, number>;
  moveBonus: Record<string, number>;
  siegeAttackAfterMove: boolean;
  attackBonusClass: Record<string, number>;
  xpMul: number;
  roadCostMul: number;
  supplyRadius: number;
  healBonus: number;
  visionBonusClass: Record<string, number>;
  cityVisionBonus: number;
  roadSupply: boolean;
  formationBonus: number;
  plantForestAny: boolean;
  ambushBonus: number;
  mountainMoveCost: number | null;
  fortBonus: number;
  deepWater: boolean;
  coastalGold: number;
  foodPerCity: number;
  lootBonus: number;
  plunderBonus: number;
  frontLimitBonus: number;
  scorchGold: number;
  resonanceBonus: number;
  obeliskLink: number;
  ruinsKnowledge: number;
  obeliskField: number;
}

/** Сумма действия активных мировых событий по ключу (0 — нет событий). */
export function worldEffect(b: Balance, state: GameState, key: keyof Balance['worldEvents']['list'][string]['effects']): number {
  let s = 0;
  for (const e of state.world?.events ?? []) {
    if (e.startTurn > state.turn || state.turn > e.endTurn) continue;
    s += b.worldEvents.list[e.id]?.effects[key] ?? 0;
  }
  return s;
}

export function worldHas(b: Balance, state: GameState, key: keyof Balance['worldEvents']['list'][string]['effects']): boolean {
  return (state.world?.events ?? []).some(e => e.startTurn <= state.turn && state.turn <= e.endTurn && b.worldEvents.list[e.id]?.effects[key] !== undefined);
}

const summaryCache = new WeakMap<PlayerState, { key: string; s: TechSummary }>();

export function techs(b: Balance, state: GameState, owner: PlayerId): TechSummary {
  const p = playerOf(state, owner);
  const key = p ? p.researched.join(',') : '';
  if (p) {
    const c = summaryCache.get(p);
    if (c && c.key === key) return c.s;
  }
  const s: TechSummary = {
    attackBonus: 0, cityDefenseBonus: 0, goldPerCity: 0, rangeBonus: {}, moveBonus: {}, siegeAttackAfterMove: false,
    attackBonusClass: {}, xpMul: 1, roadCostMul: 1, supplyRadius: 0, healBonus: 0, visionBonusClass: {}, cityVisionBonus: 0,
    roadSupply: false, formationBonus: 0, plantForestAny: false, ambushBonus: 0, mountainMoveCost: null, fortBonus: 0,
    deepWater: false, coastalGold: 0, foodPerCity: 0, lootBonus: 0, plunderBonus: 0, frontLimitBonus: 0, scorchGold: 0,
    resonanceBonus: 0, obeliskLink: 0, ruinsKnowledge: 0, obeliskField: 0,
  };
  const addMap = (dst: Record<string, number>, src?: Record<string, number>) => {
    for (const [k, v] of Object.entries(src ?? {})) dst[k] = (dst[k] ?? 0) + v;
  };
  for (const t of p?.researched ?? []) {
    const m: TechModifiers = b.techs[t]?.modifiers ?? {};
    s.attackBonus += m.attackBonus ?? 0;
    s.cityDefenseBonus += m.cityDefenseBonus ?? 0;
    s.goldPerCity += m.goldPerCity ?? 0;
    addMap(s.rangeBonus, m.rangeBonus);
    addMap(s.moveBonus, m.moveBonus);
    addMap(s.attackBonusClass, m.attackBonusClass);
    addMap(s.visionBonusClass, m.visionBonusClass);
    s.siegeAttackAfterMove ||= !!m.siegeAttackAfterMove;
    s.xpMul *= m.xpMul ?? 1;
    s.roadCostMul *= m.roadCostMul ?? 1;
    s.supplyRadius += m.supplyRadius ?? 0;
    s.healBonus += m.healBonus ?? 0;
    s.cityVisionBonus += m.cityVisionBonus ?? 0;
    s.roadSupply ||= !!m.roadSupply;
    s.formationBonus += m.formationBonus ?? 0;
    s.plantForestAny ||= !!m.plantForestAny;
    s.ambushBonus += m.ambushBonus ?? 0;
    if (m.mountainMoveCost !== undefined) s.mountainMoveCost = m.mountainMoveCost;
    s.fortBonus += m.fortBonus ?? 0;
    s.deepWater ||= !!m.deepWater;
    s.coastalGold += m.coastalGold ?? 0;
    s.foodPerCity += m.foodPerCity ?? 0;
    s.lootBonus += m.lootBonus ?? 0;
    s.plunderBonus += m.plunderBonus ?? 0;
    s.frontLimitBonus += m.frontLimitBonus ?? 0;
    s.scorchGold += m.scorchGold ?? 0;
    s.resonanceBonus += m.resonanceBonus ?? 0;
    s.obeliskLink += m.obeliskLink ?? 0;
    s.ruinsKnowledge += m.ruinsKnowledge ?? 0;
    s.obeliskField += m.obeliskField ?? 0;
  }
  if (p) summaryCache.set(p, { key, s });
  return s;
}

// ---------- Стоимость ----------

/** Цена отряда для игрока (Горные кланы платят больше золота). */
export function unitCost(b: Balance, state: GameState, owner: PlayerId, unitType: string): { gold: number; production: number } & Materials {
  const r = b.units[unitType].cost;
  const mul = traitsOf(b, state, owner).costMul ?? 1;
  return { gold: Math.ceil(r.gold * mul), production: r.production, wood: r.wood ?? 0, iron: r.iron ?? 0, crystal: r.crystal ?? 0 };
}

export function roadGoldCost(b: Balance, state: GameState, owner: PlayerId): number {
  return Math.max(1, Math.round(b.roads.goldCost * (traitsOf(b, state, owner).roadCostMul ?? 1) * techs(b, state, owner).roadCostMul));
}

// ---------- Характеристики отряда ----------

export function baseMaxHp(b: Balance, state: GameState, owner: PlayerId, unitType: string, rank = 0): number {
  return b.units[unitType].hp + (traitsOf(b, state, owner).hpBonus ?? 0) + (b.ranks.hpBonus[rank] ?? 0);
}

export function unitClass(b: Balance, unitType: string): string {
  return b.units[unitType].class;
}

export function rangeOf(b: Balance, state: GameState, u: Pick<UnitState, 'type' | 'owner'>): number {
  return b.units[u.type].range + (techs(b, state, u.owner).rangeBonus[unitClass(b, u.type)] ?? 0);
}

export function visionOf(b: Balance, state: GameState, u: Pick<UnitState, 'type' | 'owner'>): number {
  const v = b.units[u.type].vision + (techs(b, state, u.owner).visionBonusClass[unitClass(b, u.type)] ?? 0);
  return Math.max(1, v + worldEffect(b, state, 'vision'));
}

export function canAttackAfterMove(b: Balance, state: GameState, u: Pick<UnitState, 'type' | 'owner'>): boolean {
  if (!hasAbility(b, u.type, 'no_attack_after_move')) return true;
  return techs(b, state, u.owner).siegeAttackAfterMove;
}

/**
 * Бюджет движения на ход: база + технологии (+1 от «Ускоренного марша», если передан набор),
 * + натиск Пепельных орд, ± морские мировые события для флота.
 */
export function moveOf(b: Balance, state: GameState, u: Pick<UnitState, 'type' | 'owner' | 'id'> & { statuses?: UnitState['statuses'] }, forcedMarch?: Set<string>): number {
  let m = b.units[u.type].move + (techs(b, state, u.owner).moveBonus[unitClass(b, u.type)] ?? 0) + (forcedMarch?.has(u.id) ? 1 : 0);
  if (u.statuses?.some(s => s.id === 'momentum')) m += traitsOf(b, state, u.owner).momentumMove ?? 0;
  if (hasAbility(b, u.type, 'naval')) m = Math.max(1, m + worldEffect(b, state, 'navalMove'));
  return m;
}

// ---------- Профиль передвижения ----------

/** Особые стоимости клеток для конкретного отряда (народ, способности, улучшения). */
export interface MoveProfile {
  naval?: boolean;
  forest?: number;
  hills?: number;
  mountain?: number;
  shallow?: number;
  deep?: number;
}

export function moveProfile(b: Balance, state: GameState, u: Pick<UnitState, 'type' | 'owner'> & { perks?: string[] }): MoveProfile {
  const tr = traitsOf(b, state, u.owner);
  const tc = techs(b, state, u.owner);
  if (hasAbility(b, u.type, 'naval')) return { naval: true };
  const p: MoveProfile = {};
  if (tr.forestCost !== undefined || hasAbility(b, u.type, 'forest_stride') || u.perks?.includes('forest_move')) p.forest = Math.min(tr.forestCost ?? 1, 1);
  if (tr.hillsCost !== undefined) p.hills = tr.hillsCost;
  if (tc.mountainMoveCost !== null) p.mountain = tc.mountainMoveCost; // «Тоннели» — технология Горных кланов
  if (hasAbility(b, u.type, 'amphibious')) p.shallow = 1;
  else if (tr.shallowWater) p.shallow = tr.shallowCost ?? 1;
  if (hasAbility(b, u.type, 'amphibious') && tc.deepWater) p.deep = 2;
  return p;
}

// ---------- Вода (Народ Приливов) ----------

const waterDistCache = new WeakMap<Uint8Array, Uint8Array>();

/** Расстояние (Чебышёва, до 255) от клетки до ближайшей воды. Кешируется по массиву рельефа. */
export function waterDistance(map: MapData): Uint8Array {
  const cached = waterDistCache.get(map.terrain);
  if (cached) return cached;
  const n = map.width * map.height;
  const d = new Uint8Array(n).fill(255);
  const q: number[] = [];
  for (let i = 0; i < n; i++) if (map.terrain[i] <= Terrain.ShallowWater) {
    d[i] = 0;
    q.push(i);
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % map.width, y = (i - x) / map.width;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(map, nx, ny)) continue;
      const j = idx(map, nx, ny);
      if (d[j] > d[i] + 1) {
        d[j] = d[i] + 1;
        q.push(j);
      }
    }
  }
  waterDistCache.set(map.terrain, d);
  return d;
}

// ---------- Командир ----------

export function commanderUnit(state: GameState, owner: PlayerId): UnitState | undefined {
  const p = playerOf(state, owner);
  const id = p?.commander?.unitId;
  return id ? state.units.find(u => u.id === id && u.hp > 0) : undefined;
}

/** Уровень направления развития командира, действующий на клетку (0 — командира рядом нет). */
export function commanderAura(b: Balance, state: GameState, owner: PlayerId, at: Coord, direction: string): number {
  const p = playerOf(state, owner);
  const lvl = p?.commander?.directions?.[direction] ?? 0;
  if (!lvl) return 0;
  const c = commanderUnit(state, owner);
  if (!c || dist(c, at) > b.commander.auraRadius) return 0;
  return lvl;
}
