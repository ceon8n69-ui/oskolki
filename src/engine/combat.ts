// Формула боя. Единственное место, где считается урон: сервер и предпросмотр используют её же.
import type { Balance } from '../shared/balance.ts';
import { terrainRule } from '../shared/balance.ts';
import type { GameState, PlayerId, UnitState } from '../shared/types.ts';
import { dist, terrainAt } from './grid.ts';

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
  attackForce: number;
  defenseForce: number;
}

function techModifiers(b: Balance, state: GameState, owner: PlayerId) {
  const p = state.players.find(pl => pl.id === owner);
  let attackBonus = 0;
  let cityDefenseBonus = 0;
  if (p) {
    for (const t of p.researched) {
      attackBonus += b.techs[t]?.modifiers.attackBonus ?? 0;
      cityDefenseBonus += b.techs[t]?.modifiers.cityDefenseBonus ?? 0;
    }
  }
  return { attackBonus, cityDefenseBonus };
}

export function maxHp(b: Balance, u: Pick<UnitState, 'type' | 'rank'>): number {
  return b.units[u.type].hp + (b.ranks.hpBonus[u.rank] ?? 0);
}

export function hasStatus(u: UnitState, id: string): boolean {
  return u.statuses.some(s => s.id === id);
}

export function attackValue(b: Balance, state: GameState, u: UnitState, target: UnitState, mods: Modifier[]): number {
  const rule = b.units[u.type];
  let a = rule.attack + techModifiers(b, state, u.owner).attackBonus;
  const rankMul = b.ranks.attackMultiplier[u.rank] ?? 1;
  if (rankMul !== 1) mods.push({ id: `rank_${u.rank}`, value: rankMul, side: 'attack' });
  a *= rankMul;
  const vs = rule.bonusVs?.[target.type];
  if (vs) {
    mods.push({ id: `bonus_vs_${target.type}`, value: vs, side: 'attack' });
    a *= vs;
  }
  return a;
}

export function defenseValue(b: Balance, state: GameState, u: UnitState, mods: Modifier[]): number {
  const rule = b.units[u.type];
  let d = rule.defense;
  const terr = terrainRule(b, terrainAt(state.map, u.x, u.y)).defense;
  if (terr !== 1) mods.push({ id: 'terrain', value: terr, side: 'defense' });
  d *= terr;
  const city = state.cities.find(c => c.x === u.x && c.y === u.y && c.owner === u.owner);
  if (city) {
    const v = b.combat.cityDefense + techModifiers(b, state, u.owner).cityDefenseBonus;
    mods.push({ id: 'city', value: v, side: 'defense' });
    d *= v;
  }
  if (hasStatus(u, 'fortified')) {
    mods.push({ id: 'fortified', value: b.combat.fortifyDefense, side: 'defense' });
    d *= b.combat.fortifyDefense;
  }
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
): DamageResult {
  const modifiers: Modifier[] = [];
  const atk = attackValue(b, state, attacker, defender, modifiers);
  const def = defenseValue(b, state, defender, modifiers);
  const attackForce = atk * (attackerHp / maxHp(b, attacker));
  const defenseForce = def * (defenderHp / maxHp(b, defender));
  const total = attackForce + defenseForce;
  const k = b.combat.damageScale;
  const damage = total <= 0 ? 0 : Math.max(b.combat.minDamage, Math.round((attackForce / total) * atk * k));
  const counter = total <= 0 ? 0 : Math.round((defenseForce / total) * def * k);
  const counterPossible = dist(attacker, defender) <= b.units[defender.type].range && counter > 0;
  return { damage, counter, counterPossible, modifiers, attackForce, defenseForce };
}

export function rankForXp(b: Balance, xp: number): number {
  let r = 0;
  for (let i = 0; i < b.ranks.thresholds.length; i++) if (xp >= b.ranks.thresholds[i]) r = i;
  return r;
}
