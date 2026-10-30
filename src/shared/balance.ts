import raw from '../../config/balance.v1.json' with { type: 'json' };
import type { TerrainCode } from './types.ts';
import { TERRAIN_NAMES } from './types.ts';

export interface TerrainRule {
  moveCost: number | null; // null — непроходимо для сухопутных
  defense: number;
  visionBonus: number;
  hidesUnits: boolean;
}

export interface UnitRule {
  name: string;
  hp: number;
  attack: number;
  defense: number;
  move: number;
  range: number;
  vision: number;
  initiative: number;
  cost: { gold: number; production: number };
  upkeep: number;
  requires: string | null;
  xpOnKill: number;
  bonusVs?: Record<string, number>;
}

export interface TechRule {
  name: string;
  cost: number;
  requires: string[];
  unlocksUnits: string[];
  modifiers: { attackBonus?: number; cityDefenseBonus?: number };
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
  combat: { damageScale: number; fortifyDefense: number; cityDefense: number; maxCountersPerTurn: number; minDamage: number };
  units: Record<string, UnitRule>;
  ranks: { thresholds: number[]; hpBonus: number[]; attackMultiplier: number[] };
  xp: { perCombat: number; perCapture: number };
  cities: {
    goldPerLevel: number[];
    productionPerLevel: number[];
    knowledgePerLevel: number[];
    capitalBonusGold: number;
    occupiedIncomeMultiplier: number;
    visionRadius: number;
    neutralGarrison: string;
  };
  economy: { startGold: number; deficitRecruitBlocked: boolean };
  capture: { holdTurns: number };
  techs: Record<string, TechRule>;
  factions: Record<string, { name: string; color: string; startUnits: string[] }>;
  turnPresets: Record<string, { planningSeconds: number; mapPreset: string }>;
}

function validate(b: Balance): Balance {
  for (const name of Object.values(TERRAIN_NAMES)) {
    if (!b.terrain[name]) throw new Error(`balance: нет правила местности ${name}`);
  }
  for (const [id, u] of Object.entries(b.units)) {
    if (u.requires && !b.techs[u.requires]) throw new Error(`balance: юнит ${id} требует неизвестную технологию ${u.requires}`);
    if (u.hp <= 0 || u.move <= 0 || u.range <= 0) throw new Error(`balance: некорректные параметры юнита ${id}`);
  }
  for (const [id, t] of Object.entries(b.techs)) {
    for (const r of t.requires) if (!b.techs[r]) throw new Error(`balance: технология ${id} требует неизвестную ${r}`);
    for (const u of t.unlocksUnits) if (!b.units[u]) throw new Error(`balance: технология ${id} открывает неизвестный юнит ${u}`);
  }
  if (!b.units[b.cities.neutralGarrison]) throw new Error('balance: неизвестный гарнизон нейтральных городов');
  return b;
}

export const BALANCE: Balance = validate(raw as Balance);

export function terrainRule(b: Balance, code: TerrainCode): TerrainRule {
  return b.terrain[TERRAIN_NAMES[code]];
}
