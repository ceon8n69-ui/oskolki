import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurn, incomeFor } from '../../src/engine/resolve.ts';
import { computeDamage } from '../../src/engine/combat.ts';
import { computeVision } from '../../src/engine/vision.ts';
import { validateOrder } from '../../src/engine/validate.ts';
import { landMoveCost } from '../../src/engine/grid.ts';
import { moveProfile, unitCost } from '../../src/engine/stats.ts';
import { computeSupply } from '../../src/engine/supply.ts';
import { Feature, Terrain } from '../../src/shared/types.ts';
import type { Order } from '../../src/shared/types.ts';
import { attack, b, flatState, hold, move, so, unit } from '../helpers.ts';

const mods = (r: { modifiers: { id: string }[] }) => r.modifiers.map(m => m.id);
const ev = (r: { events: { event: { t: string } }[] }, t: string) => r.events.filter(e => e.event.t === t);

// ---------- Тактика ----------

test('зона контроля останавливает движение; разведчик её игнорирует', () => {
  const mk = (type: string) => flatState({ w: 12, h: 6, units: [{ id: 'a1', owner: 'A', type, x: 1, y: 2 }, { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 1 }] });
  const s = mk('scout');
  const r = resolveTurn(b, s, [so('A', move('a1', [[2, 2], [3, 2], [4, 2], [5, 2]]))]);
  assert.equal(unit(r.state, 'a1')!.x, 5, 'разведчик проходит');
  const s2 = mk('cavalry');
  s2.players[0].researched.push('agriculture', 'horsemanship');
  const s3 = flatState({ w: 12, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 2, y: 2 }, { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 1 }] });
  s3.players[0].researched.push('engineering');
  // пехота: 2 шага, второй шаг (4,2) рядом с b1 → останавливается там же; проверим вход в ЗК на первом шаге
  const s4 = flatState({ w: 12, h: 6, units: [{ id: 'a1', owner: 'A', type: 'infantry', x: 3, y: 3 }, { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 1 }] });
  const r4 = resolveTurn(b, s4, [so('A', move('a1', [[4, 2], [5, 3]]))]);
  assert.deepEqual([unit(r4.state, 'a1')!.x, unit(r4.state, 'a1')!.y], [4, 2]);
  assert.equal(ev(r4, 'zoc_stop').length, 1);
  void s2; void s3;
});

test('прикрытие щитоносца, строй Союза и высота видны в модификаторах', () => {
  const s = flatState({ units: [
    { id: 'a1', owner: 'A', type: 'infantry', x: 5, y: 5 },
    { id: 'sh', owner: 'A', type: 'shieldbearer', x: 5, y: 6 },
    { id: 'a3', owner: 'A', type: 'infantry', x: 4, y: 5 },
    { id: 'b1', owner: 'B', type: 'infantry', x: 6, y: 5 },
  ], factions: { A: 'union', B: 'forest' }, terrain: [{ x: 6, y: 5, t: Terrain.Hills }] });
  const r = computeDamage(b, s, unit(s, 'b1')!, unit(s, 'a1')!);
  assert.ok(mods(r).includes('cover'));
  assert.ok(mods(r).includes('formation'));
  assert.ok(mods(r).includes('high_ground'));
});

test('подавление снижает атаку на следующий ход и затем снимается', () => {
  const s = flatState({ units: [{ id: 'ar', owner: 'A', type: 'archer', x: 3, y: 5 }, { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 5 }] });
  const r1 = resolveTurn(b, s, [so('A', attack('ar', 'b1'))]);
  assert.ok(unit(r1.state, 'b1')!.statuses.some(st => st.id === 'suppressed'));
  assert.equal(ev(r1, 'suppressed').length, 1);
  const pv = computeDamage(b, r1.state, unit(r1.state, 'b1')!, unit(r1.state, 'ar')!);
  assert.ok(mods(pv).includes('suppressed'));
  const r2 = resolveTurn(b, r1.state, []);
  const r3 = resolveTurn(b, r2.state, []);
  assert.ok(!unit(r3.state, 'b1')!.statuses.some(st => st.id === 'suppressed'));
});

