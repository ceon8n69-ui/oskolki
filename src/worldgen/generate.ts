// Генератор мира по seed + автоматическая проверка. Результат полностью воспроизводим.
import type { Balance, MapPreset } from '../shared/balance.ts';
import type { Coord, MapData } from '../shared/types.ts';
import { Feature, Terrain } from '../shared/types.ts';
import { DIRS8, idx, isLandPassable, terrainAt } from '../engine/grid.ts';
import { dijkstra } from '../engine/path.ts';
import { createRng, hash32 } from '../engine/rng.ts';
import { fbm } from './noise.ts';

export const GENERATOR_VERSION = 'worldgen-1.0.0';

export interface WorldSpec extends MapPreset {
  seed: string;
  /** Нейтральное поселение в пределах N ходов пехоты от столицы. */
  neutralWithinTurns?: [number, number];
  /** Первый полезный объект в пределах N ходов разведчика. */
  firstObjectWithinScoutTurns?: number;
  landRatio?: number;
}

export interface GeneratedWorld {
  map: MapData;
  capitals: Coord[];
  neutralCities: Coord[];
  report: GenerationReport;
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface GenerationReport {
  seed: string;
  generatorVersion: string;
  balanceVersion: string;
  attempt: number;
  effectiveSeed: string;
  ok: boolean;
  checks: CheckResult[];
  stats: { land: number; water: number; forest: number; hills: number; mountain: number; components: number; mainComponentSize: number };
  capitalDistances: number[][]; // по реальной стоимости движения
}

const MAX_ATTEMPTS = 12;

export function generateWorld(b: Balance, spec: WorldSpec): GeneratedWorld {
  let last: GeneratedWorld | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const w = generateAttempt(b, spec, attempt);
    if (w.report.ok) return w;
    last = w;
  }
  return last!;
}

