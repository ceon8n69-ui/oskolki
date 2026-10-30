import { BALANCE } from '../shared/balance.ts';
import { TelegramBot } from '../bot/telegram.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { GameService } from './game.ts';
import { Scheduler } from './scheduler.ts';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db);
const game = new GameService(db, BALANCE);
const log = (m: string, e?: unknown) => console.error(`[oskolki] ${m}`, e ?? '');

let bot: TelegramBot | null = null;
if (cfg.botToken && cfg.botMode !== 'off') {
  bot = new TelegramBot({ db, token: cfg.botToken, publicUrl: cfg.publicUrl, botUsername: cfg.botUsername, log });
  await bot.setup(cfg.botMode, cfg.webhookSecret).catch(e => log('bot setup failed', String(e)));
  if (cfg.botMode === 'polling') bot.startPolling();
}

const app = await buildApp({ cfg, db, game, b: BALANCE, bot });
const scheduler = new Scheduler({ db, game, bot, intervalMs: cfg.schedulerIntervalMs, log });
scheduler.start();
await app.listen({ port: cfg.port, host: '0.0.0.0' });

const shutdown = async () => {
  scheduler.stop();
  bot?.stop();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
