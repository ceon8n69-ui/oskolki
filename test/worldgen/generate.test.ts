import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE } from '../../src/shared/balance.ts';
import { generateWorld } from '../../src/worldgen/generate.ts';
import { createInitialState } from '../../src/worldgen/setup.ts';
import { playerView } from '../../src/engine/view.ts';

test('генерация детерминирована по seed', () => {
  const a = generateWorld(BALANCE, { ...BALANCE.map.presets.test32, seed: 's1' });
  const b = generateWorld(BALANCE, { ...BALANCE.map.presets.test32, seed: 's1' });
  const c = generateWorld(BALANCE, { ...BALANCE.map.presets.test32, seed: 's2' });
  assert.deepEqual(a.map.terrain, b.map.terrain);
  assert.deepEqual(a.capitals, b.capitals);
  assert.notDeepEqual(a.map.terrain, c.map.terrain);
});

test('проверка генерации проходит на наборе seed (тестовая и средняя карты)', () => {
  for (const preset of ['test32', 'small64']) {
    for (let i = 0; i < 8; i++) {
      const w = generateWorld(BALANCE, { ...BALANCE.map.presets[preset], seed: `ci-${preset}-${i}` });
      assert.ok(w.report.ok, `${preset} seed ${i}: ${w.report.checks.filter(c => !c.ok).map(c => c.id + ' ' + c.detail).join('; ')}`);
    }
  }
});

test('начальное состояние: у каждого игрока столица и стартовые отряды, чужая столица скрыта', () => {
  const { state } = createInitialState(BALANCE, {
    matchId: 'm', spec: { ...BALANCE.map.presets.test32, seed: 'init' },
    players: [{ id: 'p1', name: 'A', faction: 'union', isBot: false }, { id: 'p2', name: 'B', faction: 'union', isBot: false }],
  });
  for (const p of ['p1', 'p2']) {
    assert.equal(state.cities.filter(c => c.owner === p && c.isCapital).length, 1);
    assert.equal(state.units.filter(u => u.owner === p).length, BALANCE.factions.union.startUnits.length + 1); // + командир
    assert.ok(state.units.find(u => u.id === state.players.find(x => x.id === p)!.commander.unitId)?.type === 'commander');
  }
  const v = playerView(BALANCE, state, 'p1');
  assert.ok(!v.units.some(u => u.owner === 'p2'));
  assert.ok(!v.cities.some(c => c.owner === 'p2'));
  // Нейтральные города охраняются.
  for (const c of state.cities.filter(c => c.owner === null)) assert.ok(state.units.some(u => u.x === c.x && u.y === c.y && u.owner === 'neutral'));
});
