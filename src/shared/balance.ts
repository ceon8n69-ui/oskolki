import raw from '../../config/balance.json' with { type: 'json' };
import type { TerrainCode } from './types.ts';
import { TERRAIN_NAMES } from './types.ts';

export interface TerrainRule {
  moveCost: number | null; // null — непроходимо для сухопутных
  defense: number;
  visionBonus: number;
  hidesUnits: boolean;
  height: number;
}

export type Materials = { wood: number; iron: number; crystal: number };
export type Cost = { gold?: number; production?: number } & Partial<Materials>;

export type UnitAbility =
  | 'zoc' | 'ignore_zoc' | 'cover' | 'knockback' | 'suppress' | 'build' | 'build_fort' | 'fast_build'
  | 'no_attack_after_move' | 'siege' | 'inspire' | 'forest_stride' | 'plant_forest' | 'heavy' | 'amphibious' | 'commander';

export interface UnitRule {
  name: string;
  class: string;
  hp: number;
  attack: number;
  defense: number;
  move: number;
  range: number;
  vision: number;
  initiative: number;
  cost: { gold: number; production: number } & Partial<Materials>;
  upkeep: number;
  requires: string | null;
  recruitable?: boolean;
  faction: string | null;
  xpOnKill: number;
  abilities: UnitAbility[];
  bonusVs?: Record<string, number>; // по классу или типу цели
}

export interface TechModifiers {
  attackBonus?: number;
  cityDefenseBonus?: number;
  goldPerCity?: number;
  rangeBonus?: Record<string, number>; // по классу
  moveBonus?: Record<string, number>;
  siegeAttackAfterMove?: boolean;
  attackBonusClass?: Record<string, number>;
  xpMul?: number;
  roadCostMul?: number;
  supplyRadius?: number;
  healBonus?: number;
  visionBonusClass?: Record<string, number>;
  cityVisionBonus?: number;
  roadSupply?: boolean;
  formationBonus?: number;
  plantForestAny?: boolean;
  ambushBonus?: number;
  mountainMoveCost?: number;
  fortBonus?: number;
  deepWater?: boolean;
  coastalGold?: number;
}

export interface TechRule {
  name: string;
  branch: string;
  faction?: string;
  cost: number;
  requires: string[];
  excludes?: string[];
  unlocksUnits: string[];
  unlocksBuildings: string[];
  modifiers: TechModifiers;
}

export interface BuildingRule {
  name: string;
  cost: { production: number } & Partial<Materials>;
  requires: string | null;
  effects: {
    food?: number; production?: number; gold?: number; knowledge?: number; iron?: number;
    woodPerTile?: number; ironPerTile?: number; crystalPerTile?: number;
    unitProduction?: number; recruitXp?: number; cityDefense?: number; supplyRadius?: number;
  };
}

export interface SpecializationRule {
  name: string;
  effects: { cityDefense?: number; garrisonHeal?: number; goldMul?: number; upkeepRelief?: number; productionMul?: number; knowledgeMul?: number };
}

export interface FactionTraits {
  formation?: { minAllies: number; defenseMul: number };
  roadCostMul?: number;
  forestCost?: number;
  ambushMul?: number;
  vsCityMul?: number;
  plantForest?: boolean;
  hillsCost?: number;
  costMul?: number;
  buildFort?: boolean;
  hpBonus?: number;
  shallowWater?: boolean;
  coastAttackMul?: number;
  inlandDistance?: number;
  inlandAttackMul?: number;
}

export interface FactionRule {
  name: string;
  color: string;
  startUnits: string[];
  mechanic: string;
  weakness: string;
  traits: FactionTraits;
  commander: { name: string; abilities: string[] };
}

export interface CommanderAbilityRule {
  name: string;
  cost: number;
  cooldown: number;
  range?: number;
  radius?: number;
  description: string;
}

export interface EffectRule {
  name: string;
  icon: string;
  source: string;
  duration: string;
  stacking: boolean;
  removal: string;
  description: string;
}

export interface MapPreset {
  width: number;
  height: number;
  players: number;
  neutralCities: number;
  minCapitalDistance: number;
}

