// Балансные прогоны «бот против бота»: npm run simulate -- --turns 40 --seeds 4 [--preset test32] [--out docs/BALANCE.md]
// Каждая пара народов играет на нескольких картах с обменом сторонами. Итог: победы, ничьи, средние города и отряды.
// Отдельно — проверка архипелага: доходят ли боты до чужих островов (транспорты, высадка).
import { writeFileSync } from 'node:fs';
import { BALANCE } from '../src/shared/balance.ts';
import type { GameState, SubmittedOrder } from '../src/shared/types.ts';
import { botOrders } from '../src/ai/simple.ts';
import { resolveTurn } from '../src/engine/resolve.ts';
import { createInitialState } from '../src/worldgen/setup.ts';
import { generateWorld } from '../src/worldgen/generate.ts';

const args = process.argv.slice(2);
const get = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const turns = Number(get('turns', '40'));
const seeds = Number(get('seeds', '4'));
const presetName = get('preset', 'test32');
const out = get('out', '');
const factions = get('factions', Object.keys(BALANCE.factions).join(',')).split(',');
const b = BALANCE;

interface GameResult { winner: string | null; cities: Record<string, number>; units: Record<string, number>; techs: Record<string, number>; turns: number; reason: string }

/** Сила стороны на момент лимита ходов. */
function strength(s: GameState, pid: string): number {
  const cities = s.cities.filter(c => c.owner === pid);
  return cities.reduce((a, c) => a + 10 + c.level * 2, 0) + s.units.filter(u => u.owner === pid).reduce((a, u) => a + 2 * (u.hp / u.maxHp), 0) + s.players.find(p => p.id === pid)!.researched.length;
}

function play(preset: string, seed: string, sides: string[], maxTurns: number): { result: GameResult; state: GameState; stats: Record<string, number> } {
  const spec = { ...b.map.presets[preset], seed };
  const world = generateWorld(b, spec);
  const players = sides.map((f, i) => ({ id: `p${i + 1}`, name: f, faction: f, isBot: true }));
  let s = createInitialState(b, { matchId: `sim-${seed}`, spec, players, world, mode: { victory: 'elimination', turnLimit: null, alliances: false } }).state;
  const stats: Record<string, number> = { embarked: 0, disembarked: 0, obelisks: 0, scorched: 0, ruins: 0, events: 0, plunder: 0 };
  let n = 0;
  while (s.turn <= maxTurns && !s.mode.finished) {
    const orders: SubmittedOrder[] = [];
    for (const p of s.players) if (!p.eliminated) botOrders(b, s, p.id).forEach(o => orders.push({ id: `o${++n}`, playerId: p.id, order: o }));
    const r = resolveTurn(b, s, orders);
    for (const e of r.events) {
      const t = e.event.t;
      if (t === 'embarked') stats.embarked++;
      if (t === 'disembarked') stats.disembarked++;
      if (t === 'obelisk_built') stats.obelisks++;
      if (t === 'scorched') stats.scorched++;
      if (t === 'ruins_looted') stats.ruins++;
      if (t === 'plunder') stats.plunder++;
      if (t === 'world_event' && e.event.phase === 'start') stats.events++;
    }
    s = r.state;
  }
  const ids = s.players.map(p => p.id);
  const cities = Object.fromEntries(ids.map(id => [id, s.cities.filter(c => c.owner === id).length]));
  const units = Object.fromEntries(ids.map(id => [id, s.units.filter(u => u.owner === id).length]));
  const techs = Object.fromEntries(s.players.map(p => [p.id, p.researched.length]));
  let winner: string | null = null;
  let reason = 'limit';
  if (s.mode.finished?.winners.length === 1) {
    winner = s.mode.finished.winners[0];
    reason = s.mode.finished.reason;
  } else {
    const sc = ids.map(id => ({ id, v: strength(s, id) })).sort((x, y) => y.v - x.v);
    if (sc.length > 1 && sc[0].v > sc[1].v * 1.15) winner = sc[0].id;
  }
  return { result: { winner, cities, units, techs, turns: s.turn - 1, reason }, state: s, stats };
}

