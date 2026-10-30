import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurn } from '../../src/engine/resolve.ts';
import { computeVision } from '../../src/engine/vision.ts';
import { playerView, eventsFor } from '../../src/engine/view.ts';
import { validateOrder } from '../../src/engine/validate.ts';
import { previewAttack } from '../../src/engine/preview.ts';
import { Terrain } from '../../src/shared/types.ts';
import { newCity } from '../../src/engine/factory.ts';
import { attack, b, flatState, hold, move, so, unit } from '../helpers.ts';

test('два отряда претендуют на одну клетку: побеждает инициатива, проигравший остаётся', () => {
  const s = flatState({ units: [
    { id: 'sc', owner: 'A', type: 'scout', x: 2, y: 5 },
    { id: 'in', owner: 'B', type: 'infantry', x: 4, y: 5 },
  ] });
  const r = resolveTurn(b, s, [so('A', move('sc', [[3, 5]])), so('B', move('in', [[3, 5]]))]);
  assert.deepEqual([unit(r.state, 'sc')!.x, unit(r.state, 'sc')!.y], [3, 5]);
  assert.deepEqual([unit(r.state, 'in')!.x, unit(r.state, 'in')!.y], [4, 5]);
  const blocked = r.events.find(e => e.event.t === 'move_blocked');
  assert.equal(blocked?.event.t === 'move_blocked' && blocked.event.reason, 'contested_tile');
});

test('равная инициатива разрешается воспроизводимо по seed хода', () => {
  const mk = () => flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 5 },
  ] });
  const orders = () => [so('A', move('a1', [[3, 5]])), so('B', move('b1', [[3, 5]]))];
  const r1 = resolveTurn(b, mk(), orders());
  const r2 = resolveTurn(b, mk(), orders());
  const pos = (r: typeof r1) => r.state.units.map(u => `${u.id}:${u.x},${u.y}`).join(' ');
  assert.equal(pos(r1), pos(r2));
  assert.equal(r1.state.units.filter(u => u.x === 3 && u.y === 5).length, 1);
});

test('полный результат расчёта детерминирован', () => {
  const mk = () => flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 5 },
    { id: 'a2', owner: 'A', type: 'scout', x: 2, y: 6 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 5 },
  ], cities: [{ owner: 'A', x: 1, y: 1, level: 2 }, { owner: 'B', x: 9, y: 9, level: 2 }] });
  const orders = () => [so('A', attack('a1', 'b1', [[3, 5], [4, 5]])), so('A', move('a2', [[3, 6], [4, 6]])), so('B', hold('b1'))];
  const ser = (r: ReturnType<typeof resolveTurn>) => JSON.stringify({ u: r.state.units, p: r.state.players, e: r.events });
  assert.equal(ser(resolveTurn(b, mk(), orders())), ser(resolveTurn(b, mk(), orders())));
});

test('цель ушла из зоны — атака не превращается в преследование', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 5 },
    { id: 'b1', owner: 'B', type: 'scout', x: 3, y: 5 },
  ] });
  const r = resolveTurn(b, s, [so('A', attack('a1', 'b1')), so('B', move('b1', [[4, 5], [5, 5], [6, 5]]))]);
  assert.deepEqual([unit(r.state, 'a1')!.x, unit(r.state, 'a1')!.y], [2, 5]);
  const fail = r.events.find(e => e.event.t === 'attack_failed');
  assert.ok(fail && fail.event.t === 'attack_failed' && fail.event.reason === 'target_out_of_range');
  assert.equal(unit(r.state, 'b1')!.hp, b.units.scout.hp);
});

test('встречная атака одной ступени — одновременный обмен ударами без контратак', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 3, y: 5 },
  ] });
  const r = resolveTurn(b, s, [so('A', attack('a1', 'b1')), so('B', attack('b1', 'a1'))]);
  const atk = r.events.filter(e => e.event.t === 'attack');
  assert.equal(atk.length, 2);
  assert.ok(atk.every(e => e.event.t === 'attack' && e.event.kind === 'exchange'));
  assert.equal(unit(r.state, 'a1')!.hp, unit(r.state, 'b1')!.hp);
});

