import { createHash } from 'node:crypto';
// Сборка отладочного клиента в web/dist.
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const out = new URL('../web/dist/', import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [new URL('../web/src/main.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari15'],
  minify: true,
  sourcemap: true,
  outfile: out + 'main.js',
  logLevel: 'info',
});
const version = createHash('sha256').update(await readFile(out + 'main.js')).digest('hex').slice(0,12);
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
await writeFile(out + 'index.html', html.replace('./main.js', './main.js?v=' + version));
await cp(new URL('../web/debug.css', import.meta.url).pathname, out + 'debug.css');

await cp(new URL('../web/art', import.meta.url).pathname, out + 'art', { recursive: true });

// Standalone visual QA fixture, sharing the exact live sprite renderer.
await build({
  entryPoints: [new URL('../web/src/art-preview.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', target: ['es2022', 'safari15'],
  outfile: out + 'art-preview.js',
});
await cp(new URL('../web/art-preview.html', import.meta.url).pathname, out + 'art-preview.html');
