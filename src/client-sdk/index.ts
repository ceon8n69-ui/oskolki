// Клиентский SDK: сеть, состояние, приказы, воспроизведение результатов хода.
// Не содержит отрисовки. Любой рендерер (2D-отладочный, Three.js) работает через этот модуль.
import type {
  AttackPreview, ChunkView, MatchInfo, OrderRecord, Reserved, ServerMessage, StateResponse, SubmitOrderResponse,
} from '../shared/protocol.ts';
import type { BuildKind, Coord, Order, StoredEvent } from '../shared/types.ts';
import { orderSubjectKey } from '../shared/types.ts';
import type { ShopItem } from '../shared/shop.ts';

export * from './playback.ts';

type Listener<T> = (v: T) => void;

export interface Session {
  token: string;
  userId: number;
  name: string;
  startParam: string | null;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function uuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export class OskolkiClient {
  base: string;
  session: Session | null = null;
  matchId: string | null = null;
  state: StateResponse | null = null;
  private chunks = new Map<string, ChunkView>();
  private chunksTurn = -1;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private listeners = new Map<string, Set<Listener<any>>>();

  constructor(base = '') {
    this.base = base.replace(/\/$/, '');
  }

  on<K extends keyof ClientEvents>(ev: K, fn: Listener<ClientEvents[K]>): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  private emit<K extends keyof ClientEvents>(ev: K, v: ClientEvents[K]): void {
    for (const fn of this.listeners.get(ev) ?? []) fn(v);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.session ? { authorization: `Bearer ${this.session.token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(json.error ?? `http_${res.status}`, res.status);
    return json as T;
  }

  // ---------- вход ----------
  async loginTelegram(initData: string): Promise<Session> {
    this.session = await this.request<Session>('POST', '/api/auth/telegram', { initData });
    return this.session;
  }
  async loginDev(name: string): Promise<Session> {
    this.session = await this.request<Session>('POST', '/api/auth/dev', { name });
    return this.session;
  }

  // ---------- лобби ----------
  listMatches(archived = false) {
    return this.request<{ matches: MatchInfo[] }>('GET', `/api/matches${archived ? '?archived=1' : ''}`).then(r => r.matches);
  }
  /** Удалить комнату ожидания (создатель). */
  deleteRoom(matchId: string) {
    return this.request<{ ok: true }>('DELETE', `/api/matches/${matchId}`);
  }
  /** Покинуть комнату ожидания (участник). */
  leaveRoom(matchId: string) {
    return this.request<{ ok: true }>('POST', `/api/matches/${matchId}/leave`);
  }
  /** Сдаться в идущей партии. Повтор безопасен. */
  surrender(matchId: string) {
    return this.request<{ ok: true; already: boolean }>('POST', `/api/matches/${matchId}/surrender`);
  }
  /** Итоги завершённой партии. */
  summary(matchId: string) {
    return this.request<MatchSummary>('GET', `/api/matches/${matchId}/summary`);
  }
  /** Повтор рассчитанного хода: вид до и после и события игрока. */
  replay(matchId: string, turn: number) {
    return this.request<{ turn: number; before: StateResponse; after: StateResponse; events: StoredEvent[] }>('GET', `/api/matches/${matchId}/replay?turn=${turn}`);
  }
  leaderboard() {
    return this.request<Leaderboard>('GET', '/api/leaderboard');
  }
  /** Ссылка-приглашение друга и счётчики. */
  referral() {
    return this.request<{ link: string; invited: number; finished: number; heraldAt: number }>('GET', '/api/referral');
  }
  /** Текст, ссылка и (в Telegram) подготовленное сообщение для Telegram.WebApp.shareMessage. */
  share(kind: 'invite' | 'result' | 'referral', matchId?: string) {
    return this.request<{ preparedId: string | null; text: string; url: string }>('POST', '/api/share', { kind, matchId });
  }
  /** Экран игры свёрнут/развёрнут — сервер не шлёт «ваш ход», пока игрок смотрит партию. */
  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: visible ? 'back' : 'away' }));
  }
  private visible = true;
  /** Лавка за Telegram Stars (только косметика). */
  shop() {
    return this.request<{ items: (ShopItem & { owned: boolean })[]; equippedColor: string | null }>('GET', '/api/shop');
  }
  shopInvoice(item: string) {
    return this.request<{ link: string }>('POST', '/api/shop/invoice', { item });
  }
  equip(item: string | null) {
    return this.request<{ ok: true }>('POST', '/api/shop/equip', { item });
  }
  /** Убрать партию из своего списка (true) или вернуть из архива (false). */
  archive(matchId: string, hidden = true) {
    return this.request<{ ok: true }>(hidden ? 'POST' : 'DELETE', `/api/matches/${matchId}/archive`);
  }
  createMatch(preset: string, faction = 'union', options: { victory?: string; turnLimit?: number | null; alliances?: boolean } = {}) {
    return this.request<MatchInfo>('POST', '/api/matches', { preset, faction, ...options });
  }
  addBots(matchId: string, count: number) {
    return this.request<MatchInfo>('POST', `/api/matches/${matchId}/bots`, { count });
  }
  setFaction(matchId: string, faction: string) {
    return this.request<MatchInfo>('POST', `/api/matches/${matchId}/faction`, { faction });
  }
  /** Справочник правил (баланс): юниты, технологии, постройки, народы, эффекты. */
  rules() {
    return this.request<Record<string, any>>('GET', '/api/rules');
  }
  joinMatch(inviteCode: string, faction = 'union') {
    return this.request<MatchInfo>('POST', '/api/matches/join', { inviteCode, faction });
  }
  startMatch(matchId: string) {
    return this.request<MatchInfo>('POST', `/api/matches/${matchId}/start`);
  }
  matchDetails(matchId: string) {
    return this.request<MatchInfo & { inviteLink: string }>('GET', `/api/matches/${matchId}`);
  }

  // ---------- партия ----------
  async open(matchId: string): Promise<StateResponse> {
    this.matchId = matchId;
    this.chunks.clear();
    this.connectWs();
    return this.refresh();
  }

  async refresh(): Promise<StateResponse> {
    if (!this.matchId) throw new Error('no match');
    this.state = await this.request<StateResponse>('GET', `/api/matches/${this.matchId}/state`);
    if (this.state.view.turn !== this.chunksTurn) {
      this.chunks.clear();
      this.chunksTurn = this.state.view.turn;
    }
    this.emit('state', this.state);
    return this.state;
  }

  /** Чанки карты (кешируются в пределах хода: туман меняется только после расчёта). */
  async loadChunks(list: [number, number][]): Promise<ChunkView[]> {
    const missing = list.filter(([x, y]) => !this.chunks.has(`${x},${y}`));
    for (let i = 0; i < missing.length; i += 64) {
      const part = missing.slice(i, i + 64);
      const r = await this.request<{ chunks: ChunkView[] }>('GET', `/api/matches/${this.matchId}/chunks?list=${part.map(c => c.join(',')).join(';')}`);
      for (const c of r.chunks) this.chunks.set(`${c.cx},${c.cy}`, c);
    }
    return list.map(([x, y]) => this.chunks.get(`${x},${y}`)!).filter(Boolean);
  }

  chunk(cx: number, cy: number): ChunkView | undefined {
    return this.chunks.get(`${cx},${cy}`);
  }

  /** Клетка карты из загруженных чанков: terrain 255 — неизвестно. */
  tile(x: number, y: number): { terrain: number; features: number; visible: boolean } | null {
    const s = this.state?.view.map;
    if (!s || x < 0 || y < 0 || x >= s.width || y >= s.height) return null;
    const c = this.chunk(Math.floor(x / s.chunkSize), Math.floor(y / s.chunkSize));
    if (!c) return null;
    const i = (y - c.cy * c.size) * c.size + (x - c.cx * c.size);
    return { terrain: c.terrain[i], features: c.features[i], visible: c.visible[i] === 1 };
  }

  // ---------- приказы ----------
  /**
   * Отправка приказа. Ключ идемпотентности создаётся один раз и переиспользуется при повторах:
   * повторная отправка после обрыва связи не создаёт второй приказ.
   */
  async submitOrder(order: Order, opts: { retries?: number } = {}): Promise<SubmitOrderResponse> {
    if (!this.state) throw new Error('no state');
    const key = uuid();
    const existing = this.state.orders.find(o => o.subject === orderSubjectKey(order));
    const body = { turn: this.state.view.turn, order, idempotencyKey: key, baseVersion: existing?.version };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= (opts.retries ?? 3); attempt++) {
      try {
        const r = await this.request<SubmitOrderResponse>('POST', `/api/matches/${this.matchId}/orders`, body);
        if (r.ok && r.order) this.applyLocalOrder(r.order, r.reserved);
        return r;
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError && e.status < 500) throw e;
        await new Promise(res => setTimeout(res, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  private applyLocalOrder(rec: OrderRecord, reserved?: Reserved): void {
    if (!this.state) return;
    this.state.orders = [...this.state.orders.filter(o => o.subject !== rec.subject), rec];
    if (reserved) this.state.reserved = reserved;
    const me = this.state.match.players.find(p => p.id === this.state!.view.me.id);
    if (me) me.ready = false;
    this.emit('state', this.state);
  }

  move(unitId: string, path: Coord[]) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'move', path });
  }
  /** Маршрут на несколько ходов (только по исследованным клеткам). */
  longRoute(unitId: string, path: Coord[], stopOnThreat = true) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'move', path, longRoute: true, stopOnThreat });
  }
  buildRoad(unitId: string) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'build', build: 'road', path: [] });
  }
  build(unitId: string, build: BuildKind) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'build', build, path: [] });
  }
  /** Пепельные орды: сжечь клетку под отрядом. */
  scorch(unitId: string) {
    return this.build(unitId, 'scorch');
  }
  /** Хранители руин: поставить обелиск на клетке отряда. */
  obelisk(unitId: string) {
    return this.build(unitId, 'obelisk');
  }
  /** Погрузка: путь до соседней с транспортом клетки + клетка транспорта (см. previewMoves: embark). */
  embark(unitId: string, pathToShip: Coord[]) {
    return this.move(unitId, pathToShip);
  }
  /** Высадка с транспорта на соседнюю сушу (один шаг, весь ход). */
  disembark(unitId: string, to: Coord) {
    return this.move(unitId, [to]);
  }
  /** Атака с отталкиванием (щитоносцы). */
  shieldBash(unitId: string, targetUnitId: string, path: Coord[] = []) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'attack', path, targetUnitId, ability: 'knockback' });
  }
  construct(cityId: string, building: string) {
    return this.submitOrder({ kind: 'construct', cityId, building });
  }
  specialize(cityId: string, specialization: string) {
    return this.submitOrder({ kind: 'specialize', cityId, specialization });
  }
  promote(unitId: string, perk: string) {
    return this.submitOrder({ kind: 'promote', unitId, perk });
  }
  commanderAbility(ability: string, target?: Coord) {
    return this.submitOrder({ kind: 'commander', action: 'ability', ability, ...(target ? { target } : {}) });
  }
  /** Дипломатия: propose (truce | alliance), accept, decline, break. Вступает в силу в конце хода. */
  diplomacy(target: string, action: 'propose' | 'accept' | 'decline' | 'break', status?: 'truce' | 'alliance') {
    return this.submitOrder({ kind: 'diplomacy', target, action, ...(status ? { status } : {}) });
  }
  markers() {
    return this.request<{ markers: Marker[] }>('GET', `/api/matches/${this.matchId}/markers`).then(r => r.markers);
  }
  addMarker(x: number, y: number, label: string, shared = true) {
    return this.request<{ markers: Marker[] }>('POST', `/api/matches/${this.matchId}/markers`, { x, y, label, shared }).then(r => r.markers);
  }
  deleteMarker(id: number) {
    return this.request<{ markers: Marker[] }>('DELETE', `/api/matches/${this.matchId}/markers/${id}`).then(r => r.markers);
  }
  commanderDirection(direction: string) {
    return this.submitOrder({ kind: 'commander', action: 'direction', direction });
  }
  /** Мини-карта: исследованная местность (255 — неизвестно), города, видимые отряды. */
  async minimap() {
    const r = await this.request<{ width: number; height: number; turn: number; terrain: string; cities: { x: number; y: number; owner: string | null; isCapital: boolean }[]; units: { x: number; y: number; owner: string }[] }>('GET', `/api/matches/${this.matchId}/minimap`);
    const bin = atob(r.terrain);
    const terrain = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) terrain[i] = bin.charCodeAt(i);
    return { ...r, terrain };
  }
  attack(unitId: string, targetUnitId: string, path: Coord[] = []) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'attack', path, targetUnitId });
  }
  hold(unitId: string) {
    return this.submitOrder({ kind: 'unit', unitId, mode: 'hold', path: [] });
  }
  recruit(cityId: string, unitType: string) {
    return this.submitOrder({ kind: 'recruit', cityId, unitType });
  }
  research(queue: string[]) {
    return this.submitOrder({ kind: 'research', queue });
  }
  async cancel(subject: string) {
    await this.request('DELETE', `/api/matches/${this.matchId}/orders?subject=${encodeURIComponent(subject)}&turn=${this.state!.view.turn}`);
    return this.refresh();
  }
  async setReady(ready = true) {
    const r = await this.request<{ ok: boolean; reason?: string }>('POST', `/api/matches/${this.matchId}/ready`, { turn: this.state!.view.turn, ready });
    if (r.ok && this.state) {
      const me = this.state.match.players.find(p => p.id === this.state!.view.me.id);
      if (me) me.ready = ready;
      this.emit('state', this.state);
    }
    return r;
  }

  previewMoves(unitId: string) {
    return this.request<{ tiles: { x: number; y: number; cost: number }[] }>('GET', `/api/matches/${this.matchId}/preview/moves?unitId=${encodeURIComponent(unitId)}`).then(r => r.tiles);
  }
  previewAttack(unitId: string, targetUnitId: string, path: Coord[] = []) {
    return this.request<AttackPreview>('POST', `/api/matches/${this.matchId}/preview/attack`, { unitId, targetUnitId, path });
  }
  events(turn: number) {
    return this.request<{ turn: number; events: StoredEvent[] }>('GET', `/api/matches/${this.matchId}/events?turn=${turn}`).then(r => r.events);
  }

  // ---------- WebSocket с переподключением ----------
  private connectWs(): void {
    if (!this.session || typeof WebSocket === 'undefined') return;
    this.ws?.close();
    const proto = (this.base || location.origin).replace(/^http/, 'ws');
    const ws = new WebSocket(`${proto}/ws?token=${encodeURIComponent(this.session.token)}`);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      this.wsRetry = 0;
      if (!this.visible) ws.send('{"type":"away"}');
      if (this.matchId) ws.send(JSON.stringify({ type: 'subscribe', matchId: this.matchId }));
      ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25000);
      // После переподключения состояние могло устареть — перечитываем.
      if (this.state) void this.refresh().catch(() => {});
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === 'turn_resolved' && msg.matchId === this.matchId) void this.onTurnResolved(msg.turn);
      if (msg.type === 'match' && this.state && msg.match.id === this.matchId) {
        this.state.match = msg.match;
        this.emit('match', msg.match);
      }
      if (msg.type === 'ready_changed' && this.state) {
        const p = this.state.match.players.find(x => x.id === msg.playerId);
        if (p) p.ready = msg.ready;
        this.emit('match', this.state.match);
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (this.ws !== ws) return;
      const delay = Math.min(15000, 500 * 2 ** this.wsRetry++);
      setTimeout(() => this.ws === ws && this.connectWs(), delay);
    };
  }

  private async onTurnResolved(turn: number): Promise<void> {
    const events = await this.events(turn);
    const before = this.state;
    const after = await this.refresh();
    this.emit('turnResolved', { turn, events, before, after });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export interface ClientEvents {
  state: StateResponse;
  match: MatchInfo;
  turnResolved: { turn: number; events: StoredEvent[]; before: StateResponse | null; after: StateResponse };
}

export interface Marker {
  id: number;
  playerId: string;
  x: number;
  y: number;
  label: string;
  shared: boolean;
  turn: number;
}

export interface MatchSummary {
  matchId: string;
  turns: number;
  winners: string[];
  reason: string | null;
  players: {
    id: string; name: string; faction: string; color: string; isBot: boolean; surrendered: boolean;
    cities: number; units: number; captured: number; lost: number; recruited: number; techs: number; score: number | null;
    rating: { before: number; after: number; rated: boolean } | null;
  }[];
}
export interface Leaderboard {
  top: { place: number; name: string; rating: number; games: number; wins: number; me: boolean; crown?: boolean; badges?: string[] }[];
  season?: { id: number; name: string; endsAt: string } | null;
  previous?: { place: number; name: string; rating: number }[];
  me: { place: number; rating: number; games: number; wins: number } | null;
}
