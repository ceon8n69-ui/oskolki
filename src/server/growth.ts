// Рост: присутствие в игре (для тихих уведомлений), приглашение друзей с наградой,
// «поделиться» через подготовленные сообщения Telegram, сезоны рейтинга.
import type { TelegramBot } from '../bot/telegram.ts';
import { shopItem } from '../shared/shop.ts';
import type { Db, Tx } from './db/pool.ts';
import { withTx } from './db/pool.ts';
import { GameError } from './game.ts';

// ---------- присутствие ----------
/** Кто сейчас смотрит партию (открыт сокет и экран виден). Один процесс — одна карта. */
class Presence {
  private watching = new Map<number, Map<string, number>>();
  add(userId: number, matchId: string) {
    const m = this.watching.get(userId) ?? this.watching.set(userId, new Map()).get(userId)!;
    m.set(matchId, (m.get(matchId) ?? 0) + 1);
  }
  remove(userId: number, matchId: string) {
    const m = this.watching.get(userId);
    if (!m) return;
    const n = (m.get(matchId) ?? 0) - 1;
    if (n > 0) m.set(matchId, n);
    else m.delete(matchId);
    if (!m.size) this.watching.delete(userId);
  }
  isWatching(userId: number, matchId: string | null): boolean {
    return !!matchId && (this.watching.get(userId)?.get(matchId) ?? 0) > 0;
  }
}
export const presence = new Presence();