export interface Balance {
  version: string;
  map: { chunkSize: number; presets: Record<string, MapPreset> };
  terrain: Record<string, TerrainRule>;
  roadMoveCost: number;
  bridgeMoveCost: number;
  combat: {
    damageScale: number; fortifyDefense: number; cityDefense: number; maxCountersPerTurn: number; minDamage: number;
    coverDefense: number; highGroundAttack: number; suppressedAttack: number; unsuppliedMultiplier: number; siegeVsCity: number;
  };
  classes: Record<string, string>;
  units: Record<string, UnitRule>;
  ranks: { thresholds: number[]; hpBonus: number[]; attackMultiplier: number[] };
  perks: Record<string, { name: string; description: string }>;
  xp: { perCombat: number; perCapture: number; perBuild: number };
  cities: {
    goldPerLevel: number[];
    productionPerLevel: number[];
    knowledgePerLevel: number[];
    growthThresholds: number[];
    baseFood: number;
    maxLevel: number;
    capitalBonusGold: number;
    occupiedIncomeMultiplier: number;
    visionRadius: number;
    neutralGarrison: string;
    materialRadius: number;
    specializeMinLevel: number;
    maxQueue: number;
  };
  buildings: Record<string, BuildingRule>;
  specializations: Record<string, SpecializationRule>;
  supply: { cityRadius: number[]; lowSupplyAfter: number; unsuppliedAfter: number };
  healing: { inSupply: number; inOwnCity: number };
  commander: {
    startPoints: number; pointsPerTurn: number; maxPoints: number; respawnTurns: number; respawnGold: number; auraRadius: number;
    directions: Record<string, { name: string; description: string }>;
    abilities: Record<string, CommanderAbilityRule>;
  };
  materials: (keyof Materials)[];
  economy: { startGold: number; startMaterials: Materials; deficitRecruitBlocked: boolean };
  capture: { holdTurns: number };
  routes: { threatRadius: number; maxLength: number };
  roads: { goldCost: number; builders: string[]; territoryRadius: number };
  forts: { goldCost: number; woodCost: number; defenseMul: number };
  plantForest: { goldCost: number };
  techs: Record<string, TechRule>;
  factions: Record<string, FactionRule>;
  effects: Record<string, EffectRule>;
  turnPresets: Record<string, { planningSeconds: number; mapPreset: string }>;
}

function validate(b: Balance): Balance {
  for (const name of Object.values(TERRAIN_NAMES)) {
    if (!b.terrain[name]) throw new Error(`balance: нет правила местности ${name}`);
  }
  for (const [id, u] of Object.entries(b.units)) {
    if (u.requires && !b.techs[u.requires]) throw new Error(`balance: юнит ${id} требует неизвестную технологию ${u.requires}`);
    if (u.hp <= 0 || u.move <= 0 || u.range <= 0) throw new Error(`balance: некорректные параметры юнита ${id}`);
    if (!b.classes[u.class]) throw new Error(`balance: неизвестный класс ${u.class} у ${id}`);
    if (u.faction && !b.factions[u.faction]) throw new Error(`balance: неизвестный народ ${u.faction} у ${id}`);
  }
  for (const [id, t] of Object.entries(b.techs)) {
    for (const r of t.requires) if (!b.techs[r]) throw new Error(`balance: технология ${id} требует неизвестную ${r}`);
    for (const r of t.excludes ?? []) if (!b.techs[r]) throw new Error(`balance: технология ${id} исключает неизвестную ${r}`);
    for (const u of t.unlocksUnits) if (!b.units[u]) throw new Error(`balance: технология ${id} открывает неизвестный юнит ${u}`);
    for (const x of t.unlocksBuildings) if (!b.buildings[x]) throw new Error(`balance: технология ${id} открывает неизвестную постройку ${x}`);
    if (t.faction && !b.factions[t.faction]) throw new Error(`balance: технология ${id} неизвестного народа`);
  }
  for (const [id, x] of Object.entries(b.buildings)) if (x.requires && !b.techs[x.requires]) throw new Error(`balance: постройка ${id} требует неизвестную ${x.requires}`);
  for (const [id, f] of Object.entries(b.factions)) {
    for (const a of f.commander.abilities) if (!b.commander.abilities[a]) throw new Error(`balance: народ ${id}: неизвестная способность ${a}`);
    for (const u of f.startUnits) if (!b.units[u]) throw new Error(`balance: народ ${id}: неизвестный стартовый юнит ${u}`);
  }
  if (!b.units[b.cities.neutralGarrison]) throw new Error('balance: неизвестный гарнизон нейтральных городов');
  if (!b.units.commander) throw new Error('balance: нет юнита командира');
  return b;
}

export const BALANCE: Balance = validate(raw as unknown as Balance);

export function terrainRule(b: Balance, code: TerrainCode): TerrainRule {
  return b.terrain[TERRAIN_NAMES[code]];
}

export function hasAbility(b: Balance, unitType: string, a: UnitAbility): boolean {
  return b.units[unitType]?.abilities.includes(a) ?? false;
}
