import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurn, incomeFor } from '../../src/engine/resolve.ts';
import { computeDamage } from '../../src/engine/combat.ts';
import { computeVision } from '../../src/engine/vision.ts';
import { validateOrder } from '../../src/engine/validate.ts';
import type { ValidationResult } from '../../src/engine/validate.ts';
import { moveOf } from '../../src/engine/stats.ts';
import { linkedObelisks, rollWorldEvent } from '../../src/engine/world.ts';
import { playerView } from '../../src/engine/view.ts';
import { moveOptions } from '../../src/engine/preview.ts';
import { Feature, Terrain } from '../../src/shared/types.ts';
import type { GameState, Order, UnitOrder } from '../../src/shared/types.ts';
import { attack, b, flatState, hold, move, so, unit } from '../helpers.ts';

const mods = (r: { modifiers: { id: string }[] }) => r.modifiers.map(m => m.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (r: { events: { event: { t: string }; visibleTo: string[] }[] }, t: string) => r.events.filter(e => e.event.t === t) as { event: any; visibleTo: string[] }[];
const reason = (r: ValidationResult) => (r.ok ? 'ok' : r.reason);
const build = (unitId: string, kind: UnitOrder['build']): UnitOrder => ({ kind: 'unit', unitId, mode: 'build', build: kind, path: [] });

/** Суша x<6, глубокая вода x>=6 (мелководье на x=6). */
type Opts = NonNullable<Parameters<typeof flatState>[0]>;
function coastState(units: Opts['units'], extra: Partial<Opts> = {}): GameState {
  const terrain: { x: number; y: number; t: number }[] = [];
  for (let y = 0; y < 8; y++) for (let x = 6; x < 14; x++) terrain.push({ x, y, t: x === 6 ? Terrain.ShallowWater : Terrain.DeepWater });
  return flatState({ w: 14, h: 8, terrain, units, noCommanders: true, ...extra });
}

// ---------- Флот ----------

test('корабль ходит только по воде; сухопутный путь кораблю недоступен', () => {
  const s = coastState([{ id: 't', owner: 'A', type: 'transport', x: 7, y: 2 }]);
  const v = computeVision(b, s, 'A');
  assert.equal(validateOrder(b, s, 'A', move('t', [[6, 2], [5, 2]]), v).ok, false);
  const r = resolveTurn(b, s, [so('A', move('t', [[8, 2], [9, 3], [10, 3], [11, 3]]))]);
  assert.deepEqual([unit(r.state, 't')!.x, unit(r.state, 't')!.y], [11, 3]);
});

test('погрузка, перевозка, высадка; противник видит только число отрядов на борту', () => {
  const s = coastState([
    { id: 'a1', owner: 'A', type: 'infantry', x: 5, y: 2 },
    { id: 't', owner: 'A', type: 'transport', x: 6, y: 2 },
    { id: 'w', owner: 'B', type: 'warship', x: 9, y: 6 },
  ]);
  const v = computeVision(b, s, 'A');
  // Погрузка разрешена только приказом «движение».
  assert.equal(validateOrder(b, s, 'A', attack('a1', 'w', [[6, 2]]), v).ok, false);
  const r1 = resolveTurn(b, s, [so('A', move('a1', [[6, 2]])), so('A', hold('t'))]);
  assert.equal(unit(r1.state, 'a1')!.carriedBy, 't');
  assert.equal(ev(r1, 'embarked').length, 1);
  // Транспорт плывёт — груз вместе с ним.
  const r2 = resolveTurn(b, r1.state, [so('A', move('t', [[7, 3], [8, 4], [9, 5]]))]);
  assert.deepEqual([unit(r2.state, 'a1')!.x, unit(r2.state, 'a1')!.y], [9, 5]);
  const vb = playerView(b, r2.state, 'B');
  assert.equal(vb.units.some(u => u.id === 'a1'), false, 'груз не виден противнику');
  assert.equal(vb.units.find(u => u.id === 't')?.cargo, 1);
  // Груз нельзя атаковать.
  assert.equal(validateOrder(b, r2.state, 'B', attack('w', 'a1'), computeVision(b, r2.state, 'B')).ok, false);
  // Высадка: один шаг на соседнюю сушу.
  const r3 = resolveTurn(b, r2.state, [so('A', move('t', [[8, 4], [7, 3], [6, 2]]))]);
  const v3 = computeVision(b, r3.state, 'A');
  assert.equal(validateOrder(b, r3.state, 'A', move('a1', [[5, 2], [4, 2]]), v3).ok, false, 'высадка — только один шаг');
  const opts = moveOptions(b, r3.state, 'A', 'a1', v3);
  assert.ok(opts.length > 0 && opts.every(o => o.disembark));
  const r4 = resolveTurn(b, r3.state, [so('A', move('a1', [[5, 3]]))]);
  const a1 = unit(r4.state, 'a1')!;
  assert.equal(a1.carriedBy, undefined);
  assert.deepEqual([a1.x, a1.y], [5, 3]);
  assert.equal(ev(r4, 'disembarked').length, 1);
});

test('вместимость транспорта; погрузка не удаётся, если транспорт уходит', () => {
  const s = coastState([
    { id: 'a1', owner: 'A', type: 'infantry', x: 5, y: 1 },
    { id: 'a2', owner: 'A', type: 'infantry', x: 5, y: 2 },
    { id: 'a3', owner: 'A', type: 'infantry', x: 5, y: 3 },
    { id: 't', owner: 'A', type: 'transport', x: 6, y: 2 },
  ]);
  const v = computeVision(b, s, 'A');
  const o1 = move('a1', [[6, 2]]), o2 = move('a2', [[6, 2]]), o3 = move('a3', [[6, 2]]);
  assert.equal(reason(validateOrder(b, s, 'A', o3, v, [o1, o2])), 'transport_full');
  // В расчёте третий отряд блокируется, даже если приказ прошёл проверку раньше.
  const r = resolveTurn(b, s, [so('A', o1), so('A', o2)]);
  assert.equal(r.state.units.filter(u => u.carriedBy === 't').length, 2);
  const s2 = coastState([{ id: 'a1', owner: 'A', type: 'infantry', x: 5, y: 2 }, { id: 't', owner: 'A', type: 'transport', x: 6, y: 2 }]);
  const r2 = resolveTurn(b, s2, [so('A', move('a1', [[6, 2]])), so('A', move('t', [[7, 2]]))]);
  assert.equal(unit(r2.state, 'a1')!.carriedBy, undefined);
  assert.ok(ev(r2, 'move_blocked').some(e => (e.event as { reason: string }).reason === 'transport_left'));
});

test('гибель транспорта топит груз', () => {
  const s = coastState([
    { id: 'a1', owner: 'A', type: 'infantry', x: 8, y: 2, carriedBy: 't' },
    { id: 't', owner: 'A', type: 'transport', x: 8, y: 2, hp: 1 },
    { id: 'w', owner: 'B', type: 'warship', x: 10, y: 2 },
  ]);
  const r = resolveTurn(b, s, [so('B', attack('w', 't'))]);
  assert.equal(unit(r.state, 't'), undefined);
  assert.equal(unit(r.state, 'a1'), undefined);
  assert.equal(ev(r, 'unit_destroyed').length, 2);
});

test('порт: только в прибрежном городе; флот нанимается только при порте и появляется на воде', () => {
  const s = coastState([], { cities: [{ id: 'c1', owner: 'A', x: 5, y: 3, level: 2 }, { id: 'c2', owner: 'A', x: 1, y: 3, level: 2 }] });
  s.players[0].researched.push('navigation');
  const v = computeVision(b, s, 'A');
  assert.equal(reason(validateOrder(b, s, 'A', { kind: 'construct', cityId: 'c2', building: 'port' }, v)), 'not_coastal');
  assert.equal(reason(validateOrder(b, s, 'A', { kind: 'recruit', cityId: 'c1', unitType: 'transport' }, v)), 'needs_port');
  s.cities[0].buildings.push('port');
  let st = resolveTurn(b, s, [so('A', { kind: 'recruit', cityId: 'c1', unitType: 'transport' })]).state;
  for (let i = 0; i < 4 && !st.units.some(u => u.type === 'transport'); i++) st = resolveTurn(b, st, []).state;
  const t = st.units.find(u => u.type === 'transport')!;
  assert.ok(t, 'транспорт построен');
  assert.ok(st.map.terrain[t.y * st.map.width + t.x] <= Terrain.ShallowWater);
});

// ---------- Пепельные орды ----------

test('Пепельные орды: натиск после уничтожения врага даёт +1 к движению на следующий ход', () => {
  const s = flatState({ factions: { A: 'ash' }, noCommanders: true, units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 3, y: 3 },
    { id: 'b1', owner: 'B', type: 'scout', x: 4, y: 3, hp: 1 },
  ] });
  const r = resolveTurn(b, s, [so('A', attack('a1', 'b1'))]);
  const a1 = unit(r.state, 'a1')!;
  assert.ok(a1.statuses.some(x => x.id === 'momentum'));
  assert.equal(moveOf(b, r.state, a1), b.units.infantry.move + 1);
  const v = computeVision(b, r.state, 'A');
  assert.equal(validateOrder(b, r.state, 'A', move('a1', [[4, 3], [5, 3], [6, 3]]), v).ok, true);
  const r2 = resolveTurn(b, r.state, []);
  const r3 = resolveTurn(b, r2.state, []);
  assert.equal(moveOf(b, r3.state, unit(r3.state, 'a1')!), b.units.infantry.move, 'натиск проходит');
});

