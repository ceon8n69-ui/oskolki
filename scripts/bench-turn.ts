// Нагрузочная проверка расчёта хода: npm run bench -- --preset world256 --units 2000
import { BALANCE } from '../src/shared/balance.ts';
import { newUnit } from '../src/engine/factory.ts';
import type { SubmittedOrder } from '../src/shared/types.ts';
import { botOrders } from '../src/ai/simple.ts';
import { resolveTurn } from '../src/engine/resolve.ts';
import { isLandPassable } from '../src/engine/grid.ts';
import { createRng } from '../src/engine/rng.ts';
import { createInitialState } from '../src/worldgen/setup.ts';
import { stateToJson } from '../src/server/store.ts';

const args = process.argv.slice(2);
const get = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const presetName = get('preset', 'world256');
const targetUnits = Number(get('units', '2000'));
const turns = Number(get('turns', '3'));
const preset = BALANCE.map.presets[presetName];

let t = performance.now();
const players = Array.from({ length: preset.players }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, faction: 'union', isBot: true }));
const { state, world } = createInitialState(BALANCE, { matchId: 'bench', spec: { ...preset, seed: get('seed', 'bench') }, players });
console.log(`генерация ${presetName}: ${Math.round(performance.now() - t)} мс, проверка ${world.report.ok ? 'OK' : 'с ошибками'} (попытка ${world.report.attempt})`);

// Досоздаём отряды вокруг столиц до целевого числа.
const rng = createRng(42);
const taken = new Set(state.units.map(u => `${u.x},${u.y}`));
let guard = 0;
while (state.units.filter(u => u.owner !== 'neutral').length < targetUnits && guard++ < targetUnits * 50) {
  const p = state.players[Math.floor(rng() * state.players.length)];
  const cap = state.cities.find(c => c.owner === p.id)!;
  const x = cap.x + Math.floor(rng() * 21) - 10, y = cap.y + Math.floor(rng() * 21) - 10;
  if (!isLandPassable(BALANCE, state.map, x, y) || taken.has(`${x},${y}`)) continue;
  taken.add(`${x},${y}`);
  const type = ['infantry', 'scout', 'infantry', 'infantry'][Math.floor(rng() * 4)];
  state.units.push(newUnit(BALANCE, state, { id: `u${state.nextIds.unit++}`, owner: p.id, type, x, y, createdTurn: 1 }));
}
console.log(`игроков ${state.players.length}, отрядов ${state.units.length} (нейтральных ${state.units.filter(u => u.owner === 'neutral').length})`);

let s = state;
for (let turn = 0; turn < turns; turn++) {
  t = performance.now();
  const orders: SubmittedOrder[] = [];
  for (const p of s.players) botOrders(BALANCE, s, p.id).forEach((o, i) => orders.push({ id: `${p.id}-${i}`, playerId: p.id, order: o }));
  const ai = performance.now() - t;
  t = performance.now();
  const r = resolveTurn(BALANCE, s, orders);
  const ms = performance.now() - t;
  const snap = JSON.stringify(stateToJson(r.state)).length;
  const evBytes = JSON.stringify(r.events).length;
  console.log(`ход ${s.turn}: приказов ${orders.length}, ИИ ${Math.round(ai)} мс, расчёт ${Math.round(ms)} мс, событий ${r.events.length} (${(evBytes / 1024).toFixed(0)} КБ), снимок ${(snap / 1024).toFixed(0)} КБ, heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} МБ`);
  s = r.state;
}