// ---------- Пары народов ----------
const t0 = performance.now();
const table: Record<string, { w: number; l: number; d: number; games: number; cities: number; units: number; techs: number; finished: number }> = {};
for (const f of factions) table[f] = { w: 0, l: 0, d: 0, games: 0, cities: 0, units: 0, techs: 0, finished: 0 };
const matrix: Record<string, Record<string, number>> = {};
let games = 0;
for (let i = 0; i < factions.length; i++) {
  for (let j = i + 1; j < factions.length; j++) {
    for (let k = 0; k < seeds; k++) {
      for (const sides of [[factions[i], factions[j]], [factions[j], factions[i]]]) {
        const { result } = play(presetName, `bal-${k}`, sides, turns);
        games++;
        sides.forEach((f, idx) => {
          const pid = `p${idx + 1}`;
          const row = table[f];
          row.games++;
          row.cities += result.cities[pid];
          row.units += result.units[pid];
          row.techs += result.techs[pid];
          if (result.reason !== 'limit') row.finished++;
          if (result.winner === null) row.d++;
          else if (result.winner === pid) row.w++;
          else row.l++;
          const other = sides[1 - idx];
          matrix[f] ??= {};
          matrix[f][other] = (matrix[f][other] ?? 0) + (result.winner === pid ? 1 : result.winner === null ? 0.5 : 0);
        });
      }
    }
  }
}
const pairMs = performance.now() - t0;

// ---------- Архипелаг ----------
const t1 = performance.now();
const islandRuns: { seed: string; stats: Record<string, number>; landed: number; capturedAbroad: number }[] = [];
for (let k = 0; k < Math.max(1, Math.floor(seeds / 2)); k++) {
  const sides = factions.slice(0, b.map.presets.archipelago64.players);
  while (sides.length < b.map.presets.archipelago64.players) sides.push(factions[sides.length % factions.length]);
  const { state, stats } = play('archipelago64', `isl-${k}`, sides, Math.max(turns, 50));
  // Захвачено городов не на своём острове: города, принадлежащие игроку, вне его стартовой суши — приближённо: не столица и дальше 14 клеток от неё.
  let abroad = 0;
  for (const p of state.players) {
    const cap = state.cities.find(c => c.isCapital && c.owner === p.id) ?? state.cities.find(c => c.owner === p.id);
    if (!cap) continue;
    abroad += state.cities.filter(c => c.owner === p.id && Math.max(Math.abs(c.x - cap.x), Math.abs(c.y - cap.y)) > 14).length;
  }
  islandRuns.push({ seed: `isl-${k}`, stats, landed: stats.disembarked, capturedAbroad: abroad });
}
const islandMs = performance.now() - t1;

// ---------- Отчёт ----------
const pct = (x: number, n: number) => (n ? `${Math.round((x / n) * 100)}%` : '—');
const lines: string[] = [];
lines.push(`# Балансные прогоны (бот против бота)`);
lines.push('');
lines.push(`Сгенерировано \`npm run simulate -- --turns ${turns} --seeds ${seeds} --preset ${presetName}\`. Баланс ${b.version}.`);
lines.push('');
lines.push(`Каждая пара народов: ${seeds} карт × 2 стороны, до ${turns} ходов, режим «до последнего». Если партия не закончилась, победителем считается сторона с силой больше на 15% (города ×10 + уровень ×2, отряды по здоровью, технологии); иначе ничья. Всего партий: ${games}, ${(pairMs / 1000).toFixed(0)} с.`);
lines.push('');
lines.push('| Народ | Партий | Победы | Поражения | Ничьи | Доля очков | Досрочно | Городов в конце | Отрядов | Технологий |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const f of factions) {
  const r = table[f];
  lines.push(`| ${b.factions[f].name} (\`${f}\`) | ${r.games} | ${r.w} | ${r.l} | ${r.d} | ${pct(r.w + r.d / 2, r.games)} | ${pct(r.finished, r.games)} | ${(r.cities / r.games).toFixed(1)} | ${(r.units / r.games).toFixed(1)} | ${(r.techs / r.games).toFixed(1)} |`);
}
lines.push('');
lines.push('Очки по парам (строка против столбца, победа 1, ничья 0.5, из ' + seeds * 2 + '):');
lines.push('');
lines.push('| | ' + factions.join(' | ') + ' |');
lines.push('|---|' + factions.map(() => '---').join('|') + '|');
for (const f of factions) lines.push(`| ${f} | ` + factions.map(o => (o === f ? '—' : String(matrix[f]?.[o] ?? 0))).join(' | ') + ' |');
lines.push('');
lines.push(`## Архипелаг (${b.map.presets.archipelago64.players} бота, до ${Math.max(turns, 50)} ходов, ${(islandMs / 1000).toFixed(0)} с)`);
lines.push('');
lines.push('| Карта | Погрузок | Высадок | Городов за морем | Обелисков | Поджогов | Руин | Событий |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const r of islandRuns) lines.push(`| ${r.seed} | ${r.stats.embarked} | ${r.stats.disembarked} | ${r.capturedAbroad} | ${r.stats.obelisks} | ${r.stats.scorched} | ${r.stats.ruins} | ${r.stats.events} |`);
const text = lines.join('\n') + '\n';
console.log(text);
if (out) writeFileSync(out, text);
