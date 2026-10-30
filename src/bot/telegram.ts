// Telegram-бот: запуск Mini App, приглашения, уведомления, настройки.
// Без внешних библиотек: Bot API через fetch. Работает в режиме polling или webhook.
import type { Db } from '../server/db/pool.ts';

export interface BotDeps {
  db: Db;
  token: string;
  publicUrl: string;
  botUsername: string;
  log: (msg: string, extra?: unknown) => void;
}

const NOTIFY_LABELS: Record<string, string> = {
  turn: 'Новый ход',
  deadline: 'Конец планирования',
  attack: 'Нападения',
  end: 'Завершение партии',
};

export class TelegramBot {
  d: BotDeps;
  private offset = 0;
  private stopped = false;
  constructor(d: BotDeps) {
    this.d = d;
  }

  async api<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.d.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }));
    if (!json.ok) {
      const err: any = new Error(`telegram ${method}: ${json.description}`);
      err.retryAfter = json.parameters?.retry_after;
      err.code = json.error_code;
      throw err;
    }
    return json.result as T;
  }

  /** Кнопка открытия игры; startParam передаётся Mini App как start_param. */
  webAppUrl(startParam?: string): string {
    return startParam ? `${this.d.publicUrl}/?tgWebAppStartParam=${encodeURIComponent(startParam)}` : `${this.d.publicUrl}/`;
  }

  inviteLink(inviteCode: string): string {
    return `https://t.me/${this.d.botUsername}?startapp=join_${inviteCode}`;
  }

  async setup(mode: 'polling' | 'webhook', webhookSecret: string | null): Promise<void> {
    await this.api('setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть игру' },
        { command: 'settings', description: 'Настройка уведомлений' },
        { command: 'help', description: 'Помощь' },
      ],
    }).catch(e => this.d.log('setMyCommands failed', String(e)));
    await this.api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: this.webAppUrl() } } }).catch(e => this.d.log('menu button failed', String(e)));
    if (mode === 'webhook') {
      await this.api('setWebhook', { url: `${this.d.publicUrl}/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ['message', 'callback_query'] });
    } else {
      await this.api('deleteWebhook', {}).catch(() => {});
    }
  }

  startPolling(): void {
    const loop = async () => {
      while (!this.stopped) {
        try {
          const updates = await this.api<any[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
          for (const u of updates) {
            this.offset = u.update_id + 1;
            await this.handleUpdate(u).catch(e => this.d.log('bot update error', String(e)));
          }
        } catch (e) {
          this.d.log('getUpdates failed', String(e));
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async upsertUser(from: any, chatId: number): Promise<{ id: number; notify: Record<string, boolean> }> {
    const { rows: [u] } = await this.d.db.query(
      `INSERT INTO users (telegram_id, username, first_name, chat_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, chat_id=EXCLUDED.chat_id, last_seen_at=now()
       RETURNING id, notify`,
      [from.id, from.username ?? null, from.first_name ?? null, chatId],
    );
    return u;
  }

  async handleUpdate(u: any): Promise<void> {
    if (u.message?.text && u.message.chat?.type === 'private') {
      const msg = u.message;
      const user = await this.upsertUser(msg.from, msg.chat.id);
      const [cmd, payload] = msg.text.trim().split(/\s+/, 2);
      if (cmd === '/start') {
        const isJoin = payload?.startsWith('join_');
        await this.api('sendMessage', {
          chat_id: msg.chat.id,
          text: isJoin
            ? 'Вас пригласили в партию «Осколков королевств». Нажмите кнопку, чтобы присоединиться.'
            : 'Осколки королевств — стратегия с одновременными ходами. Все игроки отдают приказы, затем сервер рассчитывает результат.',
          reply_markup: { inline_keyboard: [[{ text: isJoin ? 'Присоединиться' : 'Играть', web_app: { url: this.webAppUrl(isJoin ? payload : undefined) } }]] },
        });
      } else if (cmd === '/settings') {
        await this.sendSettings(msg.chat.id, user.notify);
      } else if (cmd === '/help') {
        await this.api('sendMessage', {
          chat_id: msg.chat.id,
          text: [
            'Как играть:',
            '1. Откройте игру и создайте партию или перейдите по приглашению.',
            '2. В фазе планирования отдайте приказы отрядам: движение, атака или удержание.',
            '3. Нажмите «Готов». Когда все готовы или вышло время, сервер рассчитает ход.',
            '4. Посмотрите результаты и планируйте следующий ход.',
            '',
            'Город захватывается, если ваш отряд удерживает его центр два расчёта подряд.',
            '/settings — уведомления.',
          ].join('\n'),
        });
      }
    } else if (u.callback_query) {
      const q = u.callback_query;
      const m = /^notify:(\w+)$/.exec(q.data ?? '');
      if (m && NOTIFY_LABELS[m[1]]) {
        const { rows: [row] } = await this.d.db.query(
          `UPDATE users SET notify = jsonb_set(notify, ARRAY[$2::text], to_jsonb(NOT COALESCE((notify->>$2)::boolean, true))) WHERE telegram_id=$1 RETURNING notify`,
          [q.from.id, m[1]],
        );
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Сохранено' });
        if (row && q.message) {
          await this.api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: settingsKeyboard(row.notify) }).catch(() => {});
        }
      } else {
        await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      }
    }
  }

  private async sendSettings(chatId: number, notify: Record<string, boolean>): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text: 'Уведомления (нажмите, чтобы переключить):', reply_markup: settingsKeyboard(notify) });
  }

  /**
   * Отправка накопленных уведомлений. Все ожидающие уведомления пользователя объединяются в одно сообщение.
   * Повторный запуск безопасен: sent_at ставится после успешной отправки, строки берутся с SKIP LOCKED.
   */
  async flushNotifications(): Promise<number> {
    const client = await this.d.db.connect();
    let sent = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        SELECT n.id, n.user_id, n.match_id, n.kind, n.payload, u.chat_id, u.notify
        FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.sent_at IS NULL AND n.attempts < 5
        ORDER BY n.user_id, n.id
        LIMIT 200
        FOR UPDATE OF n SKIP LOCKED`);
      const byUser = new Map<number, any[]>();
      for (const r of rows) (byUser.get(r.user_id) ?? byUser.set(r.user_id, []).get(r.user_id)!).push(r);
      for (const [, list] of byUser) {
        const chatId = list[0].chat_id;
        const prefs = list[0].notify ?? {};
        const lines: string[] = [];
        for (const n of list) {
          const p = n.payload;
          if (n.kind === 'turn' && prefs.turn !== false) lines.push(`Ход ${p.turn}: результаты готовы, можно отдавать приказы.`);
          if (n.kind === 'turn' && p.attacked > 0 && prefs.attack !== false) lines.push(`Ваши отряды атакованы (${p.attacked}).`);
          if (n.kind === 'turn' && p.lostCities > 0 && prefs.attack !== false) lines.push(`Потеряно городов: ${p.lostCities}.`);
          if (n.kind === 'deadline' && prefs.deadline !== false) lines.push(`Планирование хода ${p.turn} скоро закончится.`);
          if (n.kind === 'end' && prefs.end !== false) lines.push(p.won ? 'Партия завершена — победа!' : 'Партия завершена.');
        }
        const ids = list.map(n => n.id);
        if (!lines.length || !chatId) {
          await client.query('UPDATE notifications SET sent_at=now() WHERE id = ANY($1)', [ids]);
          continue;
        }
        try {
          const matchId = list[list.length - 1].match_id;
          await this.api('sendMessage', {
            chat_id: chatId,
            text: [...new Set(lines)].join('\n'),
            reply_markup: { inline_keyboard: [[{ text: 'Открыть игру', web_app: { url: this.webAppUrl(matchId ? `match_${matchId}` : undefined) } }]] },
          });
          await client.query('UPDATE notifications SET sent_at=now() WHERE id = ANY($1)', [ids]);
          sent++;
        } catch (e: any) {
          await client.query('UPDATE notifications SET attempts=attempts+1 WHERE id = ANY($1)', [ids]);
          this.d.log('notification failed', String(e));
          if (e.retryAfter) break;
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return sent;
  }
}

function settingsKeyboard(notify: Record<string, boolean>) {
  return {
    inline_keyboard: Object.entries(NOTIFY_LABELS).map(([k, label]) => [{ text: `${notify?.[k] === false ? '○' : '●'} ${label}`, callback_data: `notify:${k}` }]),
  };
}
