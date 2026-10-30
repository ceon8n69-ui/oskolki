import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurn } from '../../src/engine/resolve.ts';
import { computeVision } from '../../src/engine/vision.ts';
import { validateOrder } from '../../src/engine/validate.ts';
import { statusBetween, territoryOwner } from '../../src/engine/diplomacy.ts';
import { playerView } from '../../src/engine/view.ts';
import { createInitialState } from '../../src/worldgen/setup.ts';
import type { Order } from '../../src/shared/types.ts';
import { attack, b, flatState, move, so, unit } from '../helpers.ts';

const dip = (target: string, action: 'propose' | 'accept' | 'decline' | 'break', status?: 'truce' | 'alliance'): Order => ({ kind: 'diplomacy', action, target, ...(status ? { status } : {}) });
const ev = (r: { events: { event: { t: string } }[] }, t: string) => r.events.filter(e => e.event.t === t);

function base(extra: Parameters<typeof flatState>[0] = {}) {
  const s = flatState({
    w: 20, h: 10, players: ['A', 'B', 'C'],
    units: [{ id: 'a1', owner: 'A', x: 5, y: 5 }, { id: 'b1', owner: 'B', x: 6, y: 5 }, { id: 'c1', owner: 'C', x: 18, y: 9 }],
    cities: [{ id: 'ca', owner: 'A', x: 2, y: 2 }, { id: 'cb', owner: 'B', x: 12, y: 5 }, { id: 'cc', owner: 'C', x: 18, y: 1 }],
    ...extra,
  });
  s.mode.alliances = true;
  return s;
}

test('перемирие: предложение, принятие в следующем ходу, вступает в силу в конце хода', () => {
  const s = base();
  const r1 = resolveTurn(b, s, [so('A', dip('B', 'propose', 'truce'))]);
  assert.equal(ev(r1, 'diplomacy_proposed').length, 1);
  assert.equal(statusBetween(b, r1.state, 'A', 'B'), 'war');
  // Принять в том же ходу нельзя.
  assert.deepEqual(validateOrder(b, s, 'B', dip('A', 'accept'), computeVision(b, s, 'B')), { ok: false, reason: 'no_proposal' });
  // В ходу принятия атака ещё возможна (договор действует с конца хода).
  const r2 = resolveTurn(b, r1.state, [so('B', dip('A', 'accept')), so('A', attack('a1', 'b1'))]);
  assert.ok(ev(r2, 'attack').length >= 1);
  assert.equal(statusBetween(b, r2.state, 'A', 'B'), 'truce');
  const v = computeVision(b, r2.state, 'A');
  assert.deepEqual(validateOrder(b, r2.state, 'A', attack('a1', 'b1'), v), { ok: false, reason: 'treaty_forbids_attack' });
});

test('перемирие закрывает территорию; отряд внутри может выйти', () => {
  const s = base({ units: [{ id: 'a1', owner: 'A', x: 7, y: 5 }, { id: 'a2', owner: 'A', x: 11, y: 5 }, { id: 'b1', owner: 'B', x: 18, y: 8 }, { id: 'c1', owner: 'C', x: 18, y: 9 }] });
  s.diplomacy.push({ a: 'A', b: 'B', status: 'truce', since: 1, pending: null, proposal: null });
  assert.equal(territoryOwner(b, s, { x: 9, y: 5 }), 'B');
  const v = computeVision(b, s, 'A');
  assert.deepEqual(validateOrder(b, s, 'A', move('a1', [[8, 5], [9, 5]]), v), { ok: false, reason: 'territory_closed' });
  assert.deepEqual(validateOrder(b, s, 'A', move('a2', [[10, 5], [9, 5]]), v), { ok: true });
  // Захват при перемирии невозможен, даже если отряд стоит в городе.
  const s2 = base({ units: [{ id: 'a1', owner: 'A', x: 12, y: 5 }, { id: 'c1', owner: 'C', x: 18, y: 9 }] });
  s2.diplomacy.push({ a: 'A', b: 'B', status: 'truce', since: 1, pending: null, proposal: null });
  const r = resolveTurn(b, s2, []);
  assert.equal(r.state.cities.find(c => c.id === 'cb')!.contestedBy, null);
});

test('союз делит обзор; зона контроля союзника не останавливает', () => {
  const s = base({ units: [{ id: 'a1', owner: 'A', x: 1, y: 8 }, { id: 'b1', owner: 'B', x: 15, y: 8 }, { id: 'c1', owner: 'C', x: 17, y: 8 }] });
  assert.ok(!playerView(b, s, 'A').units.some(u => u.id === 'c1'));
  s.diplomacy.push({ a: 'A', b: 'B', status: 'alliance', since: 1, pending: null, proposal: null });
  assert.ok(playerView(b, s, 'A').units.some(u => u.id === 'c1'), 'союзник видит то, что видит союзник');
  const s2 = base({ units: [{ id: 'a1', owner: 'A', x: 3, y: 8 }, { id: 'b1', owner: 'B', x: 5, y: 7 }, { id: 'c1', owner: 'C', x: 18, y: 9 }] });
  s2.diplomacy.push({ a: 'A', b: 'B', status: 'alliance', since: 1, pending: null, proposal: null });
  const r = resolveTurn(b, s2, [so('A', move('a1', [[4, 8], [5, 8]]))]);
  assert.equal(unit(r.state, 'a1')!.x, 5);
  assert.equal(ev(r, 'zoc_stop').length, 0);
});