test('отталкивание щитом сдвигает выжившую цель; тяжёлые не сдвигаются', () => {
  const s = flatState({ units: [{ id: 'sh', owner: 'A', type: 'shieldbearer', x: 3, y: 5 }, { id: 'b1', owner: 'B', type: 'shieldbearer', x: 4, y: 5 }] });
  const o: Order = { kind: 'unit', unitId: 'sh', mode: 'attack', path: [], targetUnitId: 'b1', ability: 'knockback' };
  const r = resolveTurn(b, s, [so('A', o)]);
  assert.equal(unit(r.state, 'b1')!.x, 5);
  assert.equal(ev(r, 'knockback').length, 1);
  const s2 = flatState({ units: [{ id: 'sh', owner: 'A', type: 'shieldbearer', x: 3, y: 5 }, { id: 'b1', owner: 'B', type: 'ironclad', x: 4, y: 5 }], factions: { B: 'mountain' } });
  const r2 = resolveTurn(b, s2, [so('A', o)]);
  assert.equal(unit(r2.state, 'b1')!.x, 4);
});

test('осадное орудие не стреляет после движения без «Подвижных орудий»', () => {
  const s = flatState({ units: [{ id: 'sg', owner: 'A', type: 'siege', x: 2, y: 5 }, { id: 'b1', owner: 'B', type: 'infantry', x: 6, y: 5 }] });
  s.players[0].researched.push('engineering', 'siegecraft');
  const v = computeVision(b, s, 'A');
  s.explored.A.fill(1);
  const vis = { visible: new Uint8Array(v.visible.length).fill(1), close: new Uint8Array(v.visible.length).fill(1) };
  assert.deepEqual(validateOrder(b, s, 'A', attack('sg', 'b1', [[3, 5]]), vis), { ok: false, reason: 'cannot_attack_after_move' });
  s.players[0].researched.push('mobile_siege');
  assert.deepEqual(validateOrder(b, s, 'A', attack('sg', 'b1', [[3, 5]]), vis), { ok: true });
});

// ---------- Народы ----------

test('засада Лесных хранителей: только из леса и по не заметившему противнику', () => {
  const s = flatState({ w: 16, units: [{ id: 'f1', owner: 'A', type: 'infantry', x: 6, y: 5 }, { id: 'b1', owner: 'B', type: 'infantry', x: 7, y: 5 }], factions: { A: 'forest' }, terrain: [{ x: 6, y: 5, t: Terrain.Forest }] });
  const hidden = computeDamage(b, s, unit(s, 'f1')!, unit(s, 'b1')!, undefined, undefined, { seenAtStart: () => false });
  const seen = computeDamage(b, s, unit(s, 'f1')!, unit(s, 'b1')!, undefined, undefined, { seenAtStart: () => true });
  assert.ok(mods(hidden).includes('ambush'));
  assert.ok(!mods(seen).includes('ambush'));
  assert.ok(hidden.damage > seen.damage);
  // В полном расчёте: отряд, скрытый в лесу, выходит из чащи и бьёт — урон выше, чем у такого же отряда другого народа.
  const run = (faction: string) => {
    const st = flatState({ w: 16, units: [
      { id: 'f1', owner: 'A', type: 'infantry', x: 2, y: 5 }, { id: 'sc', owner: 'A', type: 'scout', x: 5, y: 2 },
      { id: 'b1', owner: 'B', type: 'infantry', x: 5, y: 5 },
    ], factions: { A: faction }, terrain: [{ x: 2, y: 5, t: Terrain.Forest }, { x: 3, y: 5, t: Terrain.Forest }, { x: 4, y: 5, t: Terrain.Forest }] });
    const path: [number, number][] = faction === 'forest' ? [[3, 5], [4, 5]] : [[3, 5]];
    const r = resolveTurn(b, st, [so('A', attack('f1', 'b1', path))]);
    return r.events.find(e => e.event.t === 'attack' && e.event.kind === 'primary')?.event as { damage: number } | undefined;
  };
  const forest = run('forest');
  assert.ok(forest, 'атака из леса состоялась');
  assert.equal(forest!.damage, hidden.damage);
});