test('Пепельные орды: выжженная земля, добыча при захвате, цена широкого фронта', () => {
  const s = flatState({ factions: { A: 'ash' }, noCommanders: true, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 4, y: 4 }],
    terrain: [{ x: 4, y: 4, t: Terrain.Forest }], cities: [{ id: 'cb', owner: 'B', x: 6, y: 4, level: 2, food: 6 }, { id: 'ca', owner: 'A', x: 0, y: 0 }] });
  s.map.features[4 * s.map.width + 4] |= Feature.Road;
  const v = computeVision(b, s, 'A');
  assert.equal(validateOrder(b, s, 'A', build('a1', 'scorch'), v).ok, true);
  const gold = s.players[0].gold;
  const r = resolveTurn(b, s, [so('A', build('a1', 'scorch'))]);
  const i = 4 * s.map.width + 4;
  assert.equal(r.state.map.terrain[i], Terrain.Plains);
  assert.equal(r.state.map.features[i] & Feature.Road, 0);
  const e = ev(r, 'scorched')[0].event as { foodLost: number; gold: number; cityId: string };
  assert.equal(e.foodLost, b.scorch.foodLoss);
  assert.equal(e.cityId, 'cb');
  assert.equal(e.gold, b.scorch.gold);
  assert.ok(ev(r, 'scorched')[0].visibleTo.includes('B'), 'пострадавший видит поджог');
  void gold;
  // Другие народы так не умеют.
  const s2 = flatState({ noCommanders: true, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 4, y: 4 }], terrain: [{ x: 4, y: 4, t: Terrain.Forest }] });
  assert.equal(reason(validateOrder(b, s2, 'A', build('a1', 'scorch'), computeVision(b, s2, 'A'))), 'unit_cannot_build');
  // Добыча при захвате.
  const s3 = flatState({ factions: { A: 'ash' }, noCommanders: true, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 5, y: 5 }],
    cities: [{ id: 'cb', owner: 'B', x: 5, y: 5, level: 3, contestedBy: 'A', contestedSinceTurn: 0 }] });
  const r3 = resolveTurn(b, s3, []);
  const pl = ev(r3, 'plunder')[0]?.event as { gold: number } | undefined;
  assert.equal(pl?.gold, b.factions.ash.traits.plunderGold! * 3);
  // Широкий фронт: города сверх предела стоят золота.
  const many = flatState({ factions: { A: 'ash', B: 'union' }, noCommanders: true, cities: Array.from({ length: 6 }, (_, k) => ({ id: `c${k}`, owner: 'A', x: k * 2, y: 0 })) });
  const tr = b.factions.ash.traits;
  assert.equal(incomeFor(b, many, 'A').upkeep, (6 - tr.frontLimit!) * tr.frontPenaltyGold!);
});

