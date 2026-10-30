// Создание начального состояния партии из сгенерированного мира.
import type { Balance } from '../shared/balance.ts';
import type { GameState, MatchMode, PlayerState } from '../shared/types.ts';
import { Feature } from '../shared/types.ts';
import { defaultMode, pickObjectives } from '../engine/diplomacy.ts';
import { createRng, hash32 } from '../engine/rng.ts';
import { NEUTRAL } from '../shared/types.ts';
import { DIRS8, isLandPassable } from '../engine/grid.ts';
import { RULES_VERSION } from '../engine/resolve.ts';
import { computeAllVision, updateExploredAndIntel } from '../engine/vision.ts';
import { newCity, newPlayer, newUnit } from '../engine/factory.ts';
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
  opts: { matchId: string; spec: WorldSpec; players: SetupPlayer[]; world?: GeneratedWorld; mode?: { victory: MatchMode['victory']; turnLimit: number | null; alliances: boolean } },
): { state: GameState; world: GeneratedWorld } {
  const world = opts.world ?? generateWorld(b, opts.spec);
  if (world.capitals.length < opts.players.length) throw new Error('генератор не разместил достаточно столиц');
  const seedNum = world.map.seed.length * 31 + world.map.seed.charCodeAt(0);

  const players: PlayerState[] = opts.players.map((p, i) => {
    const faction = b.factions[p.faction] ? p.faction : 'union';
    // Цвет народа у первого игрока этого народа, остальным — из палитры.
    const firstOfFaction = opts.players.findIndex(q => q.faction === faction) === i;
    return newPlayer(b, { id: p.id, name: p.name, faction, isBot: p.isBot, color: firstOfFaction ? b.factions[faction].color : COLORS[i % COLORS.length] });
  });
  const state: GameState = {
    matchId: opts.matchId,
    turn: 1,
    balanceVersion: b.version,
    rulesVersion: RULES_VERSION,
    map: world.map,
    players,
    units: [],
    cities: [],
    explored: {},
    intel: {},
    nextIds: { unit: 1 },
    diplomacy: [],
    mode: { ...defaultMode(), ...(opts.mode ?? {}) },
  };
  const { cities, units } = state;
  const spawn = (owner: string, type: string, x: number, y: number) => {
    const u = newUnit(b, state, { id: `u${state.nextIds.unit++}`, owner, type, x, y, createdTurn: 1 });
    units.push(u);
    return u;
  };

  players.forEach((p, i) => {
    const c = world.capitals[i];
    cities.push(newCity({ id: `c${cities.length + 1}`, name: cityName(cities.length, seedNum), owner: p.id, x: c.x, y: c.y, level: 2, isCapital: true }));
    const start = [...b.factions[p.faction].startUnits, 'commander'];
    const spots = [{ x: c.x, y: c.y }, ...DIRS8.map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy }))].filter(s => isLandPassable(b, world.map, s.x, s.y));
    start.forEach((type, k) => {
      const s = spots[k];
      if (!s) return;
      const u = spawn(p.id, type, s.x, s.y);
      if (type === 'commander') p.commander.unitId = u.id;
    });
  });
  // Свободные столичные позиции (если игроков меньше) становятся нейтральными городами.
  const neutral = [...world.capitals.slice(players.length), ...world.neutralCities];
  for (const c of neutral) {
    cities.push(newCity({ id: `c${cities.length + 1}`, name: cityName(cities.length, seedNum), owner: null, x: c.x, y: c.y, level: 1 }));
    spawn(NEUTRAL, b.cities.neutralGarrison, c.x, c.y);
  }

  // Цели влияния объявляются при старте и видны всем.
  if (state.mode.victory === 'influence') {
    const shrines: { x: number; y: number }[] = [];
    for (let i = 0; i < world.map.features.length; i++) if (world.map.features[i] & Feature.Shrine) shrines.push({ x: i % world.map.width, y: Math.floor(i / world.map.width) });
    const rng = createRng(hash32(`${world.map.seed}#objectives`));
    state.mode.objectives = pickObjectives(b, state, shrines, n => Math.floor(rng() * n));
  }
  for (const p of players) state.mode.scores[p.id] = 0;
  updateExploredAndIntel(b, state, computeAllVision(b, state));
  return { state, world };
}
