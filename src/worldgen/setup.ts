// Создание начального состояния партии из сгенерированного мира.
import type { Balance } from '../shared/balance.ts';
import type { CityState, GameState, PlayerState, UnitState } from '../shared/types.ts';
import { NEUTRAL } from '../shared/types.ts';
import { DIRS8, isLandPassable } from '../engine/grid.ts';
import { RULES_VERSION } from '../engine/resolve.ts';
import { computeAllVision, updateExploredAndIntel } from '../engine/vision.ts';
import type { GeneratedWorld, WorldSpec } from './generate.ts';
import { generateWorld } from './generate.ts';

const NAME_A = ['Лазур', 'Серебр', 'Камен', 'Сосн', 'Туман', 'Янтар', 'Медв', 'Ясн', 'Бел', 'Зелен', 'Сокол', 'Вереск', 'Ольх', 'Гран', 'Тих', 'Студен'];
const NAME_B = ['град', 'мост', 'бор', 'дол', 'гор', 'поле', 'ец', 'ица', 'ово', 'ск', 'холм', 'брод'];
const COLORS = ['#3568aa', '#c0463a', '#3e8a4e', '#c7902c', '#7a4fa0', '#2a9a9a', '#b24f86', '#6b6f2a'];

export interface SetupPlayer {
  id: string;
  name: string;
  faction: string;
  isBot: boolean;
}

export function cityName(i: number, seedNum: number): string {
  const a = NAME_A[(i * 7 + seedNum) % NAME_A.length];
  const b = NAME_B[(i * 5 + (seedNum >>> 3)) % NAME_B.length];
  return a + b;
}

export function createInitialState(
  b: Balance,
  opts: { matchId: string; spec: WorldSpec; players: SetupPlayer[]; world?: GeneratedWorld },
): { state: GameState; world: GeneratedWorld } {
  const world = opts.world ?? generateWorld(b, opts.spec);
  if (world.capitals.length < opts.players.length) throw new Error('генератор не разместил достаточно столиц');
  const seedNum = world.map.seed.length * 31 + world.map.seed.charCodeAt(0);

  const players: PlayerState[] = opts.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    faction: p.faction,
    color: b.factions[p.faction]?.color && i === 0 ? b.factions[p.faction].color : COLORS[i % COLORS.length],
    gold: b.economy.startGold,
    knowledge: 0,
    researched: [],
    researchQueue: [],
    researchProgress: 0,
    isBot: p.isBot,
    eliminated: false,
  }));

  const cities: CityState[] = [];
  const units: UnitState[] = [];
  let unitSeq = 1;
  const newUnit = (owner: string, type: string, x: number, y: number): UnitState => ({
    id: `u${unitSeq++}`, owner, type, x, y, hp: b.units[type].hp, xp: 0, rank: 0, statuses: [], countersUsed: 0, createdTurn: 1,
  });

  players.forEach((p, i) => {
    const c = world.capitals[i];
    cities.push({ id: `c${cities.length + 1}`, name: cityName(cities.length, seedNum), owner: p.id, x: c.x, y: c.y, level: 2, isCapital: true, contestedBy: null, contestedSinceTurn: null, productionStock: 0, queue: [] });
    const start = b.factions[p.faction]?.startUnits ?? ['infantry'];
    const spots = [{ x: c.x, y: c.y }, ...DIRS8.map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy }))].filter(s => isLandPassable(b, world.map, s.x, s.y));
    start.forEach((type, k) => {
      const s = spots[k];
      if (s) units.push(newUnit(p.id, type, s.x, s.y));
    });
  });
  // Свободные столичные позиции (если игроков меньше) становятся нейтральными городами.
  const neutral = [...world.capitals.slice(players.length), ...world.neutralCities];
  for (const c of neutral) {
    cities.push({ id: `c${cities.length + 1}`, name: cityName(cities.length, seedNum), owner: null, x: c.x, y: c.y, level: 1, isCapital: false, contestedBy: null, contestedSinceTurn: null, productionStock: 0, queue: [] });
    units.push(newUnit(NEUTRAL, b.cities.neutralGarrison, c.x, c.y));
  }

  const state: GameState = {
    matchId: opts.matchId,
    turn: 1,
    balanceVersion: b.version,
    rulesVersion: RULES_VERSION,
    map: world.map,
    players,
    units,
    cities,
    explored: {},
    intel: {},
    nextIds: { unit: unitSeq },
  };
  updateExploredAndIntel(b, state, computeAllVision(b, state));
  return { state, world };
}
