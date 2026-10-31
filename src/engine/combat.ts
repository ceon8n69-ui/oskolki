// Формула боя. Единственное место, где считается урон: сервер и предпросмотр используют её же.
// Каждый множитель попадает в список modifiers с идентификатором из balance.effects / причиной —
// игрок видит все существенные бонусы в прогнозе, ничего не спрятано в описаниях технологий.
import type { Balance } from '../shared/balance.ts';
import { hasAbility, terrainRule } from '../shared/balance.ts';
import type { GameState, UnitState } from '../shared/types.ts';
import { Feature, NEUTRAL, Terrain } from '../shared/types.ts';
import { dist, featuresAt, idx, terrainAt } from './grid.ts';
import { cityBuildingEffect } from './supply.ts';
import { commanderAura, rangeOf, techs, traitsOf, unitClass, waterDistance } from './stats.ts';
import { inResonance, resonanceMul } from './world.ts';

export interface Modifier {
  id: string;
  value: number; // множитель
  side: 'attack' | 'defense';
}

export interface DamageResult {
  damage: number;
  counter: number; // возможная контратака (если цель выживет и достаёт атакующего)
  counterPossible: boolean;
  modifiers: Modifier[];
  counterModifiers: Modifier[];
  attackForce: number;
  defenseForce: number;
}

/** Обстоятельства хода, которых нет в состоянии: кто был замечен в начале хода, действующие способности командиров. */
export interface CombatContext {
  /** Видел ли владелец цели атакующего в начале хода (для засады). */
  seenAtStart?: (attacker: UnitState, targetOwner: string) => boolean;
  siegeSupport?: Set<string>;
  /** «Боевой клич» командира Пепельных орд. */
  warcry?: Set<string>;
}

export function maxHp(_b: Balance, u: Pick<UnitState, 'maxHp'>): number {
  return u.maxHp;
}

export function hasStatus(u: UnitState, id: string): boolean {
  return u.statuses.some(s => s.id === id);
}

function friendsAdjacent(state: GameState, u: UnitState): UnitState[] {
  return state.units.filter(o => o !== u && o.owner === u.owner && o.hp > 0 && !o.carriedBy && dist(o, u) === 1);
}

function cityAt(state: GameState, x: number, y: number) {
  return state.cities.find(c => c.x === x && c.y === y);
}

function classMatches(b: Balance, perk: string, targetType: string): boolean {
  const cls = unitClass(b, targetType);
  if (perk === 'vs_cavalry') return cls === 'cavalry';
  if (perk === 'vs_infantry') return cls === 'infantry' || cls === 'shield' || cls === 'spear';
  if (perk === 'vs_ranged') return cls === 'ranged' || cls === 'siege';
  return false;
}

export function attackValue(b: Balance, state: GameState, u: UnitState, target: UnitState, mods: Modifier[], ctx: CombatContext = {}): number {
  const rule = b.units[u.type];
  const tc = techs(b, state, u.owner);
  const tr = traitsOf(b, state, u.owner);
  let a = rule.attack + tc.attackBonus + (tc.attackBonusClass[rule.class] ?? 0);
  const push = (id: string, v: number) => {
    if (v === 1) return;
    mods.push({ id, value: v, side: 'attack' });
    a *= v;
  };
  push(`rank_${u.rank}`, b.ranks.attackMultiplier[u.rank] ?? 1);
  const vs = rule.bonusVs?.[target.type] ?? rule.bonusVs?.[unitClass(b, target.type)];
  if (vs) push(`bonus_vs_${unitClass(b, target.type)}`, vs);
  for (const perk of u.perks ?? []) if (classMatches(b, perk, target.type)) push(`perk_${perk}`, 1.15);
  // Высота: атакующий выше цели.
  const hA = terrainRule(b, terrainAt(state.map, u.x, u.y)).height;
  const hT = terrainRule(b, terrainAt(state.map, target.x, target.y)).height;
  if (hA > hT && hT > 0) push('high_ground', b.combat.highGroundAttack);
  // Цель в городе: осадные бьют сильнее, Лесные хранители — слабее.
  const targetInCity = !!cityAt(state, target.x, target.y);
  if (targetInCity && hasAbility(b, u.type, 'siege')) push('siege_vs_city', b.combat.siegeVsCity);
  if (targetInCity && tr.vsCityMul) push('forest_vs_city', tr.vsCityMul);
  if (targetInCity && ctx.siegeSupport?.has(u.id)) push('siege_support', 1.25);
  // Засада: из леса, по противнику, который не видел атакующего в начале хода.
  if (tr.ambushMul && terrainAt(state.map, u.x, u.y) === Terrain.Forest && ctx.seenAtStart && !ctx.seenAtStart(u, target.owner)) {
    push('ambush', tr.ambushMul + tc.ambushBonus);
  }
  // Народ Приливов: у воды сильнее, вдали — слабее.
  if (tr.coastAttackMul || tr.inlandAttackMul) {
    const wd = waterDistance(state.map)[idx(state.map, u.x, u.y)];
    if (wd <= 1 && tr.coastAttackMul) push('coast', tr.coastAttackMul);
    else if (tr.inlandAttackMul && wd > (tr.inlandDistance ?? 3)) push('inland', tr.inlandAttackMul);
  }
  // Степные ханства: натиск с равнины.
  if (tr.plainsAttackMul && terrainAt(state.map, u.x, u.y) === Terrain.Plains) push('steppe_charge', tr.plainsAttackMul);
  // Северные ярлы: ярость раненых (берсерк — при любой ране).
  if (tr.woundedAttackMul && (hasAbility(b, u.type, 'berserk') ? u.hp < u.maxHp : u.hp * 2 <= u.maxHp)) push('fury', tr.woundedAttackMul);
  // Поддержка соседей и командира.
  if (friendsAdjacent(state, u).some(f => hasAbility(b, f.type, 'inspire'))) push('inspire', 1.1);
  const tac = commanderAura(b, state, u.owner, u, 'tactics');
  if (tac) push('tactics', 1 + 0.1 * tac);
  if (ctx.warcry?.has(u.id)) push('warcry', 1.2);
  // Метатель огня: цель в лесу горит.
  if (hasAbility(b, u.type, 'incendiary') && terrainAt(state.map, target.x, target.y) === Terrain.Forest) push('incendiary', 1.3);
  // Хранители руин: поле резонанса усиливает, без узла — слабее.
  if (tr.buildObelisk) {
    if (inResonance(b, state, u)) push('resonance', resonanceMul(b, state, u.owner));
    else if (tr.severedMul) push('severed', tr.severedMul);
  }
  // Состояния.
  if (hasStatus(u, 'suppressed') && !u.perks?.includes('suppress_resist')) push('suppressed', b.combat.suppressedAttack);
  if (hasStatus(u, 'unsupplied')) push('unsupplied', b.combat.unsuppliedMultiplier);
  return a;
}

