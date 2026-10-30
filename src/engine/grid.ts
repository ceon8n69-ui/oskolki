import type { Balance } from '../shared/balance.ts';
import { terrainRule } from '../shared/balance.ts';
import type { Coord, MapData, TerrainCode } from '../shared/types.ts';
import { Feature, Terrain } from '../shared/types.ts';

export const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export function idx(map: MapData, x: number, y: number): number {
  return y * map.width + x;
}

export function inBounds(map: MapData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function terrainAt(map: MapData, x: number, y: number): TerrainCode {
  return map.terrain[idx(map, x, y)] as TerrainCode;
}

export function featuresAt(map: MapData, x: number, y: number): number {
  return map.features[idx(map, x, y)];
}

/** Расстояние Чебышёва: карта квадратная, ход и дальность — по 8 направлениям. */
export function dist(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function isAdjacent(a: Coord, b: Coord): boolean {
  return dist(a, b) === 1;
}

export function sameTile(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function key(c: Coord): string {
  return `${c.x},${c.y}`;
}

/** Особые стоимости клеток для отряда (см. stats.moveProfile). */
export interface TerrainOverrides {
  forest?: number;
  hills?: number;
  mountain?: number;
  shallow?: number;
  deep?: number;
}

function baseCost(b: Balance, t: TerrainCode, pr?: TerrainOverrides): number | null {
  if (pr) {
    if (t === Terrain.Forest && pr.forest !== undefined) return pr.forest;
    if (t === Terrain.Hills && pr.hills !== undefined) return pr.hills;
    if (t === Terrain.Mountain && pr.mountain !== undefined) return pr.mountain;
    if (t === Terrain.ShallowWater && pr.shallow !== undefined) return pr.shallow;
    if (t === Terrain.DeepWater && pr.deep !== undefined) return pr.deep;
  }
  return terrainRule(b, t).moveCost;
}

/**
 * Стоимость входа отряда на клетку. null — непроходимо.
 * Дорога действует, только если дорога есть и на исходной, и на целевой клетке.
 */
export function landMoveCost(b: Balance, map: MapData, from: Coord, to: Coord, pr?: TerrainOverrides): number | null {
  if (!inBounds(map, to.x, to.y)) return null;
  const f = featuresAt(map, to.x, to.y);
  if (f & Feature.Bridge) return b.bridgeMoveCost;
  const base = baseCost(b, terrainAt(map, to.x, to.y), pr);
  if (base === null) return null;
  if (f & Feature.Road && featuresAt(map, from.x, from.y) & (Feature.Road | Feature.Bridge)) {
    return Math.min(base, b.roadMoveCost);
  }
  return base;
}

export function isLandPassable(b: Balance, map: MapData, x: number, y: number, pr?: TerrainOverrides): boolean {
  if (!inBounds(map, x, y)) return false;
  if (featuresAt(map, x, y) & Feature.Bridge) return true;
  return baseCost(b, terrainAt(map, x, y), pr) !== null;
}