test('Метатель огня поджигает цель в лесу; боевой клич в модификаторах', () => {
  const s = flatState({ factions: { A: 'ash' }, noCommanders: true, units: [
    { id: 'f', owner: 'A', type: 'firebrand', x: 2, y: 2 },
    { id: 't1', owner: 'B', type: 'infantry', x: 4, y: 2 },
  ], terrain: [{ x: 4, y: 2, t: Terrain.Forest }] });
  const r = computeDamage(b, s, unit(s, 'f')!, unit(s, 't1')!, undefined, undefined, { warcry: new Set(['f']) });
  assert.ok(mods(r).includes('incendiary'));
  assert.ok(mods(r).includes('warcry'));
});

// ---------- Хранители руин ----------

test('Хранители руин: обелиск связывается с городом, даёт обзор, снабжение и резонанс; без узла — ослабление', () => {
  const s = flatState({ w: 20, h: 8, factions: { A: 'ruins' }, noCommanders: true, cities: [{ id: 'ca', owner: 'A', x: 1, y: 1 }],
    units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 6, y: 1 }, { id: 'a2', owner: 'A', type: 'infantry', x: 15, y: 5 }, { id: 'b1', owner: 'B', type: 'infantry', x: 16, y: 5 }] });
  const v = computeVision(b, s, 'A');
  assert.equal(validateOrder(b, s, 'A', build('a1', 'obelisk'), v).ok, true);
  const r = resolveTurn(b, s, [so('A', build('a1', 'obelisk'))]);
  assert.equal(r.state.world.structures.length, 1);
  assert.equal(linkedObelisks(b, r.state, 'A').length, 1);
  // Отряд рядом с обелиском — резонанс; далеко — «без узла».
  const near = computeDamage(b, r.state, unit(r.state, 'a1')!, unit(r.state, 'b1')!);
  assert.ok(mods(near).includes('resonance'));
  const far = computeDamage(b, r.state, unit(r.state, 'a2')!, unit(r.state, 'b1')!);
  assert.ok(mods(far).includes('severed'));
  // Дальний обелиск без цепочки не подключён.
  const s2 = structuredClone(r.state);
  s2.world.structures.push({ id: 's99', kind: 'obelisk', owner: 'A', x: 16, y: 1, builtTurn: 1 });
  assert.equal(linkedObelisks(b, s2, 'A').length, 1);
  assert.equal(playerView(b, s2, 'A').structures.find(x => x.id === 's99')!.linked, false);
  // Слишком близко к другому обелиску строить нельзя.
  assert.equal(reason(validateOrder(b, r.state, 'A', build('a1', 'obelisk'), computeVision(b, r.state, 'A'))), 'structure_exists');
});