test('юнит погибает до своей ступени инициативы и не атакует', () => {
  const s = flatState({ units: [
    { id: 'sp', owner: 'A', type: 'spearman', x: 2, y: 5 }, // инициатива 3
    { id: 'ar', owner: 'B', type: 'archer', x: 3, y: 5, hp: 1 }, // инициатива 1
  ] });
  s.players[0].researched.push('spearcraft');
  s.players[1].researched.push('archery');
  const r = resolveTurn(b, s, [so('A', attack('sp', 'ar')), so('B', attack('ar', 'sp'))]);
  assert.equal(unit(r.state, 'ar'), undefined);
  assert.equal(unit(r.state, 'sp')!.hp, b.units.spearman.hp);
  assert.equal(r.events.filter(e => e.event.t === 'attack').length, 1);
});

test('контратака только в допустимой дистанции', () => {
  const s = flatState({ units: [
    { id: 'ar', owner: 'A', type: 'archer', x: 2, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 5 },
  ] });
  s.players[0].researched.push('archery');
  const r = resolveTurn(b, s, [so('A', attack('ar', 'b1'))]);
  assert.ok(!r.events.some(e => e.event.t === 'attack' && e.event.kind === 'counter'));
  assert.equal(unit(r.state, 'ar')!.hp, b.units.archer.hp);

  const s2 = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 3, y: 5 },
  ] });
  const r2 = resolveTurn(b, s2, [so('A', attack('a1', 'b1'))]);
  assert.ok(r2.events.some(e => e.event.t === 'attack' && e.event.kind === 'counter'));
});

test('захват города оспаривается и завершается только после удержания', () => {
  const s = flatState({ units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 4, y: 5 }], cities: [{ id: 'cb', owner: 'B', x: 5, y: 5, level: 2 }, { id: 'ca', owner: 'A', x: 0, y: 0 }] });
  const r1 = resolveTurn(b, s, [so('A', move('a1', [[5, 5]]))]);
  const c1 = r1.state.cities.find(c => c.id === 'cb')!;
  assert.equal(c1.owner, 'B');
  assert.equal(c1.contestedBy, 'A');
  assert.ok(r1.events.some(e => e.event.t === 'city_contested'));
  // доход оккупированного города ограничен
  const incomeEvt = r1.events.find(e => e.event.t === 'income' && e.event.playerId === 'B');
  assert.equal(incomeEvt?.event.t === 'income' && incomeEvt.event.gold, 0);
  const r2 = resolveTurn(b, r1.state, []);
  assert.equal(r2.state.cities.find(c => c.id === 'cb')!.owner, 'A');
  assert.ok(r2.events.some(e => e.event.t === 'city_captured'));
});

test('защитник освобождает оспариваемый город', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 5, y: 5, hp: 2 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 6, y: 5 },
  ], cities: [{ id: 'cb', owner: 'B', x: 5, y: 5, contestedBy: 'A', contestedSinceTurn: 1 }] });
  s.turn = 2;
  const r = resolveTurn(b, s, [so('B', attack('b1', 'a1'))]);
  const c = r.state.cities.find(c => c.id === 'cb')!;
  assert.equal(c.owner, 'B');
  assert.equal(c.contestedBy, null);
  assert.ok(r.events.some(e => e.event.t === 'city_contest_cleared'));
});

