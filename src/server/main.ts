import { BALANCE } from '../shared/balance.ts';
import { TelegramBot } from '../bot/telegram.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { GameService } from './game.ts';
import { Scheduler } from './scheduler.ts';
import { Alerts } from './alerts.ts';
import { Growth } from './growth.ts';
import { spawn } from 'node:child_process';

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

const alerts = new Alerts({ db, bot, admins: cfg.alertAdmins, log });
if (bot) bot.d.alerts = alerts;
// Падение процесса: записать, попытаться оповестить, выйти — Railway перезапустит.
const fatal = (kind: string) => (e: unknown) => {
  log(`${kind}`, String((e as Error)?.stack ?? e));
  void alerts.send(`fatal:${kind}`, `${kind}: ${String((e as Error)?.message ?? e).slice(0, 300)}`).finally(() => setTimeout(() => process.exit(1), 1500));
};
process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', fatal('unhandledRejection'));

const growth = new Growth({ db, bot, publicUrl: cfg.publicUrl, botUsername: cfg.botUsername, log });
await growth.ensureSeason().catch(e => log('season check failed', String(e)));
const app = await buildApp({ cfg, db, game, b: BALANCE, bot, growth });
const scheduler = new Scheduler({ db, game, bot, intervalMs: cfg.schedulerIntervalMs, log, alerts, growth });
scheduler.start();
await app.listen({ port: cfg.port, host: '0.0.0.0' });
await alerts.markStarted(process.env.RAILWAY_DEPLOYMENT_ID ?? null).catch(e => log('markStarted failed', String(e)));

// Разовый нагрузочный тест на боевой инфраструктуре (переменная LOAD_TEST_ONCE=1): результаты — в логах, данные удаляются.
if (process.env.LOAD_TEST_ONCE === '1') {
  const child = spawn(process.execPath, ['scripts/load-test-db.ts', '--turns', '3', '--units', '2000', '--cleanup'], { env: process.env, stdio: 'inherit' });
  child.on('exit', code => log(`load test finished with code ${code}`));
}

const shutdown = async () => {
  scheduler.stop();
  bot?.stop();
  await app.close();
  await alerts.markStopped().catch(() => {});
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