test('обелиск разрушается, если на нём заканчивает ход противник; обелиск на руинах даёт знания', () => {
  const s = flatState({ factions: { A: 'ruins' }, noCommanders: true, cities: [{ id: 'ca', owner: 'A', x: 1, y: 1 }],
    units: [{ id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 3 }] });
  s.world.structures.push({ id: 's1', kind: 'obelisk', owner: 'A', x: 4, y: 4, builtTurn: 1 });
  const base = incomeFor(b, s, 'A').knowledge;
  s.map.features[4 * s.map.width + 4] |= Feature.Ruins;
  assert.equal(incomeFor(b, s, 'A').knowledge, base + b.obelisks.ruinsKnowledge);
  const r = resolveTurn(b, s, [so('B', move('b1', [[4, 4]]))]);
  assert.equal(r.state.world.structures.length, 0);
  assert.equal(ev(r, 'structure_destroyed').length, 1);
});

test('руины: награда первому отряду, повторно — нет; Хранителям руин — двойная', () => {
  const mk = (faction: string) => {
    const s = flatState({ factions: { A: faction }, noCommanders: true, units: [{ id: 'a1', owner: 'A', type: 'scout', x: 2, y: 2 }] });
    s.map.features[2 * s.map.width + 3] |= Feature.Ruins;
    return s;
  };
  const r = resolveTurn(b, mk('union'), [so('A', move('a1', [[3, 2]]))]);
  const e = ev(r, 'ruins_looted');
  assert.equal(e.length, 1);
  const amount = (e[0].event as { amount: number }).amount;
  const r2 = resolveTurn(b, r.state, [so('A', move('a1', [[2, 2]]))]);
  const r3 = resolveTurn(b, r2.state, [so('A', move('a1', [[3, 2]]))]);
  assert.equal(ev(r3, 'ruins_looted').length, 0);
  const rr = resolveTurn(b, mk('ruins'), [so('A', move('a1', [[3, 2]]))]);
  assert.equal((ev(rr, 'ruins_looted')[0].event as { amount: number }).amount, amount * 2);
});

// ---------- Мировые события ----------

