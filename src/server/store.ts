// Загрузка и сохранение GameState в PostgreSQL.
import { createHash } from 'node:crypto';
import type { GameState, MapData, PlayerIntel, PlayerState, UnitState, CityState } from '../shared/types.ts';
import type { Tx, Db } from './db/pool.ts';
import { canonicalize, stableStringify } from '../engine/canonical.ts';

type Q = Tx | Db;

// ---------- Сериализация ----------

export function b64(a: Uint8Array): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}
export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Состояние без статичной карты — для снимков turns.snapshot. */
export function stateToJson(state: GameState): Record<string, unknown> {
  const { map, explored, ...rest } = state;
  return {
    ...rest,
    map: { width: map.width, height: map.height, chunkSize: map.chunkSize, seed: map.seed, generatorVersion: map.generatorVersion },
    explored: Object.fromEntries(Object.entries(explored).map(([k, v]) => [k, b64(v)])),
  };
}

export function stateFromJson(json: any, map: MapData): GameState {
  return {
    ...json,
    map,
    explored: Object.fromEntries(Object.entries(json.explored as Record<string, string>).map(([k, v]) => [k, fromB64(v)])),
  } as GameState;
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
      await q.query('INSERT INTO chunks (match_id, cx, cy, terrain, features) VALUES ($1,$2,$3,$4,$5)', [matchId, cx, cy, Buffer.from(t), Buffer.from(f)]);
    }
  }
  cacheMap(matchId, map);
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
  }));
  const units: UnitState[] = us.rows.map(r => ({
    id: r.id, owner: r.owner, type: r.type, x: r.x, y: r.y, hp: r.hp, xp: r.xp, rank: r.rank, statuses: r.statuses, countersUsed: 0, createdTurn: r.created_turn,
  }));
  // Сортировка по числовой части id: порядок не влияет на расчёт, но упрощает чтение.
  const cities: CityState[] = cs.rows.map(r => ({
    id: r.id, name: r.name, owner: r.owner, x: r.x, y: r.y, level: r.level, isCapital: r.is_capital,
    contestedBy: r.contested_by, contestedSinceTurn: r.contested_since_turn, productionStock: r.production_stock, queue: r.queue,
  }));
  const explored: Record<string, Uint8Array> = {};
  const intel: Record<string, PlayerIntel> = {};
  for (const r of vs.rows) {
    explored[r.player_id] = new Uint8Array(r.explored);
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
      'UPDATE players SET gold=$3, knowledge=$4, research_queue=$5, research_progress=$6, eliminated=$7 WHERE match_id=$1 AND id=$2',
      [id, p.id, p.gold, p.knowledge, p.researchQueue, p.researchProgress, p.eliminated],
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
      `INSERT INTO units (match_id, id, owner, type, x, y, hp, xp, rank, statuses, created_turn)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::jsonb[], $11::int[])`,
      [id, u.map(x => x.id), u.map(x => x.owner), u.map(x => x.type), u.map(x => x.x), u.map(x => x.y), u.map(x => x.hp), u.map(x => x.xp), u.map(x => x.rank), u.map(x => JSON.stringify(x.statuses)), u.map(x => x.createdTurn)],
    );
  }
  for (const c of state.cities) {
    await tx.query(
      `INSERT INTO cities (match_id, id, name, owner, x, y, level, is_capital, contested_by, contested_since_turn, production_stock, queue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (match_id, id) DO UPDATE SET owner=EXCLUDED.owner, level=EXCLUDED.level, is_capital=EXCLUDED.is_capital,
         contested_by=EXCLUDED.contested_by, contested_since_turn=EXCLUDED.contested_since_turn,
         production_stock=EXCLUDED.production_stock, queue=EXCLUDED.queue`,
      [id, c.id, c.name, c.owner, c.x, c.y, c.level, c.isCapital, c.contestedBy, c.contestedSinceTurn, c.productionStock, JSON.stringify(c.queue)],
    );
  }
  for (const [pid, ex] of Object.entries(state.explored)) {
    await tx.query(
      `INSERT INTO visibility (match_id, player_id, explored, intel) VALUES ($1,$2,$3,$4)
       ON CONFLICT (match_id, player_id) DO UPDATE SET explored=EXCLUDED.explored, intel=EXCLUDED.intel`,
      [id, pid, Buffer.from(ex), JSON.stringify(state.intel[pid] ?? { units: {}, cities: {} })],
    );
  }
  await tx.query('UPDATE matches SET next_unit_id=$2, updated_at=now() WHERE id=$1', [id, state.nextIds.unit]);
}
