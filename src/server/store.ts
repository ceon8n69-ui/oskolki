// Загрузка и сохранение GameState в PostgreSQL.
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { GameState, MapData, PlayerIntel, PlayerState, UnitState, CityState } from '../shared/types.ts';
import type { Tx, Db } from './db/pool.ts';
import { canonicalize, stableStringify } from '../engine/canonical.ts';

type Q = Tx | Db;

// ---------- Сериализация ----------

/** Байт-на-клетку → битовая маска (8 клеток в байте). */
export function packBits(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(a.length / 8));
  for (let i = 0; i < a.length; i++) if (a[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}
export function unpackBits(bits: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bits[i >> 3] >> (i & 7)) & 1;
  return out;
}
/** Прочитать исследованные клетки в любом из форматов (байты или биты). */
export function readExplored(buf: Uint8Array, n: number): Uint8Array {
  return buf.length === n ? new Uint8Array(buf) : unpackBits(buf, n);
}
const z = (a: Uint8Array) => deflateRawSync(a).toString('base64');
const unz = (s: string) => new Uint8Array(inflateRawSync(Buffer.from(s, 'base64')));

export function b64(a: Uint8Array): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}
export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * Снимок состояния (turns.snapshot). Рельеф статичен и лежит в chunks; изменяемые особенности клеток
 * (дороги) и исследованные клетки хранятся сжатыми: битовая маска + deflate.
 */
export function stateToJson(state: GameState): Record<string, unknown> {
  const { map, explored, ...rest } = state;
  return {
    ...rest,
    map: { width: map.width, height: map.height, chunkSize: map.chunkSize, seed: map.seed, generatorVersion: map.generatorVersion, featuresZ: z(map.features) },
    exploredZ: Object.fromEntries(Object.entries(explored).map(([k, v]) => [k, z(packBits(v))])),
  };
}

export function stateFromJson(json: any, baseMap: MapData): GameState {
  const n = baseMap.width * baseMap.height;
  const { exploredZ, explored: oldExplored, map: m, ...rest } = json;
  const map: MapData = { ...baseMap, features: m?.featuresZ ? unz(m.featuresZ) : new Uint8Array(baseMap.features) };
  const explored: Record<string, Uint8Array> = exploredZ
    ? Object.fromEntries(Object.entries(exploredZ as Record<string, string>).map(([k, v]) => [k, unpackBits(unz(v), n)]))
    : Object.fromEntries(Object.entries(oldExplored as Record<string, string>).map(([k, v]) => [k, fromB64(v)]));
  return { ...rest, map, explored } as GameState;
}

/** Хэш состояния для проверки воспроизводимости расчёта. */
export function stateHash(state: GameState): string {
  return createHash('sha256').update(stableStringify(stateToJson(canonicalize(structuredClone(state))))).digest('hex');
}

// ---------- Карта (статичная, кешируется) ----------

const mapCache = new Map<string, MapData>();
const MAP_CACHE_LIMIT = 64;

export async function saveMap(q: Q, matchId: string, map: MapData): Promise<void> {
  const cs = map.chunkSize;
  const cxs: number[] = [], cys: number[] = [], ts: Buffer[] = [], fs: Buffer[] = [];
  for (let cy = 0; cy < Math.ceil(map.height / cs); cy++) {
    for (let cx = 0; cx < Math.ceil(map.width / cs); cx++) {
      const t: number[] = [];
      const f: number[] = [];
      for (let y = cy * cs; y < Math.min(map.height, (cy + 1) * cs); y++) {
        for (let x = cx * cs; x < Math.min(map.width, (cx + 1) * cs); x++) {
          t.push(map.terrain[y * map.width + x]);
          f.push(map.features[y * map.width + x]);
        }
      }
      cxs.push(cx); cys.push(cy); ts.push(Buffer.from(t)); fs.push(Buffer.from(f));
    }
  }
  // Одним запросом: для 256×256 это 256 чанков.
  await q.query(
    'INSERT INTO chunks (match_id, cx, cy, terrain, features) SELECT $1, * FROM unnest($2::int[], $3::int[], $4::bytea[], $5::bytea[])',
    [matchId, cxs, cys, ts, fs],
  );
  cacheMap(matchId, map);
}

/** Изменённые клетки (дороги) — в таблицу tiles поверх сгенерированных чанков. */
export async function saveTileChanges(tx: Tx, matchId: string, map: MapData, coords: { x: number; y: number }[], turn: number): Promise<void> {
  for (const c of coords) {
    const i = c.y * map.width + c.x;
    await tx.query(
      `INSERT INTO tiles (match_id, x, y, terrain, features, changed_turn) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (match_id, x, y) DO UPDATE SET terrain=EXCLUDED.terrain, features=EXCLUDED.features, changed_turn=EXCLUDED.changed_turn`,
      [matchId, c.x, c.y, map.terrain[i], map.features[i], turn],
    );
  }
}

/** Обновить кеш карты после фиксации транзакции. */
export function setCachedMap(id: string, map: MapData): void {
  cacheMap(id, map);
}

