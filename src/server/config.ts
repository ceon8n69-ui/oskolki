// Конфигурация сервера из переменных окружения. Секреты не логируются.
export interface ServerConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  databaseUrl: string;
  publicUrl: string; // HTTPS-адрес Mini App
  botToken: string | null;
  botUsername: string;
  botMode: 'off' | 'polling' | 'webhook';
  webhookSecret: string | null;
  sessionSecret: string;
  adminToken: string | null;
  devAuth: boolean;
  initDataMaxAgeSec: number;
  schedulerIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as ServerConfig['env'];
  const sessionSecret = env.SESSION_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-session-secret-not-for-production');
  if (nodeEnv === 'production' && sessionSecret.length < 32) throw new Error('SESSION_SECRET (≥32 символов) обязателен в production');
  const devAuth = env.DEV_AUTH === '1';
  if (nodeEnv === 'production' && devAuth) throw new Error('DEV_AUTH запрещён в production');
  const botMode = (env.BOT_MODE ?? 'off') as ServerConfig['botMode'];
  if (!['off', 'polling', 'webhook'].includes(botMode)) throw new Error('BOT_MODE: off | polling | webhook');
  return {
    env: nodeEnv,
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://oskolki:oskolki@localhost:5432/oskolki',
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    botToken: env.BOT_TOKEN || null,
    botUsername: env.BOT_USERNAME ?? 'oskolki_k_bot',
    botMode,
    webhookSecret: env.WEBHOOK_SECRET || null,
    sessionSecret,
    adminToken: env.ADMIN_TOKEN || null,
    devAuth,
    initDataMaxAgeSec: Number(env.INIT_DATA_MAX_AGE_SEC ?? 86400),
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS ?? 1000),
  };
}