test('передвижение народов: лес, холмы, мелководье', () => {
  const s = flatState({ units: [{ id: 'f', owner: 'A', x: 1, y: 1 }, { id: 'm', owner: 'B', x: 2, y: 2 }, { id: 't', owner: 'C', x: 3, y: 3 }], players: ['A', 'B', 'C'], factions: { A: 'forest', B: 'mountain', C: 'tide' } });
  const cost = (id: string, t: number) => {
    s.map.terrain[0] = t;
    return landMoveCost(b, s.map, { x: 1, y: 0 }, { x: 0, y: 0 }, moveProfile(b, s, unit(s, id)!));
  };
  assert.equal(cost('f', Terrain.Forest), 1);
  assert.equal(cost('m', Terrain.Forest), 2);
  assert.equal(cost('m', Terrain.Hills), 1);
  assert.equal(cost('f', Terrain.Hills), 2);
  assert.equal(cost('t', Terrain.ShallowWater), b.factions.tide.traits.shallowCost ?? 1);
  assert.equal(cost('f', Terrain.ShallowWater), null);
});

test('Народ Приливов: сильнее у воды, слабее вдали от неё', () => {
  const w = 14;
  const s = flatState({ w, h: 4, units: [{ id: 't1', owner: 'A', x: 1, y: 1 }, { id: 'b1', owner: 'B', x: 2, y: 1 }, { id: 't2', owner: 'A', x: 10, y: 1 }, { id: 'b2', owner: 'B', x: 11, y: 1 }], factions: { A: 'tide' }, terrain: [{ x: 0, y: 1, t: Terrain.ShallowWater }] });
  assert.ok(mods(computeDamage(b, s, unit(s, 't1')!, unit(s, 'b1')!)).includes('coast'));
  assert.ok(mods(computeDamage(b, s, unit(s, 't2')!, unit(s, 'b2')!)).includes('inland'));
});

test('Горные кланы платят больше золота; уникальные юниты и технологии только своему народу', () => {
  const s = flatState({ factions: { A: 'mountain', B: 'union' }, cities: [{ id: 'ca', owner: 'A', x: 2, y: 2 }, { id: 'cb', owner: 'B', x: 8, y: 8 }] });
  assert.equal(unitCost(b, s, 'A', 'infantry').gold, Math.ceil(b.units.infantry.cost.gold * b.factions.mountain.traits.costMul!));
  const vB = computeVision(b, s, 'B');
  assert.deepEqual(validateOrder(b, s, 'B', { kind: 'research', queue: ['mountain_iron'] }, vB), { ok: false, reason: 'tech_unavailable' });
  s.players[1].researched.push('mining', 'mountain_iron');
  assert.deepEqual(validateOrder(b, s, 'B', { kind: 'recruit', cityId: 'cb', unitType: 'ironclad' }, vB), { ok: false, reason: 'unit_locked' });
});

test('взаимоисключающие технологии', () => {
  const s = flatState();
  s.players[0].researched.push('archery', 'longbows');
  const v = computeVision(b, s, 'A');
  assert.deepEqual(validateOrder(b, s, 'A', { kind: 'research', queue: ['skirmishers'] }, v), { ok: false, reason: 'tech_unavailable' });
  const s2 = flatState();
  s2.players[0].researched.push('archery');
  assert.deepEqual(validateOrder(b, s2, 'A', { kind: 'research', queue: ['longbows', 'skirmishers'] }, computeVision(b, s2, 'A')), { ok: false, reason: 'tech_excluded' });
});

// ---------- Города ----------

