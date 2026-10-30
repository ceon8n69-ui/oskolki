// Генерация мира в отдельном потоке: карта 256×256 строится несколько секунд и не должна блокировать сервер.
import { parentPort } from 'node:worker_threads';
import { BALANCE } from '../shared/balance.ts';
import type { WorldSpec } from './generate.ts';
import { generateWorld } from './generate.ts';

parentPort!.on('message', (msg: { id: number; spec: WorldSpec }) => {
  try {
    const world = generateWorld(BALANCE, msg.spec);
    parentPort!.postMessage({ id: msg.id, world }, [world.map.terrain.buffer as ArrayBuffer, world.map.features.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: String((e as Error).stack ?? e) });
  }
});
