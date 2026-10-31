// Интеграционные тесты сервера на реальной PostgreSQL (DATABASE_URL_TEST).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BALANCE } from '../../src/shared/balance.ts';
import type { StateResponse } from '../../src/shared/protocol.ts';
import { buildApp } from '../../src/server/app.ts';
import { signInitData } from '../../src/server/auth.ts';
import { loadConfig } from '../../src/server/config.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { createPool } from '../../src/server/db/pool.ts';
import type { Db } from '../../src/server/db/pool.ts';
import { GameService } from '../../src/server/game.ts';
import { invalidateCachedState, loadState, stateFromJson, stateHash } from '../../src/server/store.ts';
import { resolveTurn } from '../../src/engine/resolve.ts';

const URL_TEST = process.env.DATABASE_URL_TEST ?? 'postgres://oskolki:oskolki@localhost:5432/oskolki_test';
const BOT_TOKEN = '123456:TEST-TOKEN';
let db: Db;
let game: GameService;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  db = createPool(URL_TEST);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  game = new GameService(db, BALANCE);
  const cfg = loadConfig({ NODE_ENV: 'test', DEV_AUTH: '1', BOT_TOKEN, ADMIN_TOKEN: 'admin-secret' } as any);
  app = await buildApp({ cfg, db, game, b: BALANCE });
});
after(async () => {
  await app.close();
  await db.end();
});

async function call<T = any>(method: string, url: string, token?: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as any });
  return { status: r.statusCode, json: r.json() as T };
}
async function devLogin(name: string): Promise<string> {
  return (await call('POST', '/api/auth/dev', undefined, { name })).json.token;
}

test('авторизация Telegram: подпись проверяется, подделка отклоняется', async () => {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 777, first_name: 'Тарас' }), start_param: 'join_abc' };
  const ok = await call('POST', '/api/auth/telegram', undefined, { initData: signInitData(fields, BOT_TOKEN) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.startParam, 'join_abc');
  const forged = signInitData({ ...fields, user: JSON.stringify({ id: 1, first_name: 'X' }) }, 'other:token');
  assert.equal((await call('POST', '/api/auth/telegram', undefined, { initData: forged })).status, 401);
  const old = signInitData({ ...fields, auth_date: String(Math.floor(Date.now() / 1000) - 200000) }, BOT_TOKEN);
  assert.equal((await call('POST', '/api/auth/telegram', undefined, { initData: old })).json.error, 'initdata_expired');
  assert.equal((await call('GET', '/api/matches', 'v1.bad.token')).status, 401);
});