function generateAttempt(b: Balance, spec: WorldSpec, attempt: number): GeneratedWorld {
  const effectiveSeed = attempt === 0 ? spec.seed : `${spec.seed}~${attempt}`;
  const s = hash32(effectiveSeed);
  const rng = createRng(s ^ 0x9e3779b9);
  const { width: W, height: H } = spec;
  const n = W * H;
  const terrain = new Uint8Array(n);
  const features = new Uint8Array(n);
  const map: MapData = { width: W, height: H, chunkSize: b.map.chunkSize, seed: spec.seed, generatorVersion: GENERATOR_VERSION, terrain, features };

  // --- рельеф: несколько материков за счёт низкочастотного шума и спада к краям ---
  const contScale = Math.max(12, Math.min(W, H) / 3.2);
  const elev = new Float64Array(n);
  const moist = new Float64Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x / (W - 1)) * 2 - 1;
      const ny = (y / (H - 1)) * 2 - 1;
      const edge = Math.max(Math.abs(nx), Math.abs(ny));
      const falloff = edge > 0.82 ? (edge - 0.82) * 2.6 : 0;
      elev[idx(map, x, y)] = fbm(s, x, y, 5, contScale) * 0.85 + fbm(s + 7, x, y, 3, contScale / 3) * 0.15 - falloff;
      moist[idx(map, x, y)] = fbm(s + 31, x, y, 4, contScale / 1.6);
    }
  }
  const sorted = Float64Array.from(elev).sort();
  const landRatio = spec.landRatio ?? (W <= 48 ? 0.8 : 0.58);
  const sea = sorted[Math.floor(n * (1 - landRatio))];
  const hillsCut = sorted[Math.floor(n * 0.9)];
  const mountCut = sorted[Math.floor(n * 0.965)];
  for (let i = 0; i < n; i++) {
    const e = elev[i];
    if (e < sea) terrain[i] = Terrain.DeepWater;
    else if (e >= mountCut) terrain[i] = Terrain.Mountain;
    else if (e >= hillsCut) terrain[i] = Terrain.Hills;
    else terrain[i] = moist[i] > 0.56 ? Terrain.Forest : Terrain.Plains;
  }
  // Мелководье у берега.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(map, x, y);
    if (terrain[i] !== Terrain.DeepWater) continue;
    for (const [dx, dy] of DIRS8) {
      const ax = x + dx, ay = y + dy;
      if (ax >= 0 && ay >= 0 && ax < W && ay < H && terrain[idx(map, ax, ay)] >= Terrain.Plains) {
        terrain[i] = Terrain.ShallowWater;
        break;
      }
    }
  }

  // --- компоненты суши ---
  const comp = new Int32Array(n).fill(-1);
  const compSizes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1 || !isLandPassable(b, map, i % W, Math.floor(i / W))) continue;
    const id = compSizes.length;
    let size = 0;
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const cx = c % W, cy = (c - cx) / W;
      for (const [dx, dy] of DIRS8) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        const ai = idx(map, ax, ay);
        if (comp[ai] === -1 && isLandPassable(b, map, ax, ay)) {
          comp[ai] = id;
          stack.push(ai);
        }
      }
    }
    compSizes.push(size);
  }
  const main = compSizes.indexOf(Math.max(...compSizes, 0));

  // --- столицы: равнины основной суши, жадный выбор самых удалённых точек ---
  const margin = 2;
  const candidates: Coord[] = [];
  for (let y = margin; y < H - margin; y++) for (let x = margin; x < W - margin; x++) {
    const i = idx(map, x, y);
    if (comp[i] !== main || terrain[i] !== Terrain.Plains) continue;
    let landAround = 0;
    for (const [dx, dy] of DIRS8) if (isLandPassable(b, map, x + dx, y + dy)) landAround++;
    if (landAround >= 7) candidates.push({ x, y });
  }
  // Открытость старта: взвешенная проходимость в радиусе 5 (равнина 1, лес/холмы 0.5).
  // Оставляем только хорошие позиции — так стартовые условия сопоставимы.
  const openness = (c: Coord) => {
    let sc = 0;
    for (let y = c.y - 5; y <= c.y + 5; y++) for (let x = c.x - 5; x <= c.x + 5; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H || comp[idx(map, x, y)] !== main) continue;
      const t = terrain[idx(map, x, y)];
      sc += t === Terrain.Plains ? 1 : t === Terrain.Forest || t === Terrain.Hills ? 0.5 : 0;
    }
    return sc;
  };
  if (candidates.length) {
    const scores = candidates.map(openness);
    const best = Math.max(...scores);
    const keep = candidates.filter((_, i) => scores[i] >= best * 0.72);
    candidates.length = 0;
    candidates.push(...keep);
  }
  const capitals: Coord[] = [];
  if (candidates.length) {
    capitals.push(candidates[Math.floor(rng() * candidates.length)]);
    while (capitals.length < spec.players) {
      let best: Coord | null = null;
      let bestD = -1;
      for (const c of candidates) {
        const d = Math.min(...capitals.map(k => Math.hypot(k.x - c.x, k.y - c.y)));
        // небольшой детерминированный разброс, чтобы карты не были одинаковыми по форме
        const score = d + rng() * 0.5;
        if (score > bestD) {
          bestD = score;
          best = c;
        }
      }
      if (!best || bestD < 2) break;
      capitals.push(best);
    }
  }

  // --- нейтральные города и объекты ---
  const cities: Coord[] = [...capitals];
  const neutralCities: Coord[] = [];
  const canPlaceCity = (c: Coord, minGap: number) =>
    comp[idx(map, c.x, c.y)] === main &&
    terrain[idx(map, c.x, c.y)] !== Terrain.Mountain &&
    cities.every(k => Math.max(Math.abs(k.x - c.x), Math.abs(k.y - c.y)) >= minGap);

  const infMove = b.units.infantry.move;
  const scoutMove = b.units.scout.move;
  const [nMin, nMax] = spec.neutralWithinTurns ?? [2, 6];
  const objMax = spec.firstObjectWithinScoutTurns ?? 2;
  const capCosts = capitals.map(c => dijkstra(b, map, c).cost);

  // Гарантированное поселение возле каждой столицы.
  capitals.forEach((cap, ci) => {
    const cost = capCosts[ci];
    const opts: Coord[] = [];
    for (let i = 0; i < n; i++) {
      if (cost[i] >= nMin * infMove && cost[i] <= nMax * infMove) {
        const c = { x: i % W, y: Math.floor(i / W) };
        if (canPlaceCity(c, 4) && closestCapital(capCosts, i) === ci) opts.push(c);
      }
    }
    if (opts.length) {
      const c = opts[Math.floor(rng() * opts.length)];
      cities.push(c);
      neutralCities.push(c);
    }
  });
  // Остальные поселения — равномерно по суше.
  let tries = 0;
  while (neutralCities.length < spec.neutralCities && tries++ < spec.neutralCities * 60) {
    const c = { x: margin + Math.floor(rng() * (W - 2 * margin)), y: margin + Math.floor(rng() * (H - 2 * margin)) };
    if (canPlaceCity(c, 5)) {
      cities.push(c);
      neutralCities.push(c);
    }
  }
  for (const c of cities) if (terrain[idx(map, c.x, c.y)] !== Terrain.Plains) terrain[idx(map, c.x, c.y)] = Terrain.Plains;

  // Ресурсы, руины, святилища.
  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    const r = rng();
    if (t === Terrain.Forest && r < 0.08) features[i] |= Feature.ResourceWood;
    else if (t === Terrain.Hills && r < 0.12) features[i] |= Feature.ResourceIron;
    else if (t === Terrain.Plains && r < 0.012) features[i] |= Feature.Ruins;
    else if (t === Terrain.Plains && r > 0.996) features[i] |= Feature.Shrine;
    else if (t === Terrain.Mountain && r < 0.05) features[i] |= Feature.ResourceCrystal;
  }
  // Гарантированный полезный объект в пределах двух ходов разведчика.
  capitals.forEach((cap, ci) => {
    const cost = capCosts[ci];
    const limit = objMax * scoutMove;
    const useful = Feature.ResourceWood | Feature.ResourceIron | Feature.Ruins | Feature.Shrine | Feature.ResourceCrystal;
    let has = false;
    const spots: number[] = [];
    for (let i = 0; i < n; i++) {
      if (cost[i] > 0 && cost[i] <= limit) {
        if (features[i] & useful) has = true;
        if (terrain[i] === Terrain.Plains && !cities.some(c => idx(map, c.x, c.y) === i)) spots.push(i);
      }
    }
    if (!has && spots.length) features[spots[Math.floor(rng() * spots.length)]] |= Feature.Ruins;
    void cap;
  });

  const report = validateWorld(b, map, capitals, neutralCities, spec, { comp, compSizes, main, effectiveSeed, attempt });
  return { map, capitals, neutralCities, report };
}

