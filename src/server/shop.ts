// Лавка за Telegram Stars: счёт (createInvoiceLink), проверка перед оплатой, выдача после оплаты.
// Выдача идемпотентна по telegram_payment_charge_id; товар — только косметика.
import { randomBytes } from 'node:crypto';
import type { TelegramBot } from '../bot/telegram.ts';
import { SHOP, shopItem } from '../shared/shop.ts';
import type { Db } from './db/pool.ts';
import { withTx } from './db/pool.ts';
import { GameError } from './game.ts';

export class Shop {
  db: Db;
  log: (m: string, e?: unknown) => void;
  constructor(db: Db, log: (m: string, e?: unknown) => void = () => {}) {
    this.db = db;
    this.log = log;
  }

  async list(userId: number) {
    const { rows } = await this.db.query('SELECT item FROM user_items WHERE user_id=$1', [userId]);
    const { rows: [u] } = await this.db.query('SELECT equipped_color FROM users WHERE id=$1', [userId]);
    const owned = new Set(rows.map(r => r.item));
    return { items: SHOP.map(i => ({ ...i, owned: owned.has(i.id) })), equippedColor: (u?.equipped_color as string | null) ?? null };
  }

  /** Ссылка на оплату. payload связывает платёж с пользователем и товаром. */
  async createInvoice(userId: number, itemId: string, bot: TelegramBot | null): Promise<{ link: string }> {
    const item = shopItem(itemId);
    if (!item) throw new GameError('unknown_item', 404);
    if (!item.stars) throw new GameError('reward_only', 409);
    if (!bot) throw new GameError('payments_unavailable', 503);
    const { rows } = await this.db.query('SELECT 1 FROM user_items WHERE user_id=$1 AND item=$2', [userId, itemId]);
    if (rows.length) throw new GameError('already_owned', 409);
    const payload = `${userId}:${itemId}:${randomBytes(6).toString('hex')}`;
    const link = await bot.api<string>('createInvoiceLink', {
      title: item.name, description: item.description, payload, provider_token: '', currency: 'XTR',
      prices: [{ label: item.name, amount: item.stars }],
    });
    return { link };
  }

  private parse(payload: string): { userId: number; item: string } | null {
    const m = /^(\d+):([a-z_]+):[0-9a-f]+$/.exec(payload ?? '');
    return m && shopItem(m[2]) ? { userId: Number(m[1]), item: m[2] } : null;
  }

  /** Проверка перед списанием: товар существует, цена совпадает, плательщик — тот же пользователь, товара ещё нет. */
  async preCheckout(q: { from: { id: number }; currency: string; total_amount: number; invoice_payload: string }): Promise<{ ok: boolean; error?: string }> {
    const p = this.parse(q.invoice_payload);
    if (!p) return { ok: false, error: 'Товар не найден' };
    const item = shopItem(p.item)!;
    if (!item.stars) return { ok: false, error: 'Товар не продаётся' };
    if (q.currency !== 'XTR' || q.total_amount !== item.stars) return { ok: false, error: 'Цена изменилась, откройте лавку заново' };
    const { rows: [u] } = await this.db.query('SELECT telegram_id FROM users WHERE id=$1', [p.userId]);
    if (!u || Number(u.telegram_id) !== q.from.id) return { ok: false, error: 'Оплата не для этого аккаунта' };
    const { rows } = await this.db.query('SELECT 1 FROM user_items WHERE user_id=$1 AND item=$2', [p.userId, p.item]);
    if (rows.length) return { ok: false, error: 'Уже куплено' };
    return { ok: true };
  }

  /** Успешная оплата: запись покупки и выдача товара; повтор того же платежа ничего не меняет. */
  async paid(sp: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string }): Promise<boolean> {
    const p = this.parse(sp.invoice_payload);
    if (!p) {
      this.log('payment with unknown payload', sp.invoice_payload);
      return false;
    }
    return withTx(this.db, async tx => {
      const r = await tx.query(
        'INSERT INTO purchases (user_id, item, stars, charge_id, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (charge_id) DO NOTHING',
        [p.userId, p.item, sp.total_amount, sp.telegram_payment_charge_id, sp.invoice_payload],
      );
      if (!r.rowCount) return false;
      await tx.query('INSERT INTO user_items (user_id, item) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.userId, p.item]);
      const item = shopItem(p.item)!;
      if (item.kind === 'color') await tx.query('UPDATE users SET equipped_color=$2 WHERE id=$1', [p.userId, item.id]);
      return true;
    });
  }

  /** Выбрать купленный цвет (или вернуть цвет народа: item = null). */
  async equip(userId: number, itemId: string | null): Promise<{ ok: true }> {
    if (itemId !== null) {
      const item = shopItem(itemId);
      if (!item || item.kind !== 'color') throw new GameError('unknown_item', 404);
      const { rows } = await this.db.query('SELECT 1 FROM user_items WHERE user_id=$1 AND item=$2', [userId, itemId]);
      if (!rows.length) throw new GameError('not_owned', 403);
    }
    await this.db.query('UPDATE users SET equipped_color=$2 WHERE id=$1', [userId, itemId]);
    return { ok: true };
  }
}