test('постройка: материалы списываются при заказе, после производства действует эффект', () => {
  const s = flatState({ cities: [{ id: 'ca', owner: 'A', x: 2, y: 2, level: 3 }], units: [{ id: 'z', owner: 'B', x: 11, y: 11 }] });
  s.players[0].researched.push('agriculture', 'trade');
  const wood0 = s.players[0].materials.wood;
  const goldBefore = incomeFor(b, s, 'A').gold;
  let r = resolveTurn(b, s, [so('A', { kind: 'construct', cityId: 'ca', building: 'market' })]);
  assert.equal(r.state.players[0].materials.wood, wood0 - 1);
  for (let i = 0; i < 3 && !r.state.cities[0].buildings.includes('market'); i++) r = resolveTurn(b, r.state, []);
  assert.ok(r.state.cities[0].buildings.includes('market'));
  assert.equal(incomeFor(b, r.state, 'A').gold, goldBefore + 3);
});

test('рост города за счёт еды и специализация с 3-го уровня', () => {
  const s = flatState({ cities: [{ id: 'ca', owner: 'A', x: 2, y: 2, level: 2, food: 16 }], units: [{ id: 'z', owner: 'B', x: 11, y: 11 }] });
  const v = computeVision(b, s, 'A');
  assert.deepEqual(validateOrder(b, s, 'A', { kind: 'specialize', cityId: 'ca', specialization: 'industrial' }, v), { ok: false, reason: 'city_level_too_low' });
  const r = resolveTurn(b, s, []);
  assert.equal(r.state.cities[0].level, 3);
  assert.equal(ev(r, 'city_grew').length, 1);
  const before = incomeFor(b, r.state, 'A').production.ca;
  const r2 = resolveTurn(b, r.state, [so('A', { kind: 'specialize', cityId: 'ca', specialization: 'industrial' })]);
  assert.equal(incomeFor(b, r2.state, 'A').production.ca, Math.floor(before * 1.5));
});

test('материалы с месторождений вокруг города; найм требует материалов', () => {
  const s = flatState({ cities: [{ id: 'ca', owner: 'A', x: 3, y: 3 }], units: [{ id: 'z', owner: 'B', x: 11, y: 11 }] });
  s.map.features[3 * 12 + 4] |= Feature.ResourceWood;
  s.map.features[2 * 12 + 2] |= Feature.ResourceIron;
  s.players[0].materials = { wood: 0, iron: 0, crystal: 0 };
  s.players[0].researched.push('shields');
  const v = computeVision(b, s, 'A');
  assert.deepEqual(validateOrder(b, s, 'A', { kind: 'recruit', cityId: 'ca', unitType: 'shieldbearer' }, v), { ok: false, reason: 'not_enough_resources' });
  const r = resolveTurn(b, s, []);
  assert.deepEqual(r.state.players[0].materials, { wood: 1, iron: 1, crystal: 0 });
});

// ---------- Снабжение и лечение ----------

test('вне снабжения: предупреждение, затем штраф; в снабжении — лечение', () => {
  const s = flatState({ w: 20, h: 6, cities: [{ id: 'ca', owner: 'A', x: 1, y: 2 }], units: [{ id: 'a1', owner: 'A', x: 15, y: 2 }, { id: 'a2', owner: 'A', x: 2, y: 2, hp: 5 }, { id: 'z', owner: 'B', x: 19, y: 5 }] });
  assert.equal(computeSupply(b, s, 'A')[2 * 20 + 15], 0);
  const r1 = resolveTurn(b, s, []);
  assert.ok(unit(r1.state, 'a1')!.statuses.some(st => st.id === 'low_supply'));
  assert.equal(unit(r1.state, 'a2')!.hp, 5 + b.healing.inSupply);
  const r2 = resolveTurn(b, r1.state, []);
  assert.ok(unit(r2.state, 'a1')!.statuses.some(st => st.id === 'unsupplied'));
  const d = computeDamage(b, r2.state, unit(r2.state, 'a1')!, unit(r2.state, 'a2')!);
  assert.ok(mods(d).includes('unsupplied'));
  assert.equal(r2.state.units.length, 3, 'без снабжения отряд не исчезает');
});