function closestCapital(capCosts: Float64Array[], i: number): number {
  let best = -1;
  let bestC = Infinity;
  capCosts.forEach((c, k) => {
    if (c[i] < bestC) {
      bestC = c[i];
      best = k;
    }
  });
  return best;
}

export function validateWorld(
  b: Balance,
  map: MapData,
  capitals: Coord[],
  neutralCities: Coord[],
  spec: WorldSpec,
  ctx: { comp: Int32Array; compSizes: number[]; main: number; effectiveSeed: string; attempt: number },
): GenerationReport {
  const checks: CheckResult[] = [];
  const n = map.width * map.height;
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  add('capital_count', capitals.length === spec.players, `${capitals.length}/${spec.players}`);
  const costs = capitals.map(c => dijkstra(b, map, c).cost);
  const capDist = capitals.map((_, a) => capitals.map((c, k) => (a === k ? 0 : Math.round(costs[a][idx(map, c.x, c.y)]))));

  // Стартовые позиции доступны и не заперты.
  capitals.forEach((c, i) => {
    let open = 0;
    for (let j = 0; j < n; j++) if (costs[i][j] > 0 && costs[i][j] <= 6) open++;
    add(`capital_${i}_exit`, open >= 12, `клеток в радиусе 6 ОД: ${open}`);
  });
  // Все столицы достижимы друг из друга и на достаточном расстоянии.
  let minD = Infinity;
  let allReach = true;
  for (let a = 0; a < capitals.length; a++) for (let k = a + 1; k < capitals.length; k++) {
    const d = capDist[a][k];
    if (!Number.isFinite(d)) allReach = false;
    minD = Math.min(minD, d);
  }
  add('capitals_mutually_reachable', allReach, allReach ? 'да' : 'есть недостижимые столицы');
  add('capital_min_distance', capitals.length < 2 || minD >= spec.minCapitalDistance, `минимум ${minD} ОД, требуется ${spec.minCapitalDistance}`);
  // Нейтральные поселения достижимы.
  const unreachable = neutralCities.filter(c => !costs.some(cs => Number.isFinite(cs[idx(map, c.x, c.y)])));
  add('neutral_cities_reachable', unreachable.length === 0, `${neutralCities.length - unreachable.length}/${neutralCities.length}`);
  // Поселение в пределах заданного числа ходов пехоты.
  const [nMin, nMax] = spec.neutralWithinTurns ?? [2, 6];
  const infMove = b.units.infantry.move;
  capitals.forEach((cap, i) => {
    const best = Math.min(...neutralCities.map(c => costs[i][idx(map, c.x, c.y)]));
    add(`capital_${i}_neutral_nearby`, best <= nMax * infMove, `ближайшее поселение: ${Number.isFinite(best) ? Math.ceil(best / infMove) : '∞'} ход(ов) пехоты (цель ${nMin}–${nMax})`);
    void cap;
  });
  // Полезный объект в пределах двух ходов разведчика.
  const useful = Feature.ResourceWood | Feature.ResourceIron | Feature.Ruins | Feature.Shrine | Feature.ResourceCrystal;
  const scoutLimit = (spec.firstObjectWithinScoutTurns ?? 2) * b.units.scout.move;
  capitals.forEach((_, i) => {
    let found = false;
    for (let j = 0; j < n && !found; j++) if (costs[i][j] > 0 && costs[i][j] <= scoutLimit && map.features[j] & useful) found = true;
    add(`capital_${i}_first_object`, found, found ? 'есть' : 'нет объекта в 2 ходах разведчика');
  });
  // Сопоставимый доступ к стартовым ресурсам: суша в радиусе 3 ходов пехоты.
  const access = capitals.map((_, i) => {
    let c = 0;
    for (let j = 0; j < n; j++) if (costs[i][j] > 0 && costs[i][j] <= 3 * infMove) c++;
    return c;
  });
  if (access.length > 1) {
    const ratio = Math.min(...access) / Math.max(...access);
    add('start_fairness', ratio >= 0.6, `доступная суша ${access.join('/')} (мин/макс = ${ratio.toFixed(2)})`);
  }
  // Замкнутые области: доля суши вне основного материка (острова допустимы — для флота).
  const land = ctx.compSizes.reduce((a, x) => a + x, 0);
  const mainSize = ctx.compSizes[ctx.main] ?? 0;
  add('main_landmass', land === 0 ? false : mainSize / land >= 0.5, `основная суша ${mainSize}/${land}`);
  // Столицы на одной суше (до появления флота).
  const sameLand = capitals.every(c => ctx.comp[idx(map, c.x, c.y)] === ctx.main);
  add('capitals_on_main_landmass', sameLand, sameLand ? 'да' : 'нет');

  let water = 0, forest = 0, hills = 0, mountain = 0;
  for (let i = 0; i < n; i++) {
    const t = terrainAt(map, i % map.width, Math.floor(i / map.width));
    if (t <= Terrain.ShallowWater) water++;
    else if (t === Terrain.Forest) forest++;
    else if (t === Terrain.Hills) hills++;
    else if (t === Terrain.Mountain) mountain++;
  }
  return {
    seed: spec.seed,
    generatorVersion: GENERATOR_VERSION,
    balanceVersion: b.version,
    attempt: ctx.attempt,
    effectiveSeed: ctx.effectiveSeed,
    ok: checks.every(c => c.ok),
    checks,
    stats: { land: n - water, water, forest, hills, mountain, components: ctx.compSizes.length, mainComponentSize: mainSize },
    capitalDistances: capDist,
  };
}

/** ASCII-просмотр карты для административной проверки. */
export function asciiMap(map: MapData, capitals: Coord[], neutralCities: Coord[]): string {
  const ch = ['~', '-', '.', 'f', 'h', '^'];
  const lines: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let line = '';
    for (let x = 0; x < map.width; x++) {
      const ci = capitals.findIndex(c => c.x === x && c.y === y);
      if (ci >= 0) line += String.fromCharCode(65 + (ci % 26));
      else if (neutralCities.some(c => c.x === x && c.y === y)) line += 'o';
      else if (map.features[idx(map, x, y)] & (Feature.Ruins | Feature.Shrine)) line += '*';
      else line += ch[map.terrain[idx(map, x, y)]];
    }
    lines.push(line);
  }
  return lines.join('\n');
}