/** Простое «ваш ход» в быстрых партиях не чаще раза в это время на партию. */
export const TURN_NOTICE_MIN_GAP_MIN = 15;
export const REFERRAL_HERALD_FRIENDS = 3;
export const REFERRAL_MIN_TURNS = 3;
export const SEASON_VETERAN_GAMES = 5;

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export function seasonName(start: Date): string {
  return `Сезон ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
}
function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export class Growth {
  db: Db;
  bot: TelegramBot | null;
  publicUrl: string;
  botUsername: string;
  log: (m: string, e?: unknown) => void;
  constructor(d: { db: Db; bot?: TelegramBot | null; publicUrl: string; botUsername: string; log?: (m: string, e?: unknown) => void }) {
    this.db = d.db;
    this.bot = d.bot ?? null;
    this.publicUrl = d.publicUrl;
    this.botUsername = d.botUsername;
    this.log = d.log ?? (() => {});
  }

  appLink(startParam: string): string {
    return this.bot ? `https://t.me/${this.botUsername}?startapp=${encodeURIComponent(startParam)}` : `${this.publicUrl}/?tgWebAppStartParam=${encodeURIComponent(startParam)}`;
  }

  // ---------- приглашение друзей ----------

  /** Вход по ссылке друга: запоминаем пригласившего, если игрок новый (ещё ни в одной партии). */
  async attachReferral(userId: number, startParam: string | null): Promise<boolean> {
    const m = /^ref_(\d+)$/.exec(startParam ?? '');
    if (!m) return false;
    const ref = Number(m[1]);
    if (ref === userId) return false;
    const r = await this.db.query(
      `UPDATE users SET referred_by=$2 WHERE id=$1 AND referred_by IS NULL
         AND EXISTS (SELECT 1 FROM users WHERE id=$2)
         AND NOT EXISTS (SELECT 1 FROM players WHERE user_id=$1)`,
      [userId, ref],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async referralInfo(userId: number) {
    const { rows: [c] } = await this.db.query(
      `SELECT count(*)::int AS invited, count(*) FILTER (WHERE referral_rewarded)::int AS finished FROM users WHERE referred_by=$1`, [userId]);
    return { link: this.appLink(`ref_${userId}`), invited: c.invited as number, finished: c.finished as number, heraldAt: REFERRAL_HERALD_FRIENDS };
  }

  /** Партия завершена: приглашённые, доигравшие первую партию, приносят награду себе и пригласившему. */
  async onMatchFinished(tx: Tx, userIds: number[], turns: number): Promise<void> {
    if (turns < REFERRAL_MIN_TURNS || !userIds.length) return;
    const { rows } = await tx.query(
      `UPDATE users SET referral_rewarded=TRUE WHERE id = ANY($1::bigint[]) AND referred_by IS NOT NULL AND NOT referral_rewarded RETURNING id, referred_by`,
      [userIds],
    );
    for (const r of rows) {
      for (const uid of [r.id, r.referred_by]) await grant(tx, uid, 'color_ally');
      const { rows: [c] } = await tx.query('SELECT count(*)::int AS n FROM users WHERE referred_by=$1 AND referral_rewarded', [r.referred_by]);
      const herald = c.n >= REFERRAL_HERALD_FRIENDS && (await grant(tx, r.referred_by, 'badge_herald'));
      await tx.query(
        `INSERT INTO notifications (user_id, match_id, kind, payload, dedupe_key) VALUES ($1, NULL, 'referral', $2, $3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [r.referred_by, JSON.stringify({ friends: c.n, herald }), `referral:${r.id}`],
      );
    }
  }

  // ---------- поделиться ----------

  /**
   * Текст и ссылка для «поделиться». Если бот доступен — ещё и подготовленное сообщение
   * (savePreparedInlineMessage) с кнопкой: клиент открывает его через Telegram.WebApp.shareMessage.
   */
  async share(userId: number, kind: 'invite' | 'result' | 'referral', info: { inviteCode?: string; result?: { won: boolean; draw: boolean; turns: number; faction: string } } = {}) {
    let text: string, url: string, button: string;
    if (kind === 'invite') {
      if (!info.inviteCode) throw new GameError('bad_request', 400);
      url = this.appLink(`join_${info.inviteCode}`);
      text = 'Зову в партию «Осколков королевств» — ходы одновременные, побеждает лучший план.';
      button = 'Присоединиться';
    } else if (kind === 'result') {
      const r = info.result!;
      url = this.appLink(`ref_${userId}`);
      text = `${r.draw ? 'Ничья' : r.won ? 'Победа' : 'Поражение'} за ${r.turns} ход. в «Осколках королевств» (${r.faction}). Сыграешь против меня?`;
      button = 'Играть';
    } else {
      url = this.appLink(`ref_${userId}`);
      text = 'Сыграем в «Осколки королевств»? Стратегия с одновременными ходами прямо в Telegram.';
      button = 'Играть';
    }
    let preparedId: string | null = null;
    if (this.bot) {
      const { rows: [u] } = await this.db.query('SELECT telegram_id FROM users WHERE id=$1', [userId]);
      if (u?.telegram_id) {
        try {
          const res = await this.bot.api<{ id: string }>('savePreparedInlineMessage', {
            user_id: Number(u.telegram_id),
            result: {
              type: 'article', id: `${kind}-${userId}-${Date.now().toString(36)}`, title: button, description: text,
              thumbnail_url: `${this.publicUrl}/art/share-card.png`,
              input_message_content: { message_text: text },
              reply_markup: { inline_keyboard: [[{ text: button, url }]] },
            },
            allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true,
          });
          preparedId = res.id;
        } catch (e) {
          this.log('prepared message failed', String(e));
        }
      }
    }
    return { preparedId, text, url };
  }

  // ---------- сезоны ----------

  /** Открыть сезон, если его нет; закрыть истёкший (места, награды, мягкий сброс) и открыть следующий. */
  async ensureSeason(now = new Date()): Promise<void> {
    await withTx(this.db, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(4242001)');
      const { rows: [open] } = await tx.query('SELECT id, started_at, ends_at FROM seasons WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
      if (!open) {
        const { rows: [last] } = await tx.query('SELECT coalesce(max(id), 0)::int AS id FROM seasons');
        // Первый сезон короче недели продлевается до конца следующего месяца.
        let ends = monthEnd(now);
        if (ends.getTime() - now.getTime() < 7 * 86400000) ends = monthEnd(ends);
        await tx.query('INSERT INTO seasons (id, started_at, ends_at) VALUES ($1, $2, $3)', [last.id + 1, now, ends]);
        return;
      }
      if (new Date(open.ends_at) > now) return;
      await this.closeSeason(tx, open.id);
      await tx.query('INSERT INTO seasons (id, started_at, ends_at) VALUES ($1, $2, $3)', [open.id + 1, now, monthEnd(now)]);
    });
  }

  private async closeSeason(tx: Tx, seasonId: number): Promise<void> {
    const { rows } = await tx.query(
      `SELECT user_id, rating, games, wins, rank() OVER (ORDER BY rating DESC)::int AS place FROM ratings WHERE games > 0 ORDER BY rating DESC`);
    for (const r of rows) {
      const rewards: string[] = [];
      if (r.place === 1) rewards.push('badge_champion');
      if (r.place <= 10) rewards.push('badge_laurel');
      if (r.games >= SEASON_VETERAN_GAMES) rewards.push('color_veteran');
      for (const it of rewards) await grant(tx, r.user_id, it);
      await tx.query(
        `INSERT INTO season_results (season_id, user_id, place, rating, games, wins, rewards) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [seasonId, r.user_id, r.place, r.rating, r.games, r.wins, rewards],
      );
      await tx.query(
        `INSERT INTO notifications (user_id, match_id, kind, payload, dedupe_key) VALUES ($1, NULL, 'season', $2, $3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [r.user_id, JSON.stringify({ place: r.place, rating: r.rating, rewards: rewards.map(i => shopItem(i)?.name ?? i) }), `season:${seasonId}:${r.user_id}`],
      );
    }
    // Мягкий сброс: половина отрыва от 1000 сохраняется, счётчики сезона обнуляются.
    await tx.query('UPDATE ratings SET rating = 1000 + round((rating - 1000) / 2.0)::int, games = 0, wins = 0, updated_at = now()');
    await tx.query('UPDATE seasons SET closed_at = now() WHERE id=$1', [seasonId]);
  }

  async seasonInfo() {
    const { rows: [s] } = await this.db.query('SELECT id, started_at, ends_at FROM seasons WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
    const { rows: prev } = await this.db.query(
      `SELECT r.place, coalesce(u.first_name, u.username, 'Игрок') AS name, r.rating FROM season_results r JOIN users u ON u.id=r.user_id
       WHERE r.season_id = (SELECT max(id) FROM seasons WHERE closed_at IS NOT NULL) AND r.place <= 3 ORDER BY r.place`);
    return {
      season: s ? { id: s.id as number, name: seasonName(new Date(s.started_at)), endsAt: new Date(s.ends_at).toISOString() } : null,
      previous: prev.map(p => ({ place: p.place as number, name: p.name as string, rating: p.rating as number })),
    };
  }
}

/** Выдать наградной предмет; true — если выдан впервые. Цвет сразу не надевается. */
async function grant(tx: Tx, userId: number, item: string): Promise<boolean> {
  const r = await tx.query('INSERT INTO user_items (user_id, item) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, item]);
  return (r.rowCount ?? 0) > 0;
}
