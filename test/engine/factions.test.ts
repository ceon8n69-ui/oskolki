// Степные ханства и Северные ярлы: множители видны в прогнозе, цены, стартовые технологии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDamage } from '../../src/engine/combat.ts';
import { unitCost } from '../../src/engine/stats.ts';
import { newPlayer } from '../../src/engine/factory.ts';
import { Terrain } from '../../src/shared/types.ts';
import { b, flatState, unit } from '../helpers.ts';
import { missingPath } from '../../web/src/techtree.ts';

const ids = (r: ReturnType<typeof computeDamage>) => r.modifiers.map(m => `${m.side}:${m.id}`);

test('степь: натиск с равнины, слабая защита в пересечённой местности, дешёвая конница, верховая езда с начала', () => {
  const s = flatState({
    factions: { A: 'steppe', B: 'union' },
    terrain: [{ x: 6, y: 5, t: Terrain.Forest }],
    units: [{ id: 'a1', owner: 'A', x: 5, y: 5 }, { id: 'b1', owner: 'B', x: 6, y: 5 }, { id: 'a2', owner: 'A', x: 2, y: 2 }, { id: 'b2', owner: 'B', x: 3, y: 2 }],
  });
  assert.ok(ids(computeDamage(b, s, unit(s, 'a1')!, unit(s, 'b1')!)).includes('attack:steppe_charge'));
  // Отряд степи в лесу защищается хуже.
  s.map.terrain[2 * s.map.width + 2] = Terrain.Forest;
  assert.ok(ids(computeDamage(b, s, unit(s, 'b2')!, unit(s, 'a2')!)).includes('defense:rough_ground'));
  // Из леса натиска нет.
  assert.ok(!ids(computeDamage(b, s, unit(s, 'a2')!, unit(s, 'b2')!)).includes('attack:steppe_charge'));
  assert.equal(unitCost(b, s, 'A', 'cavalry').gold, Math.ceil(b.units.cavalry.cost.gold * 0.8));
  assert.equal(unitCost(b, s, 'A', 'archer').gold, b.units.archer.cost.gold);
  assert.ok(newPlayer(b, { id: 'x', name: 'x', faction: 'steppe', color: '#000', isBot: false }).researched.includes('horsemanship'));
  assert.deepEqual(newPlayer(b, { id: 'y', name: 'y', faction: 'union', color: '#000', isBot: false }).researched, []);
});

test('север: ярость раненых (берсерк — при любой ране), дорогие стрелки', () => {
  const s = flatState({
    factions: { A: 'north', B: 'union' },
    units: [{ id: 'a1', owner: 'A', x: 5, y: 5, hp: 5 }, { id: 'a2', owner: 'A', type: 'berserker', x: 5, y: 7, hp: 9 }, { id: 'a3', owner: 'A', x: 2, y: 2, hp: 9 },
      { id: 'b1', owner: 'B', x: 6, y: 5 }, { id: 'b2', owner: 'B', x: 6, y: 7 }, { id: 'b3', owner: 'B', x: 3, y: 2 }],
  });
  assert.ok(ids(computeDamage(b, s, unit(s, 'a1')!, unit(s, 'b1')!)).includes('attack:fury'), 'пехота при 5/10');
  assert.ok(ids(computeDamage(b, s, unit(s, 'a2')!, unit(s, 'b2')!)).includes('attack:fury'), 'берсерк при 9/10');
  assert.ok(!ids(computeDamage(b, s, unit(s, 'a3')!, unit(s, 'b3')!)).includes('attack:fury'), 'пехота при 9/10 — нет');
  assert.equal(unitCost(b, s, 'A', 'archer').gold, Math.ceil(b.units.archer.cost.gold * 1.25));
  assert.equal(unitCost(b, s, 'A', 'infantry').gold, b.units.infantry.cost.gold);
});

test('дерево исследований: путь включает недостающих предшественников по порядку и учитывает взаимоисключения', () => {
  assert.deepEqual(missingPath('banking', [], []), ['agriculture', 'trade', 'currency', 'banking']);
  assert.deepEqual(missingPath('banking', ['agriculture'], ['trade']), ['currency', 'banking']);
  assert.deepEqual(missingPath('ruins_golems', [], []), ['ruins_runes', 'mining', 'ruins_golems']);
  assert.equal(missingPath('longbows', ['archery', 'skirmishers'], []), null);
  // У каждой технологии есть иконка, все предшественники существуют.
  for (const [id, t] of Object.entries(b.techs)) for (const r of t.requires) assert.ok(b.techs[r], `${id} → ${r}`);
});