function cacheMap(id: string, map: MapData): void {
  if (mapCache.size >= MAP_CACHE_LIMIT) mapCache.delete(mapCache.keys().next().value!);
  mapCache.set(id, map);
}

export async function loadMap(q: Q, matchId: string, m: { map_width: number; map_height: number; chunk_size: number; seed: string; generator_version: string }): Promise<MapData> {
  const cached = mapCache.get(matchId);
  if (cached) return cached;
  const W = m.map_width;
  const map: MapData = {
    width: W, height: m.map_height, chunkSize: m.chunk_size, seed: m.seed, generatorVersion: m.generator_version,
    terrain: new Uint8Array(W * m.map_height), features: new Uint8Array(W * m.map_height),
  };
  const cs = m.chunk_size;
  const { rows } = await q.query('SELECT cx, cy, terrain, features FROM chunks WHERE match_id=$1', [matchId]);
  for (const r of rows) {
    let k = 0;
    const cw = Math.min(cs, W - r.cx * cs);
    const ch = Math.min(cs, m.map_height - r.cy * cs);
    for (let dy = 0; dy < ch; dy++) for (let dx = 0; dx < cw; dx++) {
      const i = (r.cy * cs + dy) * W + r.cx * cs + dx;
      map.terrain[i] = r.terrain[k];
      map.features[i] = r.features[k];
      k++;
    }
  }
  const { rows: changes } = await q.query('SELECT x, y, terrain, features FROM tiles WHERE match_id=$1', [matchId]);
  for (const c of changes) {
    const i = c.y * W + c.x;
    if (c.terrain !== null) map.terrain[i] = c.terrain;
    if (c.features !== null) map.features[i] = c.features;
  }
  cacheMap(matchId, map);
  return map;
}

// ---------- Состояние партии ----------

/**
 * Кеш состояния на время хода. Состояние хода N не меняется, пока ход не рассчитан
 * (приказы хранятся отдельно), поэтому ключа (партия, номер хода) достаточно и для нескольких инстансов:
 * номер хода каждый раз читается из БД. Возвращаемый объект общий — его нельзя изменять.
 */
const stateCache = new Map<string, { turn: number; state: GameState }>();
const STATE_CACHE_LIMIT = 32;

export async function loadStateCached(q: Q, matchId: string, knownTurn?: number): Promise<GameState> {
  let turn = knownTurn;
  if (turn === undefined) {
    const { rows: [m] } = await q.query('SELECT turn FROM matches WHERE id=$1', [matchId]);
    if (!m) throw new Error('match_not_found');
    turn = m.turn as number;
  }
  const c = stateCache.get(matchId);
  if (c && c.turn === turn) return c.state;
  const s = await loadState(q, matchId);
  if (s.turn === turn) setCachedState(s);
  return s;
}

export function setCachedState(state: GameState): void {
  if (stateCache.size >= STATE_CACHE_LIMIT && !stateCache.has(state.matchId)) stateCache.delete(stateCache.keys().next().value!);
  stateCache.set(state.matchId, { turn: state.turn, state });
}

export function invalidateCachedState(matchId: string): void {
  stateCache.delete(matchId);
}


export async function loadState(q: Q, matchId: string): Promise<GameState> {
  const { rows: [m] } = await q.query('SELECT * FROM matches WHERE id=$1', [matchId]);
  if (!m) throw new Error('match_not_found');
  const map = await loadMap(q, matchId, m);
  // Запросы последовательно: внутри транзакции у одного соединения не может быть параллельных запросов.
  const pl = await q.query('SELECT * FROM players WHERE match_id=$1 ORDER BY seat', [matchId]);
  const rs = await q.query('SELECT player_id, tech_id FROM research WHERE match_id=$1 ORDER BY completed_turn, tech_id', [matchId]);
  const us = await q.query('SELECT * FROM units WHERE match_id=$1 ORDER BY id', [matchId]);
  const cs = await q.query('SELECT * FROM cities WHERE match_id=$1 ORDER BY id', [matchId]);
  const vs = await q.query('SELECT * FROM visibility WHERE match_id=$1', [matchId]);
  const players: PlayerState[] = pl.rows.map(r => ({
    id: r.id, name: r.name, faction: r.faction, color: r.color, gold: r.gold, knowledge: r.knowledge,
    researched: rs.rows.filter(x => x.player_id === r.id).map(x => x.tech_id),
    researchQueue: r.research_queue, researchProgress: r.research_progress, isBot: r.is_bot, eliminated: r.eliminated,
    materials: r.materials ?? { wood: 0, iron: 0, crystal: 0 },
    commander: r.commander ?? { unitId: null, points: 0, cooldowns: {}, directions: {}, pendingChoices: 0, respawnTurn: null },
  }));
  const units: UnitState[] = us.rows.map(r => ({
    id: r.id, owner: r.owner, type: r.type, x: r.x, y: r.y, hp: r.hp, xp: r.xp, rank: r.rank, statuses: r.statuses, countersUsed: 0, createdTurn: r.created_turn, route: r.route ?? null,
    maxHp: r.max_hp ?? r.hp, perks: r.perks ?? [], pendingPerks: r.pending_perks ?? 0, supplyOut: r.supply_out ?? 0,
  }));
  // Сортировка по числовой части id: порядок не влияет на расчёт, но упрощает чтение.
  const cities: CityState[] = cs.rows.map(r => ({
    id: r.id, name: r.name, owner: r.owner, x: r.x, y: r.y, level: r.level, isCapital: r.is_capital,
    contestedBy: r.contested_by, contestedSinceTurn: r.contested_since_turn, productionStock: r.production_stock, queue: r.queue,
    buildings: r.buildings ?? [], food: r.food ?? 0, specialization: r.specialization ?? null,
  }));
  const explored: Record<string, Uint8Array> = {};
  const intel: Record<string, PlayerIntel> = {};
  for (const r of vs.rows) {
    explored[r.player_id] = readExplored(new Uint8Array(r.explored), map.width * map.height);
    intel[r.player_id] = r.intel;
  }
  return canonicalize({
    matchId, turn: m.turn, balanceVersion: m.balance_version, rulesVersion: m.rules_version, map,
    players, units, cities, explored, intel, nextIds: { unit: m.next_unit_id },
  });
}

