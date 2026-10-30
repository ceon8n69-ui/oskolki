import type { Balance } from '../shared/balance.ts';
import type { Coord, MapData } from '../shared/types.ts';
import { DIRS8, idx, inBounds, isAdjacent, landMoveCost } from './grid.ts';
import type { TerrainOverrides } from './grid.ts';

export interface PathOptions {
  /** Бюджет очков движения. undefined — без ограничения (долгие маршруты). */
  budget?: number;
  /** Клетки, на которые нельзя вставать и через которые нельзя проходить (индексы карты). */
  blocked?: Set<number>;
  /** Клетки, через которые можно пройти, но нельзя закончить путь. */
  noStop?: Set<number>;
  /** Клетки, на которые можно войти, но дальше идти нельзя (зона контроля противника). */
  stopTiles?: Set<number>;
  /** Особые стоимости местности для отряда. */
  profile?: TerrainOverrides;
}

/** Минимальная бинарная куча по приоритету. */
class Heap {
  private items: { p: number; v: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(v: number, p: number): void {
    const a = this.items;
    a.push({ p, v });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].p <= a[i].p) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].p < a[m].p) m = l;
        if (r < a.length && a[r].p < a[m].p) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.v;
  }
}

/**
 * Дейкстра от клетки. Возвращает стоимость достижения каждой клетки (Infinity — недостижимо)
 * и массив предков для восстановления пути. Порядок соседей фиксирован — результат детерминирован.
 */
export function dijkstra(b: Balance, map: MapData, start: Coord, opts: PathOptions = {}) {
  const n = map.width * map.height;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const s = idx(map, start.x, start.y);
  cost[s] = 0;
  const heap = new Heap();
  heap.push(s, 0);
  const budget = opts.budget ?? Infinity;
  while (heap.size) {
    const cur = heap.pop();
    const cx = cur % map.width;
    const cy = (cur - cx) / map.width;
    const c = cost[cur];
    if (cur !== s && opts.stopTiles?.has(cur)) continue;
    for (const [dx, dy] of DIRS8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(map, nx, ny)) continue;
      const ni = idx(map, nx, ny);
      if (opts.blocked?.has(ni)) continue;
      const step = landMoveCost(b, map, { x: cx, y: cy }, { x: nx, y: ny }, opts.profile);
      if (step === null) continue;
      const nc = c + step;
      if (nc > budget + 1e-9) continue;
      // Небольшой детерминированный приоритет прямых шагов над диагональными при равной стоимости.
      if (nc < cost[ni] - 1e-9) {
        cost[ni] = nc;
        prev[ni] = cur;
        heap.push(ni, nc + (dx !== 0 && dy !== 0 ? 1e-6 : 0));
      }
    }
  }
  return { cost, prev };
}

export function reconstruct(map: MapData, prev: Int32Array, target: Coord): Coord[] | null {
  const steps: Coord[] = [];
  let cur = idx(map, target.x, target.y);
  if (prev[cur] === -1) return null;
  while (cur !== -1) {
    const x = cur % map.width;
    steps.push({ x, y: (cur - x) / map.width });
    cur = prev[cur];
  }
  steps.reverse();
  steps.shift(); // без стартовой клетки
  return steps;
}

export function findPath(b: Balance, map: MapData, from: Coord, to: Coord, opts: PathOptions = {}): Coord[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  const { cost, prev } = dijkstra(b, map, from, opts);
  const ti = idx(map, to.x, to.y);
  if (!Number.isFinite(cost[ti])) return null;
  if (opts.noStop?.has(ti)) return null;
  return reconstruct(map, prev, to);
}

/** Клетки, достижимые за бюджет (для подсветки доступного перемещения). */
export function reachable(b: Balance, map: MapData, from: Coord, budget: number, blocked?: Set<number>, extra: Omit<PathOptions, 'budget' | 'blocked'> = {}): Map<number, number> {
  const { cost } = dijkstra(b, map, from, { budget, blocked, ...extra });
  const out = new Map<number, number>();
  for (let i = 0; i < cost.length; i++) if (Number.isFinite(cost[i]) && cost[i] > 0) out.set(i, cost[i]);
  return out;
}

/** Проверка пути, присланного клиентом: шаги смежные, клетки проходимы, стоимость в бюджете. */
export function pathCost(b: Balance, map: MapData, from: Coord, steps: Coord[], profile?: TerrainOverrides): { ok: true; cost: number } | { ok: false; reason: string } {
  let total = 0;
  let cur = from;
  for (const s of steps) {
    if (!Number.isInteger(s.x) || !Number.isInteger(s.y)) return { ok: false, reason: 'bad_coord' };
    if (!isAdjacent(cur, s)) return { ok: false, reason: 'path_not_contiguous' };
    const c = landMoveCost(b, map, cur, s, profile);
    if (c === null) return { ok: false, reason: 'impassable' };
    total += c;
    cur = s;
  }
  return { ok: true, cost: total };
}
