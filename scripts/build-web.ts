// Сборка отладочного клиента в web/dist.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

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
await cp(new URL('../web/index.html', import.meta.url).pathname, out + 'index.html');
await cp(new URL('../web/debug.css', import.meta.url).pathname, out + 'debug.css');
