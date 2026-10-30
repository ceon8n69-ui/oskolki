// Нагрузочный тест полного цикла с PostgreSQL:
// кампания 256×256, 32 игрока (боты), ~2 000 отрядов, расчёт и запись нескольких ходов.
// npm run load-test -- --turns 5 --units 2000   (DATABASE_URL — отдельная БД, данные не удаляются)
import { BALANCE } from '../src/shared/balance.ts';
import { isLandPassable } from '../src/engine/grid.ts';
import { createRng } from '../src/engine/rng.ts';
import { computeVision } from '../src/engine/vision.ts';
import { chunkView, playerView } from '../src/engine/view.ts';
import { migrate } from '../src/server/db/migrate.ts';
import { createPool, withTx } from '../src/server/db/pool.ts';
import { GameService } from '../src/server/game.ts';
import { invalidateCachedState, loadState, saveState } from '../src/server/store.ts';
import { stopWorldgenWorker } from '../src/worldgen/async.ts';

const args = process.argv.slice(2);
const get = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const turns = Number(get('turns', '5'));
const targetUnits = Number(get('units', '2000'));
const db = createPool(process.env.DATABASE_URL ?? 'postgres://oskolki:oskolki@localhost:5432/oskolki_test');
await migrate(db, () => {});
const game = new GameService(db, BALANCE);
const kb = (n: number) => `${(n / 1024).toFixed(0)} КБ`;
const out: string[] = [];
const log = (s: string) => {
  console.log(s);
  out.push(s);
};

const { rows: [u] } = await db.query(`INSERT INTO users (username, first_name, is_dev) VALUES ('load', 'load', TRUE) RETURNING id`);
let t = performance.now();
const created = await game.createMatch(u.id, 'campaign', 'Нагрузка');
await withTx(db, async tx => {
  for (let i = 1; i < 32; i++) {
    await tx.query(`INSERT INTO players (match_id, id, user_id, name, faction, color, is_bot, seat, gold) VALUES ($1,$2,NULL,$3,'union','#888',TRUE,$4,$5)`, [created.id, `p${i + 1}`, `Бот ${i}`, i, BALANCE.economy.startGold]);
  }
});
await game.startMatch(created.id, u.id);
log(`старт кампании (генерация в потоке + запись): ${Math.round(performance.now() - t)} мс`);

// Доводим число отрядов до цели.
await withTx(db, async tx => {
  const st = await loadState(tx, created.id);
  const rng = createRng(7);
  const taken = new Set(st.units.map(x => `${x.x},${x.y}`));
  let guard = 0;
  while (st.units.filter(x => x.owner !== 'neutral').length < targetUnits && guard++ < targetUnits * 50) {
    const p = st.players[Math.floor(rng() * st.players.length)];
    const cap = st.cities.find(c => c.owner === p.id)!;
    const x = cap.x + Math.floor(rng() * 21) - 10, y = cap.y + Math.floor(rng() * 21) - 10;
    if (!isLandPassable(BALANCE, st.map, x, y) || taken.has(`${x},${y}`)) continue;
    taken.add(`${x},${y}`);
    const type = ['infantry', 'scout', 'infantry', 'infantry'][Math.floor(rng() * 4)];
    st.units.push({ id: `u${st.nextIds.unit++}`, owner: p.id, type, x, y, hp: BALANCE.units[type].hp, xp: 0, rank: 0, statuses: [], countersUsed: 0, createdTurn: 1, route: null });
  }
  await saveState(tx, st);
  log(`игроков ${st.players.length}, отрядов ${st.units.length}`);
});
invalidateCachedState(created.id);

for (let i = 1; i <= turns; i++) {
  t = performance.now();
  const r = await game.processTurn(created.id, i);
  const ms = Math.round(performance.now() - t);
  const { rows: [sz] } = await db.query(
    `SELECT pg_column_size(snapshot) AS snap, (SELECT sum(pg_column_size(event))::int FROM turn_events WHERE match_id=$1 AND turn=$2) AS ev,
            (SELECT count(*)::int FROM units WHERE match_id=$1) AS units, resolve_ms FROM turns WHERE match_id=$1 AND number=$3`,
    [created.id, i, i + 1],
  );
  log(`ход ${i}: обработка ${ms} мс (в т. ч. ИИ ботов и запись в БД), событий ${r?.events.length}, отрядов ${sz.units}, снимок в БД ${kb(sz.snap)}, события в БД ${kb(sz.ev ?? 0)}`);
}

// Размер того, что получает клиент.
t = performance.now();
const st = await loadState(db, created.id);
const loadMs = Math.round(performance.now() - t);
const pid = 'p1';
const v = computeVision(BALANCE, st, pid);
const view = JSON.stringify(playerView(BALANCE, st, pid, v));
const chunks = JSON.stringify(Array.from({ length: 16 }, (_, i) => chunkView(st, pid, i % 4, Math.floor(i / 4), v)));
log(`загрузка состояния из БД (без кеша): ${loadMs} мс`);
log(`ответ /state для игрока: ${kb(view.length)}; 16 чанков (экран): ${kb(chunks.length)}`);
const mem = process.memoryUsage();
log(`память процесса: heap ${(mem.heapUsed / 2 ** 20).toFixed(0)} МБ, rss ${(mem.rss / 2 ** 20).toFixed(0)} МБ`);
log(`партия: ${created.id} (данные оставлены для анализа)`);

await stopWorldgenWorker();
await db.end();