test('союз запрещён в режиме без союзов', () => {
  const s = base();
  s.mode.alliances = false;
  assert.deepEqual(validateOrder(b, s, 'A', dip('B', 'propose', 'alliance'), computeVision(b, s, 'A')), { ok: false, reason: 'alliances_disabled' });
});

test('разрыв договора вступает в силу после периода предупреждения', () => {
  const s = base();
  s.diplomacy.push({ a: 'A', b: 'B', status: 'truce', since: 1, pending: null, proposal: null });
  let r = resolveTurn(b, s, [so('A', dip('B', 'break'))]);
  const ann = ev(r, 'diplomacy_break_announced')[0].event as any;
  assert.equal(ann.effectiveTurn, 2 + b.diplomacy.breakWarningTurns);
  assert.equal(statusBetween(b, r.state, 'A', 'B'), 'truce');
  while (r.state.turn < ann.effectiveTurn) {
    assert.equal(statusBetween(b, r.state, 'A', 'B'), 'truce');
    r = resolveTurn(b, r.state, []);
  }
  assert.equal(statusBetween(b, r.state, 'A', 'B'), 'war');
  assert.ok(ev(r, 'diplomacy_changed').length >= 1);
});

test('очки влияния за удержание целей и победа по лимиту ходов', () => {
  const s = base({ units: [{ id: 'a1', owner: 'A', x: 8, y: 8 }, { id: 'b1', owner: 'B', x: 15, y: 8 }, { id: 'c1', owner: 'C', x: 18, y: 9 }] });
  s.mode.victory = 'influence';
  s.mode.turnLimit = 3;
  s.mode.objectives = [
    { id: 'o1', kind: 'shrine', x: 8, y: 8, cityId: null, points: 2, holder: null },
    { id: 'o2', kind: 'city', x: 12, y: 5, cityId: 'cb', points: 3, holder: null },
  ];
  let r = resolveTurn(b, s, []);
  assert.equal(r.state.mode.scores.A, 2);
  assert.equal(r.state.mode.scores.B, 3);
  assert.equal(ev(r, 'objective_held').length, 2);
  r = resolveTurn(b, r.state, [so('A', move('a1', [[9, 8]]))]);
  assert.equal(r.state.mode.scores.A, 2, 'ушёл со святилища — очков нет');
  r = resolveTurn(b, r.state, []);
  assert.ok(r.state.mode.finished);
  assert.deepEqual(r.state.mode.finished!.winners, ['B']);
  assert.equal(ev(r, 'match_finished').length, 1);
});

test('победа захватом столиц и победа союза последних выживших', () => {
  const s = base({ units: [{ id: 'a1', owner: 'A', x: 12, y: 5 }, { id: 'a2', owner: 'A', x: 18, y: 1 }, { id: 'c1', owner: 'C', x: 18, y: 9 }] });
  s.mode.victory = 'capitals';
  for (const c of s.cities) c.isCapital = true;
  s.cities.find(c => c.id === 'cb')!.contestedBy = 'A';
  s.cities.find(c => c.id === 'cb')!.contestedSinceTurn = 0;
  s.cities.find(c => c.id === 'cc')!.contestedBy = 'A';
  s.cities.find(c => c.id === 'cc')!.contestedSinceTurn = 0;
  const r = resolveTurn(b, s, []);
  assert.deepEqual(r.state.mode.finished?.winners, ['A']);
  assert.equal(r.state.mode.finished?.reason, 'capitals');

  const s2 = flatState({ players: ['A', 'B', 'C'], units: [{ id: 'a1', owner: 'A', x: 1, y: 1 }, { id: 'b1', owner: 'B', x: 5, y: 5 }, { id: 'c1', owner: 'C', x: 9, y: 9, hp: 1 }, { id: 'a3', owner: 'A', x: 9, y: 8 }] });
  s2.mode.alliances = true;
  s2.diplomacy.push({ a: 'A', b: 'B', status: 'alliance', since: 1, pending: null, proposal: null });
  const r2 = resolveTurn(b, s2, [so('A', attack('a3', 'c1'))]);
  assert.deepEqual(r2.state.mode.finished?.winners, ['A', 'B']);
  assert.equal(r2.state.mode.finished?.reason, 'last_alliance');
});

test('цели влияния выбираются при старте кампании', () => {
  const { state } = createInitialState(b, {
    matchId: 'm', spec: { ...b.map.presets.small64, seed: 'obj' },
    players: [{ id: 'p1', name: 'A', faction: 'union', isBot: false }, { id: 'p2', name: 'B', faction: 'tide', isBot: false }],
    mode: { victory: 'influence', turnLimit: 50, alliances: true },
  });
  assert.ok(state.mode.objectives.length >= b.influence.minObjectives);
  assert.ok(state.mode.objectives.every(o => !state.cities.some(c => c.isCapital && c.x === o.x && c.y === o.y)));
});
