// Планировщик: расчёт ходов по сроку/готовности, предупреждения о дедлайне, отправка уведомлений.
// Безопасен при нескольких инстансах: processTurn берёт строку партии с SKIP LOCKED.
import type { TelegramBot } from '../bot/telegram.ts';
import type { Db } from './db/pool.ts';
import type { GameService } from './game.ts';
import type { Alerts } from './alerts.ts';
import type { Growth } from './growth.ts';

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tick = 0;
  deps: { db: Db; game: GameService; bot: TelegramBot | null; intervalMs: number; log: (m: string, e?: unknown) => void; alerts?: Alerts; growth?: Growth };
  constructor(deps: Scheduler['deps']) {
    this.deps = deps;
    deps.game.on('maybe_due', (matchId: string) => void this.processDue(matchId));
  }

  start(): void {
    this.timer = setInterval(() => void this.run(), this.deps.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async processDue(onlyMatch?: string): Promise<void> {
    const due = await this.deps.game.dueMatches();
    for (const m of due) {
      if (onlyMatch && m.id !== onlyMatch) continue;
      try {
        await this.deps.game.processTurn(m.id, m.turn);
      } catch (e) {
        this.deps.log(`turn processing failed for ${m.id}`, String((e as Error).stack ?? e));
        void this.deps.alerts?.send(`turn-failed:${m.id}:${m.turn}`, `ошибка расчёта хода ${m.turn} партии ${m.id}: ${String((e as Error).message ?? e).slice(0, 300)}`);
      }
    }
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processDue();
      if (this.tick % 60 === 0) await this.deps.alerts?.checkStuckTurns().catch(e => this.deps.log('stuck check failed', String(e)));
      if (this.tick % 300 === 0) await this.deps.growth?.ensureSeason().catch(e => this.deps.log('season check failed', String(e)));
      if (this.tick++ % 30 === 0) await this.queueDeadlineWarnings();
      if (this.deps.bot) await this.deps.bot.flushNotifications();
    } catch (e) {
      this.deps.log('scheduler error', String(e));
      void this.deps.alerts?.send('scheduler', `ошибка планировщика: ${String((e as Error).message ?? e).slice(0, 300)}`);
    } finally {
      this.running = false;
    }
  }

  /** Предупреждение для длинных ходов: за 30 минут до конца тем, кто не нажал «Готов». */
  private async queueDeadlineWarnings(): Promise<void> {
    await this.deps.db.query(`
      INSERT INTO notifications (user_id, match_id, kind, payload, dedupe_key)
      SELECT p.user_id, m.id, 'deadline', jsonb_build_object('turn', m.turn), 'deadline:' || m.id || ':' || m.turn || ':' || p.user_id
      FROM matches m JOIN players p ON p.match_id = m.id
      WHERE m.phase = 'planning' AND m.planning_seconds >= 3600 AND m.deadline <= now() + interval '30 minutes'
        AND p.user_id IS NOT NULL AND NOT p.ready AND NOT p.eliminated
      ON CONFLICT (dedupe_key) DO NOTHING`);
  }
}
