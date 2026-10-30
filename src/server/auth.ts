// Авторизация: проверка Telegram initData и сессионные токены.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitDataResult {
  user: TelegramUser;
  authDate: number;
  startParam: string | null;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Проверка подписи Telegram Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token); hash = HMAC_SHA256(key=secret_key, msg=data_check_string).
 */
export function verifyInitData(initData: string, botToken: string, maxAgeSec: number, nowSec = Math.floor(Date.now() / 1000)): InitDataResult {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new AuthError('initdata_no_hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(hash, expected)) throw new AuthError('initdata_bad_signature');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) throw new AuthError('initdata_no_auth_date');
  if (nowSec - authDate > maxAgeSec) throw new AuthError('initdata_expired');
  if (authDate - nowSec > 300) throw new AuthError('initdata_from_future');
  const userRaw = params.get('user');
  if (!userRaw) throw new AuthError('initdata_no_user');
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new AuthError('initdata_bad_user');
  }
  if (!Number.isSafeInteger(user.id)) throw new AuthError('initdata_bad_user');
  return { user, authDate, startParam: params.get('start_param') };
}

/** Для тестов и инструментов: подписать initData так же, как это делает Telegram. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

export class AuthError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// ---------- Сессионные токены: v1.<payload base64url>.<hmac> ----------

export interface Session {
  uid: number; // users.id
  exp: number; // unix sec
}

export function signSession(s: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(s)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${sig}`;
}

export function verifySession(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Session {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new AuthError('bad_token');
  const sig = createHmac('sha256', secret).update(`v1.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== sig.length || !timingSafeEqual(given, sig)) throw new AuthError('bad_token');
  let s: Session;
  try {
    s = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    throw new AuthError('bad_token');
  }
  if (!Number.isSafeInteger(s.uid) || s.exp < nowSec) throw new AuthError('token_expired');
  return s;
}