test('мировые события детерминированы, объявляются всем и действуют', () => {
  const seq = (seed: string) => Array.from({ length: 60 }, (_, t) => rollWorldEvent(b, seed, t));
  assert.deepEqual(seq('x'), seq('x'));
  assert.ok(seq('x').some(Boolean), 'за 60 ходов есть события');
  // Принудительно включаем туман и проверяем обзор.
  const s = flatState({ noCommanders: true, units: [{ id: 'a1', owner: 'A', type: 'scout', x: 5, y: 5 }] });
  const before = computeVision(b, s, 'A').visible.reduce((a, x) => a + x, 0);
  s.world.events.push({ id: 'fog', startTurn: 1, endTurn: 2 });
  const after = computeVision(b, s, 'A').visible.reduce((a, x) => a + x, 0);
  assert.ok(after < before);
  assert.equal(playerView(b, s, 'A').worldEvents[0].id, 'fog');
  // Событие заканчивается и объявляется.
  const r = resolveTurn(b, s, []);
  const r2 = resolveTurn(b, r.state, []);
  assert.ok(ev(r2, 'world_event').some(e => (e.event as { phase: string }).phase === 'end'));
  // Найдём ход, на который выпадает событие, и проверим объявление.
  const seed = s.map.seed;
  const turn = Array.from({ length: 80 }, (_, t) => t).find(t => t > 1 && rollWorldEvent(b, seed, t))!;
  const s3 = structuredClone(s);
  s3.world.events = [];
  s3.turn = turn - 1;
  const r3 = resolveTurn(b, s3, []);
  const start = ev(r3, 'world_event').find(e => (e.event as { phase: string }).phase === 'start');
  assert.ok(start && start.visibleTo.includes('A') && start.visibleTo.includes('B'));
});

test('всплеск резонанса лечит в поле обелисков даже после боя', () => {
  const s = flatState({ factions: { A: 'ruins' }, cities: [{ id: 'ca', owner: 'A', x: 1, y: 1 }],
    units: [{ id: 'cmd', owner: 'A', type: 'commander', x: 3, y: 3 }, { id: 'a1', owner: 'A', type: 'infantry', x: 4, y: 4, hp: 5 }, { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 4, hp: 2 }] });
  s.world.structures.push({ id: 's1', kind: 'obelisk', owner: 'A', x: 4, y: 3, builtTurn: 1 });
  s.players[0].commander.points = 5;
  const orders: Order[] = [{ kind: 'commander', action: 'ability', ability: 'resonance_surge' }, attack('a1', 'b1')];
  const r = resolveTurn(b, s, orders.map(o => so('A', o)));
  assert.ok(ev(r, 'healed').some(e => (e.event as { unitId: string }).unitId === 'a1'));
});

// ---------- Архипелаг и боты ----------

test('архипелаг: боты строят порт и транспорты, переправляются; расчёт детерминирован', async () => {
  const { createInitialState } = await import('../../src/worldgen/setup.ts');
  const { botOrders } = await import('../../src/ai/simple.ts');
  const { stableStringify } = await import('../../src/engine/canonical.ts');
  const { stateToJson } = await import('../../src/server/store.ts');
  const spec = { ...b.map.presets.archipelago64, seed: 'isl-0' };
  const players = ['union', 'ash', 'ruins', 'tide'].map((f, i) => ({ id: `p${i + 1}`, name: f, faction: f, isBot: true }));
  const run = () => {
    let s = createInitialState(b, { matchId: 'isl', spec, players, mode: { victory: 'elimination', turnLimit: null, alliances: false } }).state;
    let embarked = 0, ports = 0;
    for (let t = 0; t < 45; t++) {
      const orders = s.players.flatMap(p => botOrders(b, s, p.id).map((o, k) => ({ id: `${s.turn}-${p.id}-${k}`, playerId: p.id, order: o })));
      const r = resolveTurn(b, s, orders);
      embarked += ev(r, 'embarked').length;
      ports += ev(r, 'building_completed').filter(e => e.event.building === 'port').length;
      s = r.state;
    }
    return { s, embarked, ports };
  };
  const a = run();
  assert.ok(a.ports >= 1, 'построен порт');
  assert.ok(a.embarked >= 1, 'была погрузка');
  const c = run();
  assert.equal(stableStringify(stateToJson(a.s)), stableStringify(stateToJson(c.s)));
});