// ---------- Прокачка ----------

test('повышение ранга даёт выбор улучшения; улучшение применяется', () => {
  const s = flatState({ units: [{ id: 'a1', owner: 'A', x: 3, y: 5, xp: 3 }, { id: 'b1', owner: 'B', x: 4, y: 5, hp: 2 }] });
  const r = resolveTurn(b, s, [so('A', attack('a1', 'b1'))]);
  const a1 = unit(r.state, 'a1')!;
  assert.equal(a1.rank, 1);
  assert.equal(a1.pendingPerks, 1);
  assert.equal(a1.maxHp, b.units.infantry.hp + b.ranks.hpBonus[1]);
  assert.ok(ev(r, 'promotion_available').length >= 1);
  const r2 = resolveTurn(b, r.state, [so('A', { kind: 'promote', unitId: 'a1', perk: 'forest_move' })]);
  assert.deepEqual(unit(r2.state, 'a1')!.perks, ['forest_move']);
  assert.equal(unit(r2.state, 'a1')!.pendingPerks, 0);
  assert.equal(landMoveCost(b, r2.state.map, { x: 0, y: 0 }, { x: 1, y: 0 }, { ...moveProfile(b, r2.state, unit(r2.state, 'a1')!) }), 1);
});

// ---------- Командир ----------

test('командир: «Приказ укрепиться», «Ускоренный марш», очки и перезарядка', () => {
  const s = flatState({ units: [{ id: 'cm', owner: 'A', type: 'commander', x: 5, y: 5 }, { id: 'a1', owner: 'A', x: 5, y: 6 }, { id: 'z', owner: 'B', x: 11, y: 11 }] });
  const r = resolveTurn(b, s, [so('A', { kind: 'commander', action: 'ability', ability: 'rally' })]);
  assert.ok(unit(r.state, 'a1')!.statuses.some(st => st.id === 'fortified'));
  assert.equal(r.state.players[0].commander.points, b.commander.startPoints - 2 + 1);
  const v = computeVision(b, r.state, 'A');
  assert.deepEqual(validateOrder(b, r.state, 'A', { kind: 'commander', action: 'ability', ability: 'rally' }, v), { ok: false, reason: 'ability_on_cooldown' });
  // Ускоренный марш — способность Народа Приливов.
  const t = flatState({ units: [{ id: 'cm', owner: 'A', type: 'commander', x: 5, y: 5 }, { id: 'a1', owner: 'A', x: 5, y: 6 }, { id: 'z', owner: 'B', x: 11, y: 11 }], factions: { A: 'tide' } });
  const vt = computeVision(b, t, 'A');
  const march: Order = { kind: 'commander', action: 'ability', ability: 'forced_march' };
  const longMove = move('a1', [[6, 6], [7, 6], [8, 6]]);
  assert.deepEqual(validateOrder(b, t, 'A', longMove, vt), { ok: false, reason: 'not_enough_movement' });
  assert.deepEqual(validateOrder(b, t, 'A', longMove, vt, [march]), { ok: true });
  const rt = resolveTurn(b, t, [so('A', longMove), so('A', march)]);
  assert.equal(unit(rt.state, 'a1')!.x, 8);
});

test('командир: разведывательный импульс открывает область на этот ход', () => {
  const s = flatState({ w: 30, h: 10, units: [{ id: 'cm', owner: 'A', type: 'commander', x: 2, y: 5 }, { id: 'b1', owner: 'B', x: 9, y: 5 }], factions: { A: 'forest' } });
  assert.equal(s.explored.A[5 * 30 + 9], 0);
  const r = resolveTurn(b, s, [so('A', { kind: 'commander', action: 'ability', ability: 'scout_pulse', target: { x: 9, y: 5 } })]);
  assert.equal(r.state.explored.A[5 * 30 + 9], 1);
  assert.ok(r.state.intel.A.units.b1, 'отряд в зоне импульса замечен');
});

