// Создание объектов состояния с полным набором полей. Используется правилами, генератором, тестами и инструментами.
import type { Balance } from '../shared/balance.ts';
import type { CityState, GameState, PlayerState, UnitState } from '../shared/types.ts';
import { baseMaxHp } from './stats.ts';

export function newUnit(
  b: Balance,
  state: GameState,
  u: { id: string; owner: string; type: string; x: number; y: number; createdTurn?: number; xp?: number },
): UnitState {
  const maxHp = baseMaxHp(b, state, u.owner, u.type, 0);
  return {
    id: u.id, owner: u.owner, type: u.type, x: u.x, y: u.y, hp: maxHp, maxHp, xp: u.xp ?? 0, rank: 0, statuses: [],
    countersUsed: 0, createdTurn: u.createdTurn ?? state.turn, route: null, perks: [], pendingPerks: 0, supplyOut: 0,
  };
}

export function newCity(c: Partial<CityState> & Pick<CityState, 'id' | 'name' | 'x' | 'y'>): CityState {
  return {
    owner: null, level: 1, isCapital: false, contestedBy: null, contestedSinceTurn: null, productionStock: 0, queue: [],
    buildings: [], food: 0, specialization: null, ...c,
  };
}

export function newPlayer(b: Balance, p: Pick<PlayerState, 'id' | 'name' | 'faction' | 'color' | 'isBot'>): PlayerState {
  return {
    ...p,
    gold: b.economy.startGold,
    knowledge: 0,
    researched: [...(b.factions[p.faction]?.startTechs ?? [])],
    researchQueue: [],
    researchProgress: 0,
    eliminated: false,
    materials: { ...b.economy.startMaterials },
    commander: {
      unitId: null,
      points: b.commander.startPoints,
      cooldowns: {},
      directions: Object.fromEntries(Object.keys(b.commander.directions).map(d => [d, 0])),
      pendingChoices: 1,
      respawnTurn: null,
    },
  };
}