test('полный цикл: два игрока, приказы, готовность, расчёт, переподключение', async () => {
  const t1 = await devLogin('Алиса');
  const t2 = await devLogin('Борис');
  const created = await call('POST', '/api/matches', t1, { preset: 'quick' });
  assert.equal(created.status, 200);
  const matchId = created.json.id;
  assert.equal(created.json.phase, 'lobby');
  // Чужой игрок не видит партию до вступления.
  assert.equal((await call('GET', `/api/matches/${matchId}/state`, t2)).status, 409);
  const joined = await call('POST', '/api/matches/join', t2, { inviteCode: created.json.inviteCode });
  assert.equal(joined.json.phase, 'planning');
  // Повторный переход по ссылке не создаёт второго игрока.
  assert.equal((await call('POST', '/api/matches/join', t2, { inviteCode: created.json.inviteCode })).json.players.length, 2);

  const s1 = (await call<StateResponse>('GET', `/api/matches/${matchId}/state`, t1)).json;
  const s2 = (await call<StateResponse>('GET', `/api/matches/${matchId}/state`, t2)).json;
  assert.equal(s1.view.turn, 1);
  const myUnits = s1.view.units.filter(u => u.owner === s1.view.me.id);
  assert.ok(myUnits.length >= 2);
  // Игрок не видит отрядов противника за пределами обзора.
  assert.ok(!s1.view.units.some(u => s2.view.units.find(x => x.id === u.id && x.owner === s2.view.me.id)));

  // Чанки: неисследованные клетки скрыты.
  const ch = (await call('GET', `/api/matches/${matchId}/chunks?list=0,0;1,0;0,1;1,1`, t1)).json;
  assert.equal(ch.chunks.length, 4);
  const unknown = ch.chunks.flatMap((c: any) => c.terrain).filter((t: number) => t === 255).length;
  assert.ok(unknown > 0);

  // Приказ движения + идемпотентность.
  const unit = myUnits.find(u => u.type === 'scout')!;
  const moves = (await call('GET', `/api/matches/${matchId}/preview/moves?unitId=${unit.id}`, t1)).json.tiles;
  assert.ok(moves.length > 0);
  const occupied = new Set(s1.view.units.map(u => `${u.x},${u.y}`));
  const dest = moves.filter((m: any) => !occupied.has(`${m.x},${m.y}`)).sort((a: any, b: any) => b.cost - a.cost)[0];
  const route = await findRoute(matchId, unit.id, dest);
  const key = randomUUID();
  const o1 = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: unit.id, mode: 'move', path: route }, idempotencyKey: key });
  assert.equal(o1.json.ok, true, JSON.stringify(o1.json));
  const o1again = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: unit.id, mode: 'move', path: route }, idempotencyKey: key });
  assert.equal(o1again.json.order.id, o1.json.order.id);
  // Изменение приказа повышает версию; устаревшая версия отклоняется.
  const o2 = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: unit.id, mode: 'hold', path: [] }, idempotencyKey: randomUUID(), baseVersion: 1 });
  assert.equal(o2.json.order.version, 2);
  const stale = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: unit.id, mode: 'hold', path: [] }, idempotencyKey: randomUUID(), baseVersion: 1 });
  assert.equal(stale.json.reason, 'version_conflict');
  await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: unit.id, mode: 'move', path: route }, idempotencyKey: randomUUID() });
  // Приказ чужому отряду отклоняется.
  const theirs = s2.view.units.find(u => u.owner === s2.view.me.id)!;
  const bad = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: theirs.id, mode: 'hold', path: [] }, idempotencyKey: randomUUID() });
  assert.equal(bad.json.reason, 'not_owner');

  // Найм: резерв золота и освобождение при отмене.
  const cap = s1.view.cities.find(c => c.owner === s1.view.me.id)!;
  const rec = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'recruit', cityId: cap.id, unitType: 'infantry' }, idempotencyKey: randomUUID() });
  assert.equal(rec.json.reserved.gold, BALANCE.units.infantry.cost.gold);
  await call('DELETE', `/api/matches/${matchId}/orders?subject=recruit:${cap.id}&turn=1`, t1);
  assert.equal((await call<StateResponse>('GET', `/api/matches/${matchId}/state`, t1)).json.reserved.gold, 0);
  await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'recruit', cityId: cap.id, unitType: 'infantry' }, idempotencyKey: randomUUID() });

  // Готовность обоих → ход рассчитывается.
  await call('POST', `/api/matches/${matchId}/ready`, t1, { turn: 1, ready: true });
  await call('POST', `/api/matches/${matchId}/ready`, t2, { turn: 1, ready: true });
  const due = await game.dueMatches();
  assert.ok(due.some(d => d.id === matchId));
  // Два обработчика одновременно — ход рассчитывается ровно один раз.
  const [r1, r2] = await Promise.all([game.processTurn(matchId, 1), game.processTurn(matchId, 1)]);
  assert.equal([r1, r2].filter(Boolean).length, 1);
  assert.equal((await game.processTurn(matchId, 1)), null);

  // Приказ на закрытый ход отклоняется.
  const late = await call('POST', `/api/matches/${matchId}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: unit.id, mode: 'hold', path: [] }, idempotencyKey: randomUUID() });
  assert.equal(late.json.reason, 'turn_closed');

  // «Переподключение»: новое чтение состояния отражает результат.
  const after1 = (await call<StateResponse>('GET', `/api/matches/${matchId}/state`, t1)).json;
  assert.equal(after1.view.turn, 2);
  const moved = after1.view.units.find(u => u.id === unit.id)!;
  const dbgEv = (await call('GET', `/api/matches/${matchId}/events?turn=1`, t1)).json.events.filter((e: any) => e.event.unitId === unit.id || e.event.attackerId === unit.id);
  assert.deepEqual([moved.x, moved.y], [route[route.length - 1].x, route[route.length - 1].y], JSON.stringify({ route, start: [unit.x, unit.y], dbgEv }));
  const ev = (await call('GET', `/api/matches/${matchId}/events?turn=1`, t1)).json.events;
  const inc = ev.find((e: any) => e.event.t === 'income').event;
  assert.equal(after1.view.me.gold, BALANCE.economy.startGold - BALANCE.units.infantry.cost.gold + inc.gold - inc.upkeep);
  assert.ok(ev.some((e: any) => e.event.t === 'move' && e.event.unitId === unit.id));
  // События противника, которых игрок не видел, ему не отдаются.
  const ev2 = (await call('GET', `/api/matches/${matchId}/events?turn=1`, t2)).json.events;
  assert.ok(!ev2.some((e: any) => e.event.t === 'production_queued'));

  // Воспроизводимость: снимок хода 1 + те же приказы → тот же хэш результата.
  await assertReplayable(matchId, 1);
});

test('сбой во время расчёта не списывает ресурсы повторно', async () => {
  const t1 = await devLogin('Вера');
  const m = (await call('POST', '/api/matches', t1, { preset: 'vsbot' })).json;
  assert.equal(m.phase, 'planning');
  const s = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  const cap = s.view.cities.find(c => c.owner === s.view.me.id)!;
  await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'recruit', cityId: cap.id, unitType: 'infantry' }, idempotencyKey: randomUUID() });
  const gold0 = s.view.me.gold;

  // Ломаем запись событий посреди транзакции.
  const orig = (game as any).queueTurnNotifications;
  (game as any).queueTurnNotifications = async () => {
    throw new Error('simulated crash');
  };
  await assert.rejects(game.processTurn(m.id, 1), /simulated crash/);
  (game as any).queueTurnNotifications = orig;
  const mid = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(mid.view.turn, 1);
  assert.equal(mid.view.me.gold, gold0);
  assert.equal(mid.orders.length, 1);

  const r = await game.processTurn(m.id, 1);
  assert.ok(r);
  const after = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(after.view.turn, 2);
  const queued = r!.events.filter(e => e.event.t === 'production_queued' && e.event.owner === s.view.me.id);
  assert.equal(queued.length, 1);
  const income = r!.events.find(e => e.event.t === 'income' && e.event.playerId === s.view.me.id)!.event as any;
  assert.equal(after.view.me.gold, gold0 - BALANCE.units.infantry.cost.gold + income.gold - income.upkeep);
});

test('бот-противник отдаёт приказы и партия идёт несколько ходов', async () => {
  const t1 = await devLogin('Гена');
  const m = (await call('POST', '/api/matches', t1, { preset: 'vsbot' })).json;
  for (let turn = 1; turn <= 6; turn++) {
    await call('POST', `/api/matches/${m.id}/ready`, t1, { turn, ready: true });
    const r = await game.processTurn(m.id, turn);
    assert.ok(r, `ход ${turn} не рассчитан`);
  }
  const s = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(s.view.turn, 7);
  const { rows } = await db.query(`SELECT count(*)::int n FROM turns WHERE match_id=$1 AND status='resolved'`, [m.id]);
  assert.equal(rows[0].n, 6);
  for (let t = 1; t <= 6; t++) await assertReplayable(m.id, t);
});

test('административный отчёт генерации доступен только с токеном', async () => {
  assert.equal((await call('GET', '/api/admin/worldgen?preset=test32&seed=x')).status, 403);
  const r = await app.inject({ method: 'GET', url: '/api/admin/worldgen?preset=test32&seed=x', headers: { 'x-admin-token': 'admin-secret' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().report.ok, true);
});

async function findRoute(matchId: string, unitId: string, dest: { x: number; y: number }) {
  const { findPath } = await import('../../src/engine/path.ts');
  const st = await loadState(db, matchId);
  const u = st.units.find(x => x.id === unitId)!;
  // Свои отряды на пути тоже мешают: не прокладываем маршрут через занятые клетки.
  const blocked = new Set(st.units.filter(x => x.id !== unitId).map(x => x.y * st.map.width + x.x));
  return findPath(BALANCE, st.map, u, dest, { budget: BALANCE.units[u.type].move, blocked })!;
}

async function assertReplayable(matchId: string, turn: number) {
  const { rows: [t] } = await db.query('SELECT snapshot, result_hash FROM turns WHERE match_id=$1 AND number=$2', [matchId, turn]);
  const live = await loadState(db, matchId);
  const snap = stateFromJson(t.snapshot, live.map);
  const { rows: ords } = await db.query(`SELECT id, player_id, payload FROM orders WHERE match_id=$1 AND turn=$2 AND status='consumed' ORDER BY player_id, id`, [matchId, turn]);
  // Приказы ботов хранятся в журнале наравне с приказами людей — ИИ при воспроизведении не нужен.
  const orders = ords.map(o => ({ id: o.id, playerId: o.player_id, order: o.payload }));
  const { state } = resolveTurn(BALANCE, snap, orders);
  assert.equal(stateHash(state), t.result_hash, `ход ${turn} не воспроизводится`);
}

test('этап 2: дорога сохраняется в БД, мини-карта, маршрут переживает перезагрузку состояния', async () => {
  const t1 = await devLogin('Дана');
  const m = (await call('POST', '/api/matches', t1, { preset: 'vsbot' })).json;
  const s = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  const inf = s.view.units.find(u => u.owner === s.view.me.id && u.type === 'infantry')!;
  const r = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: inf.id, mode: 'build', build: 'road', path: [] }, idempotencyKey: randomUUID() });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.reserved.gold, Math.max(1, Math.round(BALANCE.roads.goldCost * (BALANCE.factions.union.traits.roadCostMul ?? 1))));
  // Разведчик: долгий маршрут по исследованным клеткам.
  const sc = s.view.units.find(u => u.owner === s.view.me.id && u.type === 'scout')!;
  // Открываем игроку всю карту (как будто он её разведал), чтобы проложить длинный маршрут.
  await db.query(`UPDATE visibility SET explored = decode(repeat('ff', 128), 'hex') WHERE match_id=$1 AND player_id=$2`, [m.id, s.view.me.id]);
  invalidateCachedState(m.id);
  const st0 = await loadState(db, m.id);
  const { findPath, pathCost } = await import('../../src/engine/path.ts');
  const ex = st0.explored[s.view.me.id];
  let far: { x: number; y: number } | null = null;
  for (let i = ex.length - 1; i >= 0 && !far; i--) {
    if (!ex[i]) continue;
    const c = { x: i % st0.map.width, y: Math.floor(i / st0.map.width) };
    const p = findPath(BALANCE, st0.map, sc, c);
    if (p && pathCost(BALANCE, st0.map, sc, p).ok && (pathCost(BALANCE, st0.map, sc, p) as any).cost > BALANCE.units.scout.move && p.every(q => ex[q.y * st0.map.width + q.x]) && !st0.units.some(u => p.some(q => q.x === u.x && q.y === u.y))) far = c;
  }
  assert.ok(far, 'не найдена дальняя исследованная клетка');
  if (far) {
    const p = findPath(BALANCE, st0.map, sc, far)!;
    const rr = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: sc.id, mode: 'move', longRoute: true, stopOnThreat: false, path: p }, idempotencyKey: randomUUID() });
    assert.equal(rr.json.ok, true, JSON.stringify(rr.json));
  }
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  const { rows } = await db.query('SELECT x, y, features FROM tiles WHERE match_id=$1', [m.id]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].x, rows[0].y], [inf.x, inf.y]);
  // Загрузка с диска (мимо кеша) видит дорогу и маршрут.
  const fresh = await loadState(db, m.id);
  assert.ok(fresh.map.features[inf.y * fresh.map.width + inf.x] & 1);
  if (far) assert.ok(fresh.units.find(u => u.id === sc.id)!.route, 'маршрут должен сохраниться');
  const mm = (await call('GET', `/api/matches/${m.id}/minimap`, t1)).json;
  assert.equal(mm.width, 32);
  assert.ok(mm.cities.length >= 1);
  // Ход 1 не сверяем: тест вручную менял видимость после снимка. Ход 2 (с продолжением маршрута) — сверяем.
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 2, ready: true });
  const r2 = await game.processTurn(m.id, 2);
  assert.ok(r2);
  assert.ok(r2!.events.some(e => e.event.t === 'route_continued' || e.event.t === 'route_completed' || e.event.t === 'route_paused'));
  await assertReplayable(m.id, 2);
});

test('этап 2: кампания 256×256 стартует, генерация в отдельном потоке', async () => {
  const t1 = await devLogin('Ева');
  const t2 = await devLogin('Жора');
  const m = (await call('POST', '/api/matches', t1, { preset: 'campaign' })).json;
  assert.equal(m.maxPlayers, 32);
  await call('POST', '/api/matches/join', t2, { inviteCode: m.inviteCode });
  assert.equal((await call('POST', `/api/matches/${m.id}/start`, t2)).status, 403);
  const started = await call('POST', `/api/matches/${m.id}/start`, t1);
  assert.equal(started.json.phase, 'planning');
  const s = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(s.view.map.width, 256);
  const { rows: [c] } = await db.query('SELECT count(*)::int n FROM chunks WHERE match_id=$1', [m.id]);
  assert.equal(c.n, 256);
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  await call('POST', `/api/matches/${m.id}/ready`, t2, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  await assertReplayable(m.id, 1);
});

test('этап 3: выбор народа в лобби, постройка и приказ командиру через API, партия с ботом 10 ходов воспроизводима', async () => {
  const t1 = await devLogin('Злата');
  const t2 = await devLogin('Игорь');
  const m = (await call('POST', '/api/matches', t1, { preset: 'quick', faction: 'forest' })).json;
  assert.equal((await call('POST', `/api/matches/${m.id}/faction`, t1, { faction: 'atlantis' })).status, 400);
  await call('POST', `/api/matches/${m.id}/faction`, t1, { faction: 'mountain' });
  const joined = (await call('POST', '/api/matches/join', t2, { inviteCode: m.inviteCode, faction: 'tide' })).json;
  assert.equal(joined.phase, 'planning');
  assert.deepEqual(joined.players.map((p: any) => p.faction), ['mountain', 'tide']);
  assert.equal((await call('POST', `/api/matches/${m.id}/faction`, t1, { faction: 'union' })).status, 409);
  const s = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(s.view.me.faction, 'mountain');
  assert.ok(s.view.me.commander.unitId);
  assert.ok(s.view.units.some(u => u.type === 'commander' && u.owner === s.view.me.id));
  const cap = s.view.cities.find(c => c.owner === s.view.me.id)!;
  const r1 = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'construct', cityId: cap.id, building: 'barracks' }, idempotencyKey: randomUUID() });
  assert.equal(r1.json.ok, true, JSON.stringify(r1.json));
  assert.equal(r1.json.reserved.wood, 1);
  const r2 = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'commander', action: 'direction', direction: 'logistics' }, idempotencyKey: randomUUID() });
  assert.equal(r2.json.ok, true, JSON.stringify(r2.json));
  const rules = (await call('GET', '/api/rules')).json;
  assert.ok(rules.factions.tide && rules.effects.zoc);
  const ch = (await call('GET', `/api/matches/${m.id}/chunks?list=${Math.floor(cap.x / 16)},${Math.floor(cap.y / 16)}`, t1)).json;
  assert.ok(ch.chunks[0].supply.some((x: number) => x === 1), 'слой снабжения');
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  await call('POST', `/api/matches/${m.id}/ready`, t2, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  const after = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(after.view.me.commander.directions.logistics, 1);
  assert.deepEqual(after.view.cities.find(c => c.id === cap.id)!.queue.map(q => q.unitType), ['barracks']);
  await assertReplayable(m.id, 1);

  const t3 = await devLogin('Кира');
  const vb = (await call('POST', '/api/matches', t3, { preset: 'vsbot', faction: 'union' })).json;
  assert.notEqual(vb.players[1].faction, 'union');
  for (let turn = 1; turn <= 10; turn++) {
    await call('POST', `/api/matches/${vb.id}/ready`, t3, { turn, ready: true });
    assert.ok(await game.processTurn(vb.id, turn), `ход ${turn}`);
  }
  for (let t = 1; t <= 10; t++) await assertReplayable(vb.id, t);
  const { rows } = await db.query(`SELECT count(*)::int n FROM turn_events WHERE match_id=$1 AND event->>'t' = 'order_rejected'`, [vb.id]);
  assert.equal(rows[0].n, 0, 'бот не отдаёт недопустимых приказов');
});

test('этап 4: режим партии, боты в лобби, дипломатия, общие метки, замещение ботом и возврат', async () => {
  const t1 = await devLogin('Лев');
  const t2 = await devLogin('Мила');
  assert.equal((await call('POST', '/api/matches', t1, { preset: 'async', victory: 'influence', turnLimit: null })).json.error, 'influence_needs_turn_limit');
  const m = (await call('POST', '/api/matches', t1, { preset: 'async', faction: 'union', victory: 'influence', turnLimit: 12, alliances: true })).json;
  assert.equal(m.victory, 'influence');
  assert.equal(m.turnLimit, 12);
  await call('POST', '/api/matches/join', t2, { inviteCode: m.inviteCode, faction: 'forest' });
  assert.equal((await call('POST', `/api/matches/${m.id}/bots`, t2, { count: 1 })).status, 403);
  const withBot = (await call('POST', `/api/matches/${m.id}/bots`, t1, { count: 1 })).json;
  assert.equal(withBot.players.length, 3);
  assert.equal((await call('POST', `/api/matches/${m.id}/start`, t1)).json.phase, 'planning');
  const s1 = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.ok(s1.view.mode.objectives.length >= BALANCE.influence.minObjectives, 'цели влияния объявлены');
  const p1 = s1.view.me.id;
  const p2 = s1.view.players.find(p => p.name === 'Мила')!.id;

  // Ход 1: p1 предлагает союз; p2 ничего не делает.
  const prop = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'diplomacy', action: 'propose', target: p2, status: 'alliance' }, idempotencyKey: randomUUID() });
  assert.equal(prop.json.ok, true, JSON.stringify(prop.json));
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  // Ход 2: p2 принимает.
  const acc = await call('POST', `/api/matches/${m.id}/orders`, t2, { turn: 2, order: { kind: 'diplomacy', action: 'accept', target: p1 }, idempotencyKey: randomUUID() });
  assert.equal(acc.json.ok, true, JSON.stringify(acc.json));
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 2, ready: true });
  await call('POST', `/api/matches/${m.id}/ready`, t2, { turn: 2, ready: true });
  assert.ok(await game.processTurn(m.id, 2));
  const s3 = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t2)).json;
  assert.equal(s3.view.diplomacy.find(t => [t.a, t.b].includes(p1) && [t.a, t.b].includes(p2))?.status, 'alliance');

  // Общие метки видны союзнику, личные — нет.
  await call('POST', `/api/matches/${m.id}/markers`, t1, { x: 3, y: 3, label: 'Сбор здесь', shared: true });
  await call('POST', `/api/matches/${m.id}/markers`, t1, { x: 4, y: 4, label: 'Только мне', shared: false });
  const mk2 = (await call('GET', `/api/matches/${m.id}/markers`, t2)).json.markers;
  assert.deepEqual(mk2.map((x: any) => x.label), ['Сбор здесь']);

  // p2 пропускает ходы → управление у бота (порог для async — 3 хода подряд; ход 2 был с приказом).
  for (const turn of [3, 4, 5]) {
    await call('POST', `/api/matches/${m.id}/ready`, t1, { turn, ready: true });
    assert.ok(await game.processTurn(m.id, turn));
  }
  const info = (await call('GET', `/api/matches/${m.id}`, t1)).json;
  const p2info = info.players.find((p: any) => p.id === p2);
  assert.equal(p2info.isBot, true);
  assert.equal(p2info.replacedByBot, true);
  const { rows: botOrders } = await db.query(`SELECT count(*)::int n FROM orders WHERE match_id=$1 AND turn=5 AND player_id=$2 AND idempotency_key LIKE 'bot-%'`, [m.id, p2]);
  assert.ok(botOrders[0].n > 0, 'бот отдаёт приказы за отсутствующего игрока');
  // Игрок вернулся — управление у него.
  await call('POST', `/api/matches/${m.id}/ready`, t2, { turn: 6, ready: true });
  const back = (await call('GET', `/api/matches/${m.id}`, t2)).json.players.find((p: any) => p.id === p2);
  assert.equal(back.isBot, false);
  for (let t = 1; t <= 5; t++) await assertReplayable(m.id, t);
});

test('этап 4: партия завершается по лимиту ходов с победителем по очкам влияния', async () => {
  const t1 = await devLogin('Ника');
  const m = (await call('POST', '/api/matches', t1, { preset: 'vsbot', victory: 'influence', turnLimit: 5 })).json;
  assert.equal(m.phase, 'planning');
  for (let turn = 1; turn <= 5; turn++) {
    await call('POST', `/api/matches/${m.id}/ready`, t1, { turn, ready: true });
    const r = await game.processTurn(m.id, turn);
    assert.ok(r);
    if (turn === 5) assert.equal(r!.finished, true);
  }
  const info = (await call('GET', `/api/matches/${m.id}`, t1)).json;
  assert.equal(info.phase, 'finished');
  assert.equal(info.winners.length, 1);
  const { rows: [res] } = await db.query('SELECT result FROM matches WHERE id=$1', [m.id]);
  assert.equal(res.result.reason, 'influence_turn_limit');
});

test('этап 5: архипелаг, новые народы, обелиск через API, груз и сооружения переживают перезагрузку, ход воспроизводим', async () => {
  const t1 = await devLogin('Руна');
  const m = (await call('POST', '/api/matches', t1, { preset: 'islands', faction: 'ruins' })).json;
  await call('POST', `/api/matches/${m.id}/bots`, t1, { count: 3 });
  assert.equal((await call('POST', `/api/matches/${m.id}/start`, t1)).json.phase, 'planning');
  const s1 = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.deepEqual(s1.view.structures, []);
  assert.ok(Array.isArray(s1.view.worldEvents));
  assert.equal(s1.view.players.find(p => p.id === s1.view.me.id)!.faction, 'ruins');
  // Обелиск: пехота выходит из столицы (в городе обелиск не ставится), затем строит.
  const me = s1.view.me.id;
  const inf = s1.view.units.find(x => x.owner === me && x.type === 'infantry')!;
  const r0 = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: inf.id, mode: 'build', build: 'obelisk', path: [] }, idempotencyKey: randomUUID() });
  assert.equal(r0.json.error ?? r0.json.reason, 'obelisk_in_city', JSON.stringify(r0.json));
  const step = (await call('GET', `/api/matches/${m.id}/preview/moves?unitId=${inf.id}`, t1)).json.tiles.find((t: { cost: number }) => t.cost <= 1);
  await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'unit', unitId: inf.id, mode: 'move', path: [{ x: step.x, y: step.y }] }, idempotencyKey: randomUUID() });
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  const r = await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 2, order: { kind: 'unit', unitId: inf.id, mode: 'build', build: 'obelisk', path: [] }, idempotencyKey: randomUUID() });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.reserved.gold, BALANCE.obelisks.goldCost);
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 2, ready: true });
  assert.ok(await game.processTurn(m.id, 2));
  await assertReplayable(m.id, 2);
  const s2 = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  assert.equal(s2.view.structures.length, 1);
  assert.equal(s2.view.structures[0].linked, true);
  // Груз и состояние мира сохраняются в таблицах и читаются обратно.
  invalidateCachedState(m.id);
  const live = await loadState(db, m.id);
  assert.equal(live.world.structures.length, 1);
  const ship = { ...live.units[0], id: 'u9001', type: 'transport', owner: me, carriedBy: undefined };
  const water = live.map.terrain.findIndex(t => t <= 1);
  ship.x = water % live.map.width;
  ship.y = Math.floor(water / live.map.width);
  const rider = { ...live.units[1], id: 'u9002', owner: me, type: 'infantry', x: ship.x, y: ship.y, carriedBy: 'u9001' };
  live.units.push(ship, rider);
  const { withTx } = await import('../../src/server/db/pool.ts');
  const { saveState } = await import('../../src/server/store.ts');
  await withTx(db, tx => saveState(tx, live));
  const again = await loadState(db, m.id);
  assert.equal(again.units.find(x => x.id === 'u9002')!.carriedBy, 'u9001');
  assert.equal(stateHash(again), stateHash(live));
});

test('комнаты: удаление создателем, выход участника, права, повторы и гонка удаления со стартом', async () => {
  const t1 = await devLogin('Создатель');
  const t2 = await devLogin('Гость');
  const t3 = await devLogin('Чужой');
  const m = (await call('POST', '/api/matches', t1, { preset: 'async', turnLimit: 20 })).json;
  await call('POST', '/api/matches/join', t2, { inviteCode: m.inviteCode });
  // Чужой не удалит, участник не удалит.
  assert.equal((await call('DELETE', `/api/matches/${m.id}`, t3)).status, 403);
  assert.equal((await call('DELETE', `/api/matches/${m.id}`, t2)).json.error, 'only_creator_can_delete');
  // Участник выходит; повтор безопасен; создатель выйти не может — только удалить.
  assert.equal((await call('POST', `/api/matches/${m.id}/leave`, t2)).json.ok, true);
  assert.equal((await call('POST', `/api/matches/${m.id}/leave`, t2)).json.ok, true);
  assert.equal((await call('POST', `/api/matches/${m.id}/leave`, t1)).json.error, 'creator_must_delete');
  // После выхода номер места не повторяется.
  await call('POST', '/api/matches/join', t2, { inviteCode: m.inviteCode });
  const info = (await call('GET', `/api/matches/${m.id}`, t1)).json;
  assert.equal(new Set(info.players.map((p: { id: string }) => p.id)).size, info.players.length);
  // Удаление: повтор безопасен, комната исчезает у всех, по приглашению не войти, стартовать нельзя.
  assert.equal((await call('DELETE', `/api/matches/${m.id}`, t1)).json.ok, true);
  assert.equal((await call('DELETE', `/api/matches/${m.id}`, t1)).json.ok, true);
  for (const t of [t1, t2]) assert.ok(!(await call('GET', '/api/matches', t)).json.matches.some((x: { id: string }) => x.id === m.id));
  assert.equal((await call('POST', '/api/matches/join', t3, { inviteCode: m.inviteCode })).status, 404);
  assert.equal((await call('POST', `/api/matches/${m.id}/start`, t1)).status, 404);
  const { rows: [row] } = await db.query('SELECT deleted_at, (SELECT count(*)::int FROM players WHERE match_id=$1) AS n FROM matches WHERE id=$1', [m.id]);
  assert.ok(row.deleted_at && row.n >= 1, 'мягкое удаление: строки сохранены');

  // Гонка: старт и удаление одновременно — побеждает ровно одна операция.
  const r = (await call('POST', '/api/matches', t1, { preset: 'async', turnLimit: 20 })).json;
  await call('POST', `/api/matches/${r.id}/bots`, t1, { count: 1 });
  const [st, del] = await Promise.all([call('POST', `/api/matches/${r.id}/start`, t1), call('DELETE', `/api/matches/${r.id}`, t1)]);
  const { rows: [after] } = await db.query('SELECT phase, deleted_at FROM matches WHERE id=$1', [r.id]);
  if (after.deleted_at) {
    assert.equal(after.phase, 'lobby');
    assert.equal(del.json.ok, true);
    assert.equal(st.status, 404);
  } else {
    assert.equal(after.phase, 'planning');
    assert.equal(del.json.error, 'match_already_started');
  }
  // Активную партию создатель удалить не может.
  const a = (await call('POST', '/api/matches', t1, { preset: 'vsbot' })).json;
  assert.equal((await call('DELETE', `/api/matches/${a.id}`, t1)).json.error, 'match_already_started');
});

test('сдача: повторы безопасны, приказы отменены, ход идёт дальше без сдавшегося, архив только для себя', async () => {
  const t1 = await devLogin('Ира');
  const t2 = await devLogin('Олег');
  const m = (await call('POST', '/api/matches', t1, { preset: 'async', turnLimit: 20 })).json;
  await call('POST', '/api/matches/join', t2, { inviteCode: m.inviteCode });
  await call('POST', `/api/matches/${m.id}/bots`, t1, { count: 1 });
  await call('POST', `/api/matches/${m.id}/start`, t1);
  const s2 = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t2)).json;
  const p2 = s2.view.me.id;
  const u2 = s2.view.units.find(u => u.owner === p2)!;
  await call('POST', `/api/matches/${m.id}/orders`, t2, { turn: 1, order: { kind: 'unit', unitId: u2.id, mode: 'hold', path: [] }, idempotencyKey: randomUUID() });
  // Архивировать идущую партию нельзя.
  assert.equal((await call('POST', `/api/matches/${m.id}/archive`, t2)).json.error, 'match_in_progress');
  // Две сдачи одновременно (плохая связь) — одно поражение.
  const [a, b2] = await Promise.all([call('POST', `/api/matches/${m.id}/surrender`, t2), call('POST', `/api/matches/${m.id}/surrender`, t2)]);
  assert.deepEqual([a.json.already, b2.json.already].sort(), [false, true]);
  const { rows: ords } = await db.query(`SELECT subject, status FROM orders WHERE match_id=$1 AND player_id=$2 ORDER BY subject`, [m.id, p2]);
  assert.deepEqual(ords.map(o => `${o.subject}:${o.status}`), ['surrender:active', `unit:${u2.id}:cancelled`]);
  // Сдавшийся больше не командует и не мешает готовности.
  const rej = await call('POST', `/api/matches/${m.id}/orders`, t2, { turn: 1, order: { kind: 'unit', unitId: u2.id, mode: 'hold', path: [] }, idempotencyKey: randomUUID() });
  assert.equal(rej.json.reason, 'surrendered');
  assert.equal((await call('POST', `/api/matches/${m.id}/orders`, t1, { turn: 1, order: { kind: 'surrender' }, idempotencyKey: randomUUID() })).json.reason, 'use_surrender_endpoint');
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  assert.ok((await game.dueMatches()).some(x => x.id === m.id), 'ход готов к расчёту без сдавшегося');
  assert.ok(await game.processTurn(m.id, 1));
  await assertReplayable(m.id, 1);
  const st = await loadState(db, m.id);
  assert.equal(st.players.find(p => p.id === p2)!.eliminated, true);
  assert.equal(st.units.filter(u => u.owner === p2).length, 0);
  assert.equal(st.cities.filter(c => c.owner === p2).length, 0);
  const info = (await call('GET', `/api/matches/${m.id}`, t1)).json;
  assert.equal(info.phase, 'planning', 'остальные продолжают');
  assert.equal(info.players.find((p: { id: string }) => p.id === p2).surrendered, true);
  // Повторная сдача после расчёта — без изменений.
  assert.equal((await call('POST', `/api/matches/${m.id}/surrender`, t2)).json.already, true);
  // Архив: только для себя, можно вернуть.
  assert.equal((await call('POST', `/api/matches/${m.id}/archive`, t2)).json.ok, true);
  assert.ok(!(await call('GET', '/api/matches', t2)).json.matches.some((x: { id: string }) => x.id === m.id));
  assert.ok((await call('GET', '/api/matches?archived=1', t2)).json.matches.some((x: { id: string }) => x.id === m.id));
  assert.ok((await call('GET', '/api/matches', t1)).json.matches.some((x: { id: string }) => x.id === m.id), 'у других партия осталась');
  assert.equal((await call('DELETE', `/api/matches/${m.id}/archive`, t2)).json.ok, true);
  const mine = (await call('GET', '/api/matches', t2)).json.matches.find((x: { id: string }) => x.id === m.id);
  assert.equal(mine.me.surrendered, true);
  assert.equal(mine.me.archived, false);
});

test('сдача в партии один на один завершает её сразу', async () => {
  const t1 = await devLogin('Тимур');
  const m = (await call('POST', '/api/matches', t1, { preset: 'vsbot' })).json;
  const r = await call('POST', `/api/matches/${m.id}/surrender`, t1);
  assert.equal(r.json.ok, true);
  const info = (await call('GET', `/api/matches/${m.id}`, t1)).json;
  assert.equal(info.phase, 'finished');
  assert.equal(info.winners.length, 1);
  assert.notEqual(info.winners[0], info.players.find((p: { name: string }) => p.name === 'Тимур').id);
  assert.equal((await call('POST', `/api/matches/${m.id}/archive`, t1)).json.ok, true);
});

test('эксплуатация: сжатие ответов, оповещения администратору, обнаружение падения и зависших ходов', async () => {
  const { gunzipSync } = await import('node:zlib');
  const r = await app.inject({ method: 'GET', url: '/api/rules', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.headers['content-encoding'], 'gzip');
  const plain = JSON.parse(gunzipSync(r.rawPayload).toString());
  assert.equal(plain.version, BALANCE.version);

  const { Alerts } = await import('../../src/server/alerts.ts');
  const sent: { chat_id: number; text: string }[] = [];
  const bot = { api: async (_m: string, body: any) => sent.push(body) } as any;
  const alerts = new Alerts({ db, bot, admins: ['@Boss', '42'], log: () => {} });
  assert.equal(alerts.isAdmin({ id: 1, username: 'boss' }), true);
  assert.equal(alerts.isAdmin({ id: 42 }), true);
  assert.equal(alerts.isAdmin({ id: 7, username: 'stranger' }), false);
  await alerts.subscribe(5001, true);
  await alerts.subscribe(5001, true);
  assert.equal(await alerts.send('k', 'тест'), true);
  assert.equal(await alerts.send('k', 'повтор'), false, 'одинаковые оповещения не повторяются чаще порога');
  assert.equal(sent.length, 1);
  // Падение: старт без штатной остановки предыдущего запуска.
  await alerts.markStarted('d1');
  await alerts.markStopped();
  assert.equal(await alerts.markStarted('d2'), false, 'после штатной остановки — без оповещения');
  assert.equal(await alerts.markStarted('d3'), true, 'после падения — оповещение');
  assert.ok(sent.some(s => s.text.includes('после сбоя')));
  // Зависший ход: срок истёк давно, а расчёта нет.
  const t1 = await devLogin('Дежурный');
  const m = (await call('POST', '/api/matches', t1, { preset: 'vsbot' })).json;
  await db.query(`UPDATE matches SET deadline = now() - interval '30 minutes' WHERE id=$1`, [m.id]);
  assert.ok((await alerts.checkStuckTurns(10)).includes(m.id));
  assert.ok(sent.some(s => s.text.includes(m.id)));
  await alerts.subscribe(5001, false);
});

test('обучение: фиксированная карта, цель рядом со столицей, пассивный противник', async () => {
  const t1 = await devLogin('Ученик');
  const m = (await call('POST', '/api/matches', t1, { preset: 'tutorial', faction: 'union' })).json;
  assert.equal(m.phase, 'planning');
  const s = (await call<StateResponse>('GET', `/api/matches/${m.id}/state`, t1)).json;
  const cap = s.view.cities.find(c => c.owner === s.view.me.id && c.isCapital)!;
  const target = s.view.units.find(u => u.owner !== s.view.me.id && u.type === 'scout')!;
  assert.ok(target, 'разведчик противника виден');
  assert.equal(target.hp, 3);
  assert.equal(Math.max(Math.abs(target.x - cap.x), Math.abs(target.y - cap.y)), 2);
  await call('POST', `/api/matches/${m.id}/ready`, t1, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM orders WHERE match_id=$1 AND idempotency_key LIKE 'bot-%'`, [m.id]);
  assert.equal(rows[0].n, 0, 'противник в обучении не действует');
  const { rows: [seed] } = await db.query('SELECT seed FROM matches WHERE id=$1', [m.id]);
  assert.equal(seed.seed, 'tutorial-1');
});