export function defenseValue(b: Balance, state: GameState, u: UnitState, mods: Modifier[]): number {
  const rule = b.units[u.type];
  let d = rule.defense;
  const push = (id: string, v: number) => {
    if (v === 1) return;
    mods.push({ id, value: v, side: 'defense' });
    d *= v;
  };
  push('terrain', terrainRule(b, terrainAt(state.map, u.x, u.y)).defense);
  const rough = traitsOf(b, state, u.owner).roughDefenseMul;
  const ter = terrainAt(state.map, u.x, u.y);
  if (rough && (ter === Terrain.Forest || ter === Terrain.Hills || ter === Terrain.Mountain)) push('rough_ground', rough);
  const city = state.cities.find(c => c.x === u.x && c.y === u.y && c.owner === u.owner);
  if (city) {
    let v = b.combat.cityDefense + techs(b, state, u.owner).cityDefenseBonus + cityBuildingEffect(b, city, 'cityDefense');
    if (city.specialization) v += b.specializations[city.specialization]?.effects.cityDefense ?? 0;
    push('city', v);
  }
  if (u.owner !== NEUTRAL && featuresAt(state.map, u.x, u.y) & Feature.Fort) push('fort', b.forts.defenseMul + techs(b, state, u.owner).fortBonus);
  if (hasStatus(u, 'fortified')) {
    push('fortified', b.combat.fortifyDefense);
    if (u.perks?.includes('hold_defense')) push('perk_hold_defense', 1.15);
  }
  const friends = friendsAdjacent(state, u);
  if (friends.some(f => hasAbility(b, f.type, 'cover'))) push('cover', b.combat.coverDefense);
  const fm = traitsOf(b, state, u.owner).formation;
  if (fm && friends.length >= fm.minAllies) push('formation', fm.defenseMul + techs(b, state, u.owner).formationBonus);
  if (traitsOf(b, state, u.owner).buildObelisk && inResonance(b, state, u)) push('resonance', resonanceMul(b, state, u.owner));
  if (hasStatus(u, 'unsupplied')) push('unsupplied', b.combat.unsuppliedMultiplier);
  return d;
}

/**
 * Урон без случайности. Силы масштабируются текущим здоровьем.
 * hp передаются явно: бой одной ступени инициативы считается по состоянию начала ступени.
 */
export function computeDamage(
  b: Balance,
  state: GameState,
  attacker: UnitState,
  defender: UnitState,
  attackerHp = attacker.hp,
  defenderHp = defender.hp,
  ctx: CombatContext = {},
): DamageResult {
  const modifiers: Modifier[] = [];
  const atk = attackValue(b, state, attacker, defender, modifiers, ctx);
  const def = defenseValue(b, state, defender, modifiers);
  const attackForce = atk * (attackerHp / attacker.maxHp);
  const defenseForce = def * (defenderHp / defender.maxHp);
  const total = attackForce + defenseForce;
  const k = b.combat.damageScale;
  const damage = total <= 0 ? 0 : Math.max(b.combat.minDamage, Math.round((attackForce / total) * atk * k));
  const counter = total <= 0 ? 0 : Math.round((defenseForce / total) * def * k);
  const counterPossible = dist(attacker, defender) <= rangeOf(b, state, defender) && counter > 0;
  return { damage, counter, counterPossible, modifiers, counterModifiers: modifiers.filter(m => m.side === 'defense'), attackForce, defenseForce };
}

export function rankForXp(b: Balance, xp: number): number {
  let r = 0;
  for (let i = 0; i < b.ranks.thresholds.length; i++) if (xp >= b.ranks.thresholds[i]) r = i;
  return r;
}