test('скрытый отряд блокирует маршрут; событие видит только владелец', () => {
  const s = flatState({
    units: [
      { id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 5 },
      { id: 'hid', owner: 'B', type: 'infantry', x: 4, y: 5 },
      { id: 'b2', owner: 'B', type: 'scout', x: 11, y: 11 },
    ],
    terrain: [{ x: 4, y: 5, t: Terrain.Forest }],
  });
  const vA = computeVision(b, s, 'A');
  const ord = move('a1', [[3, 5], [4, 5]]);
  // Путь принимается: отряд в лесу не виден, проверка не раскрывает его.
  assert.deepEqual(validateOrder(b, s, 'A', { ...ord, path: [{ x: 3, y: 5 }] }, vA), { ok: true });
  assert.ok(!playerView(b, s, 'A').units.some(u => u.id === 'hid'));
  const r = resolveTurn(b, s, [so('A', move('a1', [[3, 5]]))]);
  assert.deepEqual([unit(r.state, 'a1')!.x, unit(r.state, 'a1')!.y], [3, 5]);

  const s2 = flatState({
    units: [
      { id: 'a1', owner: 'A', type: 'scout', x: 1, y: 5 },
      { id: 'hid', owner: 'B', type: 'infantry', x: 4, y: 5 },
    ],
    terrain: [{ x: 4, y: 5, t: Terrain.Forest }, { x: 3, y: 5, t: Terrain.Plains }],
  });
  const r2 = resolveTurn(b, s2, [so('A', move('a1', [[2, 5], [3, 5], [4, 5]]))]);
  const a1 = unit(r2.state, 'a1')!;
  assert.deepEqual([a1.x, a1.y], [3, 5]);
  const blk = r2.events.find(e => e.event.t === 'move_blocked')!;
  assert.equal(blk.event.t === 'move_blocked' && blk.event.reason, 'unexpected_obstacle');
  assert.deepEqual(blk.visibleTo, ['A']);
  assert.equal(eventsFor(r2.events, 'B').filter(e => e.event.t === 'move_blocked').length, 0);
});

test('встречное движение вражеских отрядов блокируется', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 3, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 5 },
  ] });
  const r = resolveTurn(b, s, [so('A', move('a1', [[4, 5]])), so('B', move('b1', [[3, 5]]))]);
  assert.deepEqual([unit(r.state, 'a1')!.x, unit(r.state, 'b1')!.x], [3, 4]);
});

test('колонна своих отрядов движется одновременно', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 3, y: 5 },
    { id: 'a2', owner: 'A', type: 'infantry', x: 2, y: 5 },
  ] });
  const r = resolveTurn(b, s, [so('A', move('a1', [[4, 5]])), so('A', move('a2', [[3, 5]]))]);
  assert.deepEqual([unit(r.state, 'a1')!.x, unit(r.state, 'a2')!.x], [4, 3]);
});

test('путь через видимого противника отклоняется; предпросмотр предупреждает об одновременности', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'scout', x: 2, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 3, y: 5 },
  ] });
  const v = computeVision(b, s, 'A');
  const r = validateOrder(b, s, 'A', move('a1', [[3, 5], [4, 5]]), v);
  assert.deepEqual(r, { ok: false, reason: 'path_through_enemy' });
  const p = previewAttack(b, s, 'A', 'a1', [], 'b1', v);
  assert.ok(p.ok && p.damage! > 0 && p.warning.length > 0);
});

test('нельзя отдавать приказы чужим отрядам', () => {
  const s = flatState({ units: [{ id: 'b1', owner: 'B', type: 'infantry', x: 3, y: 5 }] });
  const r = resolveTurn(b, s, [so('A', move('b1', [[4, 5]]))]);
  assert.equal(unit(r.state, 'b1')!.x, 3);
  const rej = r.events.find(e => e.event.t === 'order_rejected');
  assert.ok(rej && rej.event.t === 'order_rejected' && rej.event.reason === 'not_owner');
});

test('найм: золото списывается один раз, отряд появляется после накопления производства', () => {
  const s = flatState({ cities: [{ id: 'ca', owner: 'A', x: 3, y: 3, level: 2 }], units: [{ id: 'z', owner: 'B', x: 11, y: 11 }] });
  const gold0 = s.players[0].gold;
  const r1 = resolveTurn(b, s, [so('A', { kind: 'recruit', cityId: 'ca', unitType: 'infantry' })]);
  const p1 = r1.state.players[0];
  const inc = b.cities.goldPerLevel[2];
  assert.equal(p1.gold, gold0 - b.units.infantry.cost.gold + inc);
  // производство 4/ход, нужно 6 → появится на втором ходу; золото больше не списывается
  const r2 = resolveTurn(b, r1.state, []);
  const recruited = r2.events.find(e => e.event.t === 'unit_recruited');
  assert.ok(recruited);
  // содержание нового отряда начинает списываться со следующего хода
  assert.equal(r2.state.players[0].gold, p1.gold + inc);
});