/** Полная запись изменяемой части состояния. Вызывается внутри транзакции. */
export async function saveState(tx: Tx, state: GameState): Promise<void> {
  const id = state.matchId;
  for (const p of state.players) {
    await tx.query(
      'UPDATE players SET gold=$3, knowledge=$4, research_queue=$5, research_progress=$6, eliminated=$7, materials=$8, commander=$9, faction=$10 WHERE match_id=$1 AND id=$2',
      [id, p.id, p.gold, p.knowledge, p.researchQueue, p.researchProgress, p.eliminated, JSON.stringify(p.materials), JSON.stringify(p.commander), p.faction],
    );
    if (p.researched.length) {
      await tx.query(
        'INSERT INTO research (match_id, player_id, tech_id, completed_turn) SELECT $1, $2, t, $4 FROM unnest($3::text[]) t ON CONFLICT DO NOTHING',
        [id, p.id, p.researched, state.turn - 1],
      );
    }
  }
  await tx.query('DELETE FROM units WHERE match_id=$1', [id]);
  if (state.units.length) {
    const u = state.units;
    await tx.query(
      `INSERT INTO units (match_id, id, owner, type, x, y, hp, xp, rank, statuses, created_turn, route, max_hp, perks, pending_perks, supply_out)
       SELECT $1, u.id, u.owner, u.type, u.x, u.y, u.hp, u.xp, u.rank, u.statuses, u.created_turn, u.route, u.max_hp,
              ARRAY(SELECT jsonb_array_elements_text(u.perks)), u.pending_perks, u.supply_out
       FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::jsonb[], $11::int[], $12::jsonb[], $13::int[], $14::jsonb[], $15::int[], $16::int[])
         AS u(id, owner, type, x, y, hp, xp, rank, statuses, created_turn, route, max_hp, perks, pending_perks, supply_out)`,
      [id, u.map(x => x.id), u.map(x => x.owner), u.map(x => x.type), u.map(x => x.x), u.map(x => x.y), u.map(x => x.hp), u.map(x => x.xp), u.map(x => x.rank), u.map(x => JSON.stringify(x.statuses)), u.map(x => x.createdTurn), u.map(x => (x.route ? JSON.stringify(x.route) : null)),
        u.map(x => x.maxHp), u.map(x => JSON.stringify(x.perks)), u.map(x => x.pendingPerks), u.map(x => x.supplyOut)],
    );
  }
  for (const c of state.cities) {
    await tx.query(
      `INSERT INTO cities (match_id, id, name, owner, x, y, level, is_capital, contested_by, contested_since_turn, production_stock, queue, buildings, food, specialization)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (match_id, id) DO UPDATE SET owner=EXCLUDED.owner, level=EXCLUDED.level, is_capital=EXCLUDED.is_capital,
         contested_by=EXCLUDED.contested_by, contested_since_turn=EXCLUDED.contested_since_turn,
         production_stock=EXCLUDED.production_stock, queue=EXCLUDED.queue, buildings=EXCLUDED.buildings, food=EXCLUDED.food,
         specialization=EXCLUDED.specialization`,
      [id, c.id, c.name, c.owner, c.x, c.y, c.level, c.isCapital, c.contestedBy, c.contestedSinceTurn, c.productionStock, JSON.stringify(c.queue), c.buildings, c.food, c.specialization],
    );
  }
  for (const [pid, ex] of Object.entries(state.explored)) {
    await tx.query(
      `INSERT INTO visibility (match_id, player_id, explored, intel) VALUES ($1,$2,$3,$4)
       ON CONFLICT (match_id, player_id) DO UPDATE SET explored=EXCLUDED.explored, intel=EXCLUDED.intel`,
      [id, pid, Buffer.from(packBits(ex)), JSON.stringify(state.intel[pid] ?? { units: {}, cities: {} })],
    );
  }
  await tx.query('UPDATE matches SET next_unit_id=$2, updated_at=now() WHERE id=$1', [id, state.nextIds.unit]);
}