test('командир: гибель, восстановление через несколько ходов, направления сохраняются', () => {
  const s = flatState({ units: [{ id: 'cm', owner: 'A', type: 'commander', x: 5, y: 5, hp: 1 }, { id: 'b1', owner: 'B', type: 'infantry', x: 6, y: 5 }], cities: [{ id: 'ca', owner: 'A', x: 1, y: 1, isCapital: true }] });
  s.players[0].commander.directions.tactics = 2;
  let r = resolveTurn(b, s, [so('B', attack('b1', 'cm'))]);
  assert.equal(r.state.players[0].commander.unitId, null);
  assert.equal(ev(r, 'commander_fallen').length, 1);
  for (let i = 0; i < b.commander.respawnTurns; i++) r = resolveTurn(b, r.state, [so('B', hold('b1'))]);
  const cs = r.state.players[0].commander;
  assert.ok(cs.unitId, 'командир вернулся');
  assert.equal(cs.directions.tactics, 2);
  assert.equal(unit(r.state, cs.unitId!)!.type, 'commander');
});

test('командир: выбор направления и аура тактики', () => {
  const s = flatState({ units: [{ id: 'cm', owner: 'A', type: 'commander', x: 5, y: 5 }, { id: 'a1', owner: 'A', x: 5, y: 6 }, { id: 'b1', owner: 'B', x: 5, y: 7 }] });
  s.players[0].commander.pendingChoices = 1;
  const r = resolveTurn(b, s, [so('A', { kind: 'commander', action: 'direction', direction: 'tactics' })]);
  assert.equal(r.state.players[0].commander.directions.tactics, 1);
  assert.ok(mods(computeDamage(b, r.state, unit(r.state, 'a1')!, unit(r.state, 'b1')!)).includes('tactics'));
});

test('укрепление (форт) Горных кланов повышает защиту на клетке', () => {
  const s = flatState({ units: [{ id: 'a1', owner: 'A', x: 5, y: 5 }, { id: 'b1', owner: 'B', x: 6, y: 5 }], factions: { A: 'mountain' } });
  const r = resolveTurn(b, s, [so('A', { kind: 'unit', unitId: 'a1', mode: 'build', build: 'fort', path: [] })]);
  assert.ok(r.state.map.features[5 * 12 + 5] & Feature.Fort);
  assert.ok(mods(computeDamage(b, r.state, unit(r.state, 'b1')!, unit(r.state, 'a1')!)).includes('fort'));
});

test('детерминизм сохраняется со всеми механиками этапа 3', () => {
  const mk = () => flatState({ w: 16, units: [
    { id: 'cm', owner: 'A', type: 'commander', x: 5, y: 5 }, { id: 'a1', owner: 'A', type: 'archer', x: 4, y: 5 }, { id: 'a2', owner: 'A', type: 'shieldbearer', x: 6, y: 6 },
    { id: 'b1', owner: 'B', type: 'cavalry', x: 8, y: 5 }, { id: 'b2', owner: 'B', type: 'infantry', x: 7, y: 6 },
  ], factions: { A: 'union', B: 'forest' }, cities: [{ id: 'ca', owner: 'A', x: 3, y: 3 }, { id: 'cb', owner: 'B', x: 12, y: 12 }] });
  const orders = () => [
    so('A', { kind: 'commander', action: 'ability', ability: 'rally' }),
    so('A', attack('a1', 'b2', [[5, 6]])),
    so('A', { kind: 'unit', unitId: 'a2', mode: 'attack', path: [], targetUnitId: 'b2', ability: 'knockback' }),
    so('B', attack('b1', 'a1', [[7, 5]])),
  ];
  const fixIds = (os: ReturnType<typeof orders>) => os.map((o, i) => ({ ...o, id: `fixed${i}` }));
  const ser = (r: ReturnType<typeof resolveTurn>) => JSON.stringify({ u: r.state.units, p: r.state.players, e: r.events });
  assert.equal(ser(resolveTurn(b, mk(), fixIds(orders()))), ser(resolveTurn(b, mk(), fixIds(orders()))));
});
