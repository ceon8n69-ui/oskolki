// Проверка границ модулей: правила не зависят от сервера, клиента и бота.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const rules: Record<string, string[]> = {
  'src/shared': ['src/engine', 'src/worldgen', 'src/server', 'src/bot', 'src/client-sdk', 'src/ai', 'web'],
  'src/engine': ['src/worldgen', 'src/server', 'src/bot', 'src/client-sdk', 'src/ai', 'web'],
  'src/worldgen': ['src/server', 'src/bot', 'src/client-sdk', 'src/ai', 'web'],
  'src/ai': ['src/server', 'src/bot', 'src/client-sdk', 'web'],
  'src/client-sdk': ['src/server', 'src/bot', 'src/worldgen', 'src/ai', 'web'],
};
const root = new URL('..', import.meta.url).pathname;
let bad = 0;
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
for (const [mod, forbidden] of Object.entries(rules)) {
  for (const file of await walk(mod)) {
    const src = await readFile(join(root, file), 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = join(file, '..', m[1]);
      for (const f of forbidden) if (target.startsWith(f + '/') || target === f) {
        console.error(`✗ ${file} импортирует ${target} (запрещено для ${mod})`);
        bad++;
      }
    }
    if (mod === 'src/engine' && /Math\.random|Date\.now|new Date\(/.test(src.replace(/\/\/.*$/gm, ''))) {
      console.error(`✗ ${file}: недетерминированный вызов в правилах`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log('границы модулей: OK');
