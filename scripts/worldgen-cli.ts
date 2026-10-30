// Административная проверка генерации: npm run worldgen -- --preset test32 --seed abc [--ascii]
import { BALANCE } from '../src/shared/balance.ts';
import { asciiMap, generateWorld } from '../src/worldgen/generate.ts';

const args = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const presetName = get('preset', 'test32');
const preset = BALANCE.map.presets[presetName];
if (!preset) throw new Error(`нет пресета ${presetName}`);
const seed = get('seed', 'demo');
const t0 = performance.now();
const world = generateWorld(BALANCE, { ...preset, seed });
const ms = Math.round(performance.now() - t0);
if (args.includes('--ascii')) console.log(asciiMap(world.map, world.capitals, world.neutralCities));
const r = world.report;
console.log(`\nseed=${r.seed} effective=${r.effectiveSeed} attempt=${r.attempt} ${r.generatorVersion} ${r.balanceVersion} — ${ms} мс`);
console.log(`итог: ${r.ok ? 'OK' : 'ОШИБКИ'}  stats=${JSON.stringify(r.stats)}`);
for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`);
process.exitCode = r.ok ? 0 : 1;
