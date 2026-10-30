// Запуск генерации мира в worker_thread. Результат идентичен generateWorld (детерминирован по seed).
import { Worker } from 'node:worker_threads';
import type { GeneratedWorld, WorldSpec } from './generate.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (w: GeneratedWorld) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./worker.ts', import.meta.url));
  w.unref();
  w.on('message', (m: { id: number; world?: GeneratedWorld; error?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error || !m.world) p.reject(new Error(m.error ?? 'worldgen_failed'));
    else p.resolve(m.world);
  });
  w.on('error', e => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  });
  w.on('exit', () => {
    worker = null;
  });
  worker = w;
  return w;
}

export function generateWorldAsync(spec: WorldSpec): Promise<GeneratedWorld> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const w = getWorker();
    w.ref();
    const done = () => {
      if (!pending.size) w.unref();
    };
    pending.set(id, { resolve: v => (resolve(v), done()), reject: e => (reject(e), done()) });
    w.postMessage({ id, spec });
  });
}

export function stopWorldgenWorker(): Promise<number> | undefined {
  const w = worker;
  worker = null;
  return w?.terminate();
}
