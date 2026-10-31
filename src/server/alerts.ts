// Оповещения администратору в Telegram: сбои расчёта хода, зависшие ходы, перезапуск после падения.
// Получатели подписываются командой /alerts в боте, если их имя пользователя или id есть в ALERT_ADMINS.
import type { TelegramBot } from '../bot/telegram.ts';
import type { Db } from './db/pool.ts';

export class Alerts {
  private last = new Map<string, number>();
  db: Db;
  bot: TelegramBot | null;
  admins: string[];
  log: (m: string, e?: unknown) => void;
  cooldownMs: number;
  constructor(d: { db: Db; bot: TelegramBot | null; admins: string[]; log: (m: string, e?: unknown) => void; cooldownMs?: number }) {
    this.db = d.db;
    this.bot = d.bot;
    this.admins = d.admins.map(a => a.replace(/^@/, '').toLowerCase()).filter(Boolean);
    this.log = d.log;
    this.cooldownMs = d.cooldownMs ?? 30 * 60_000;
  }

  isAdmin(from: { id: number; username?: string }): boolean {
    return this.admins.includes(String(from.id)) || (!!from.username && this.admins.includes(from.username.toLowerCase()));
  }

  async subscribe(chatId: number, on: boolean): Promise<void> {
    if (on) await this.db.query('INSERT INTO alert_subscribers (chat_id) VALUES ($1) ON CONFLICT DO NOTHING', [chatId]);
    else await this.db.query('DELETE FROM alert_subscribers WHERE chat_id=$1', [chatId]);
  }

  /** Отправить оповещение; одинаковые ключи — не чаще раза в cooldownMs. Ошибки отправки не роняют сервер. */
  async send(key: string, text: string): Promise<boolean> {
    const now = Date.now();
    if ((this.last.get(key) ?? 0) + this.cooldownMs > now) return false;
    this.last.set(key, now);
    this.log(`ALERT ${key}: ${text}`);
    if (!this.bot) return false;
    try {
      const { rows } = await this.db.query('SELECT chat_id FROM alert_subscribers');
      for (const r of rows) await this.bot.api('sendMessage', { chat_id: Number(r.chat_id), text: `⚠️ Осколки: ${text}` }).catch(e => this.log('alert send failed', String(e)));
      return rows.length > 0;
    } catch (e) {
      this.log('alert failed', String(e));
      return false;
    }
  }

  /** Отметка старта: если прошлый запуск не завершился штатно — оповещение о падении. */
  async markStarted(deployment: string | null): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT clean_shutdown, started_at, deployment FROM server_state WHERE id=1');
    await this.db.query('UPDATE server_state SET clean_shutdown=FALSE, started_at=now(), deployment=$1 WHERE id=1', [deployment]);
    const crashed = !!s && s.started_at !== null && !s.clean_shutdown;
    if (crashed) await this.send('crash', `сервер перезапущен после сбоя (предыдущий запуск ${new Date(s.started_at).toISOString()}${s.deployment ? `, деплой ${s.deployment}` : ''})`);
    return crashed;
  }

  async markStopped(): Promise<void> {
    await this.db.query('UPDATE server_state SET clean_shutdown=TRUE WHERE id=1');
  }

  /** Ходы, срок которых истёк больше чем minutes минут назад, а расчёт так и не прошёл. */
  async checkStuckTurns(minutes = 10): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT id, turn FROM matches WHERE phase='planning' AND deleted_at IS NULL AND deadline IS NOT NULL AND deadline < now() - make_interval(mins => $1)`,
      [minutes],
    );
    for (const r of rows) await this.send(`stuck:${r.id}:${r.turn}`, `ход ${r.turn} партии ${r.id} не рассчитан более ${minutes} мин после срока`);
    return rows.map(r => r.id);
  }
}