test('итоги и рейтинг: партия двух людей меняет рейтинг один раз, боты не в счёт; повтор хода и таблица', async () => {
  const ta = await devLogin('Аня');
  const tb = await devLogin('Борис');
  const m = (await call('POST', '/api/matches', ta, { preset: 'async', turnLimit: 20 })).json;
  await call('POST', '/api/matches/join', tb, { inviteCode: m.inviteCode });
  await call('POST', `/api/matches/${m.id}/start`, ta);
  await call('POST', `/api/matches/${m.id}/ready`, ta, { turn: 1, ready: true });
  await call('POST', `/api/matches/${m.id}/ready`, tb, { turn: 1, ready: true });
  assert.ok(await game.processTurn(m.id, 1));
  // Повтор рассчитанного хода доступен, нерассчитанного — нет.
  const rp = (await call('GET', `/api/matches/${m.id}/replay?turn=1`, ta)).json;
  assert.equal(rp.turn, 1);
  assert.equal(rp.before.view.turn, 1);
  assert.equal(rp.after.view.turn, 2);
  assert.ok(Array.isArray(rp.events));
  assert.equal((await call('GET', `/api/matches/${m.id}/replay?turn=2`, ta)).json.error, 'turn_not_resolved');
  assert.equal((await call('GET', `/api/matches/${m.id}/summary`, ta)).json.error, 'match_in_progress');
  // Борис сдаётся — партия завершается, Аня выигрывает.
  await call('POST', `/api/matches/${m.id}/surrender`, tb);
  const sum = (await call('GET', `/api/matches/${m.id}/summary`, ta)).json;
  const pa = sum.players.find((p: { name: string }) => p.name === 'Аня');
  const pb = sum.players.find((p: { name: string }) => p.name === 'Борис');
  assert.deepEqual(sum.winners, [pa.id]);
  assert.equal(pa.rating.after - pa.rating.before, 16);
  assert.equal(pb.rating.after - pb.rating.before, -16);
  assert.equal(pb.surrendered, true);
  // Повторная запись итогов ничего не меняет.
  const { withTx } = await import('../../src/server/db/pool.ts');
  await withTx(db, tx => game.recordResults(tx, m.id, [pa.id]));
  const lb = (await call('GET', '/api/leaderboard', ta)).json;
  assert.equal(lb.me.rating, pa.rating.after);
  assert.equal(lb.me.games, 1);
  assert.ok(lb.top.some((r: { name: string; me: boolean }) => r.me));
  // Партия с ботом не рейтинговая.
  const tc = await devLogin('Вика');
  const v = (await call('POST', '/api/matches', tc, { preset: 'vsbot' })).json;
  await call('POST', `/api/matches/${v.id}/surrender`, tc);
  const sv = (await call('GET', `/api/matches/${v.id}/summary`, tc)).json;
  const me = sv.players.find((p: { name: string }) => p.name === 'Вика');
  assert.equal(me.rating.rated, false);
  assert.equal(me.rating.after, me.rating.before);
});