test('исследование открывает юнита; смена очереди не дублирует прогресс', () => {
  const s = flatState({ cities: [{ id: 'ca', owner: 'A', x: 3, y: 3, level: 3 }], units: [{ id: 'z', owner: 'B', x: 11, y: 11 }] });
  const v = computeVision(b, s, 'A');
  assert.deepEqual(validateOrder(b, s, 'A', { kind: 'recruit', cityId: 'ca', unitType: 'archer' }, v), { ok: false, reason: 'unit_locked' });
  const r1 = resolveTurn(b, s, [so('A', { kind: 'research', queue: ['archery'] })]);
  const k = b.cities.knowledgePerLevel[3];
  assert.equal(r1.state.players[0].researchProgress, k);
  const r2 = resolveTurn(b, r1.state, [so('A', { kind: 'research', queue: ['spearcraft', 'archery'] })]);
  const p = r2.state.players[0];
  assert.ok(p.researched.includes('spearcraft'));
  assert.equal(p.researchProgress, 2 * k - b.techs.spearcraft.cost);
  assert.ok(r2.events.some(e => e.event.t === 'research_completed'));
});

test('пропуск хода: отряды стоят, производство продолжается, наступления нет', () => {
  const s = flatState({ cities: [{ id: 'ca', owner: 'A', x: 3, y: 3, level: 2, queue: [{ kind: 'unit', unitType: 'infantry', progress: 4, paid: true, orderId: 'x' }] }], units: [{ id: 'a1', owner: 'A', x: 5, y: 5 }, { id: 'b1', owner: 'B', x: 6, y: 5 }] });
  const r = resolveTurn(b, s, []);
  assert.deepEqual([unit(r.state, 'a1')!.x, unit(r.state, 'a1')!.y], [5, 5]);
  assert.ok(r.events.some(e => e.event.t === 'unit_recruited'));
  assert.ok(!r.events.some(e => e.event.t === 'attack'));
});

test('укрепление повышает защиту и снимается при движении', () => {
  const s = flatState({ units: [{ id: 'a1', owner: 'A', x: 5, y: 5 }, { id: 'b1', owner: 'B', x: 6, y: 5 }] });
  const r1 = resolveTurn(b, s, [so('A', hold('a1'))]);
  assert.ok(unit(r1.state, 'a1')!.statuses.some(st => st.id === 'fortified'));
  const r2 = resolveTurn(b, r1.state, [so('A', move('a1', [[4, 5]]))]);
  assert.ok(!unit(r2.state, 'a1')!.statuses.some(st => st.id === 'fortified'));
});

test('представление игрока: скрытые отряды не видны, последнее положение помечено устаревшим', () => {
  const s = flatState({ w: 20, h: 20, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 2 }, { id: 'b1', owner: 'B', type: 'infantry', x: 4, y: 2 }] });
  assert.ok(playerView(b, s, 'A').units.some(u => u.id === 'b1'));
  const r = resolveTurn(b, s, [so('A', move('a1', [[1, 2], [0, 2]]))]);
  const v = playerView(b, r.state, 'A');
  assert.ok(!v.units.some(u => u.id === 'b1'));
  assert.ok(v.staleUnits.some(u => u.id === 'b1' && u.x === 4));
});

test('отрицательный баланс не удаляет отряды', () => {
  const s = flatState({ units: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, owner: 'A', x: i, y: 0 })).concat([{ id: 'b', owner: 'B', x: 11, y: 11 }]) });
  s.players[0].gold = 0;
  const r = resolveTurn(b, s, []);
  assert.ok(r.state.players[0].gold < 0);
  assert.equal(r.state.units.filter(u => u.owner === 'A').length, 6);
  const v = computeVision(b, r.state, 'A');
  r.state.cities.push(newCity({ id: 'cc', name: 'x', owner: 'A', x: 8, y: 8 }));
  assert.deepEqual(validateOrder(b, r.state, 'A', { kind: 'recruit', cityId: 'cc', unitType: 'infantry' }, v), { ok: false, reason: 'deficit' });
});
