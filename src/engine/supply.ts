// Зона снабжения: города (по уровню), склады снабжения, технологии, командир-логист, тракты Союза.
import type { Balance } from '../shared/balance.ts';
import type { GameState, PlayerId } from '../shared/types.ts';
import { Feature } from '../shared/types.ts';
import { dist, idx, inBounds } from './grid.ts';
import { commanderUnit, playerOf, techs } from './stats.ts';

function stamp(grid: Uint8Array, state: GameState, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (inBounds(state.map, x, y)) grid[idx(state.map, x, y)] = 1;
}

export function cityBuildingEffect(b: Balance, city: { buildings: string[] }, key: keyof Balance['buildings'][string]['effects']): number {
  let s = 0;
  for (const id of city.buildings) s += b.buildings[id]?.effects[key] ?? 0;
  return s;
}

export function supplyRadiusOfCity(b: Balance, state: GameState, c: GameState['cities'][number]): number {
  return (b.supply.cityRadius[c.level] ?? 3) + cityBuildingEffect(b, c, 'supplyRadius') + techs(b, state, c.owner ?? '').supplyRadius;
}

/** 1 — клетка в зоне снабжения игрока. */
export function computeSupply(b: Balance, state: GameState, playerId: PlayerId): Uint8Array {
  const grid = new Uint8Array(state.map.width * state.map.height);
  const own = state.cities.filter(c => c.owner === playerId && !c.contestedBy);
  for (const c of own) stamp(grid, state, c.x, c.y, supplyRadiusOfCity(b, state, c));
  const p = playerOf(state, playerId);
  const lvl = p?.commander?.directions?.logistics ?? 0;
  const cmd = commanderUnit(state, playerId);
  if (cmd && lvl > 0) stamp(grid, state, cmd.x, cmd.y, 2 + lvl);
  // «Имперские тракты»: дороги в пределах 8 клеток от своего города тоже снабжаются.
  if (techs(b, state, playerId).roadSupply) {
    for (let i = 0; i < grid.length; i++) {
      if (!(state.map.features[i] & Feature.Road)) continue;
      const x = i % state.map.width, y = Math.floor(i / state.map.width);
      if (own.some(c => dist(c, { x, y }) <= 8)) grid[i] = 1;
    }
  }
  return grid;
}
