import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCost, resolveTurn } from '../../src/engine/resolve.ts';
import { computeVision } from '../../src/engine/vision.ts';
import { validateOrder } from '../../src/engine/validate.ts';
import { landMoveCost } from '../../src/engine/grid.ts';
import { Feature, Terrain } from '../../src/shared/types.ts';
import type { UnitOrder } from '../../src/shared/types.ts';
import { b, flatState, hold, so, unit } from '../helpers.ts';

const route = (unitId: string, path: [number, number][], stopOnThreat = true): UnitOrder =>
  ({ kind: 'unit', unitId, mode: 'move', longRoute: true, stopOnThreat, path: path.map(([x, y]) => ({ x, y })) });

function exploreAll(s: ReturnType<typeof flatState>) {
  for (const p of s.players) s.explored[p.id].fill(1);
}

test('долгий маршрут продолжается в следующих ходах без новых приказов и завершается', () => {
  const s = flatState({ w: 20, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 0, y: 2 }, { id: 'z', owner: 'B', x: 19, y: 5 }] });
  exploreAll(s);
  const path: [number, number][] = [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2]];
  const r1 = resolveTurn(b, s, [so('A', route('a1', path))]);
  assert.equal(unit(r1.state, 'a1')!.x, 2);
  assert.equal(unit(r1.state, 'a1')!.route!.path.length, 4);
  const r2 = resolveTurn(b, r1.state, []);
  assert.equal(unit(r2.state, 'a1')!.x, 4);
  assert.ok(r2.events.some(e => e.event.t === 'route_continued'));
  const r3 = resolveTurn(b, r2.state, []);
  assert.equal(unit(r3.state, 'a1')!.x, 6);
  assert.equal(unit(r3.state, 'a1')!.route, null);
  assert.ok(r3.events.some(e => e.event.t === 'route_completed'));
});

test('маршрут по неисследованным клеткам отклоняется (не раскрывает местность)', () => {
  const s = flatState({ w: 30, h: 4, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 0, y: 1 }] });
  const path = Array.from({ length: 20 }, (_, i) => [i + 1, 1] as [number, number]);
  const v = computeVision(b, s, 'A');
  assert.deepEqual(validateOrder(b, s, 'A', route('a1', path), v), { ok: false, reason: 'route_through_unexplored' });
});

test('маршрут останавливается при появлении противника рядом', () => {
  const s = flatState({ w: 20, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 0, y: 2 }, { id: 'b1', owner: 'B', type: 'infantry', x: 6, y: 2 }] });
  exploreAll(s);
  // b1 виден (обзор 2 + клетка), но не в радиусе угрозы 3 на старте: расстояние 6.
  const r1 = resolveTurn(b, s, [so('A', route('a1', [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2]]))]);
  // после хода a1 на x=2, противник на расстоянии 4 → маршрут ещё жив
  assert.ok(unit(r1.state, 'a1')!.route);
  const r2 = resolveTurn(b, r1.state, [so('B', { kind: 'unit', unitId: 'b1', mode: 'move', path: [{ x: 5, y: 2 }] })]);
  const paused = [...r1.events, ...r2.events].find(e => e.event.t === 'route_paused');
  assert.ok(paused && paused.event.t === 'route_paused' && paused.event.reason === 'threat');
  assert.equal(unit(r2.state, 'a1')!.route, null);
});

test('без остановки при угрозе маршрут продолжается', () => {
  const s = flatState({ w: 20, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 0, y: 2 }, { id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 5 }] });
  exploreAll(s);
  const r1 = resolveTurn(b, s, [so('A', route('a1', [[1, 2], [2, 2], [3, 2], [4, 2]], false))]);
  const r2 = resolveTurn(b, r1.state, []);
  assert.equal(unit(r2.state, 'a1')!.x, 4);
});

test('новый явный приказ отменяет маршрут', () => {
  const s = flatState({ w: 20, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 0, y: 2 }, { id: 'z', owner: 'B', x: 19, y: 5 }] });
  exploreAll(s);
  const r1 = resolveTurn(b, s, [so('A', route('a1', [[1, 2], [2, 2], [3, 2], [4, 2]]))]);
  const r2 = resolveTurn(b, r1.state, [so('A', hold('a1'))]);
  assert.equal(unit(r2.state, 'a1')!.x, 2);
  assert.equal(unit(r2.state, 'a1')!.route, null);
});

test('дорога строится за ход, золото списывается один раз, движение по дороге дешевле', () => {
  const s = flatState({ w: 12, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 3, y: 2 }, { id: 'z', owner: 'B', x: 11, y: 5 }], cities: [{ id: 'ca', owner: 'A', x: 2, y: 2 }] });
  s.map.features[2 * 12 + 2] |= Feature.Road; // дорога в городе
  const gold0 = s.players[0].gold;
  const r = resolveTurn(b, s, [so('A', { kind: 'unit', unitId: 'a1', mode: 'build', build: 'road', path: [] })]);
  assert.ok(r.state.map.features[2 * 12 + 3] & Feature.Road);
  assert.ok(r.events.some(e => e.event.t === 'road_built'));
  const inc = r.events.find(e => e.event.t === 'income' && e.event.playerId === 'A')!.event as any;
  assert.equal(r.state.players[0].gold, gold0 - buildCost(b, s, 'A', 'road').gold + inc.gold - inc.upkeep);
  assert.equal(landMoveCost(b, r.state.map, { x: 2, y: 2 }, { x: 3, y: 2 }), b.roadMoveCost);
  // Исходное состояние не изменилось (расчёт чистый).
  assert.equal(s.map.features[2 * 12 + 3] & Feature.Road, 0);
});

test('строить можно только на своей территории и не на воде', () => {
  const s = flatState({ w: 20, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 15, y: 2 }, { id: 'a2', owner: 'A', type: 'scout', x: 3, y: 3 }], cities: [{ id: 'ca', owner: 'A', x: 2, y: 2 }], terrain: [{ x: 1, y: 1, t: Terrain.ShallowWater }] });
  const v = computeVision(b, s, 'A');
  const build = (id: string) => ({ kind: 'unit' as const, unitId: id, mode: 'build' as const, build: 'road' as const, path: [] });
  assert.deepEqual(validateOrder(b, s, 'A', build('a1'), v), { ok: false, reason: 'outside_territory' });
  assert.deepEqual(validateOrder(b, s, 'A', build('a2'), v), { ok: false, reason: 'unit_cannot_build' });
});

test('строитель погиб — дорога не появляется', () => {
  const s = flatState({ w: 12, h: 6, units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 3, y: 2, hp: 1 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 2 },
  ], cities: [{ id: 'ca', owner: 'A', x: 2, y: 2 }] });
  const r = resolveTurn(b, s, [so('A', { kind: 'unit', unitId: 'a1', mode: 'build', build: 'road', path: [] }), so('B', { kind: 'unit', unitId: 'b1', mode: 'attack', targetUnitId: 'a1', path: [] })]);
  assert.equal(r.state.map.features[2 * 12 + 3] & Feature.Road, 0);
  assert.ok(r.events.some(e => e.event.t === 'build_failed'));
});
