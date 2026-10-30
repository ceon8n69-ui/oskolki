// Сервис партий: лобби, приказы, готовность, расчёт хода.
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Balance } from '../shared/balance.ts';
import type { MatchInfo, OrderRecord, StateResponse, SubmitOrderRequest, SubmitOrderResponse } from '../shared/protocol.ts';
import type { GameState, Order, StoredEvent, SubmittedOrder } from '../shared/types.ts';
import { orderSubjectKey } from '../shared/types.ts';
import { botOrders } from '../ai/simple.ts';
import { RULES_VERSION, resolveTurn } from '../engine/resolve.ts';
import { reservedGold, validateOrder } from '../engine/validate.ts';
import { computeVision } from '../engine/vision.ts';
import { playerView } from '../engine/view.ts';
import { GENERATOR_VERSION } from '../worldgen/generate.ts';
import { createInitialState } from '../worldgen/setup.ts';
import { generateWorldAsync } from '../worldgen/async.ts';
import type { Db, Tx } from './db/pool.ts';
import { withTx } from './db/pool.ts';
import { loadState, loadStateCached, saveMap, saveState, saveTileChanges, setCachedMap, setCachedState, stateHash, stateToJson } from './store.ts';

export class GameError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export interface TurnResolvedInfo {
  matchId: string;
  turn: number; // номер рассчитанного хода
  events: StoredEvent[];
  finished: boolean;
  winner: string | null;
}

export class GameService extends EventEmitter {
  db: Db;
  b: Balance;
  constructor(db: Db, b: Balance) {
    super();
    this.db = db;
    this.b = b;
  }

  // ---------------- Лобби ----------------

  async createMatch(userId: number, preset: string, displayName: string): Promise<MatchInfo> {
    const tp = this.b.turnPresets[preset];
    if (!tp) throw new GameError('unknown_preset');
    const mp = this.b.map.presets[tp.mapPreset];
    const id = randomUUID();
    const invite = randomBytes(6).toString('base64url');
    const maxPlayers = preset === 'vsbot' ? 2 : mp.players;
    await withTx(this.db, async tx => {
      await tx.query(
        `INSERT INTO matches (id, preset, phase, turn, seed, balance_version, rules_version, map_width, map_height, chunk_size, planning_seconds, max_players, invite_code, created_by)
         VALUES ($1,$2,'lobby',0,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, preset, randomBytes(8).toString('hex'), this.b.version, RULES_VERSION, mp.width, mp.height, this.b.map.chunkSize, tp.planningSeconds, maxPlayers, invite, userId],
      );
      await this.addPlayer(tx, id, userId, displayName, false);
      if (preset === 'vsbot') await this.addPlayer(tx, id, null, 'Бот', true);
      await this.log(tx, id, `user:${userId}`, 'match_created', { preset });
    });
    if (preset === 'vsbot') await this.startMatch(id);
    return this.matchInfo(id);
  }

  private async addPlayer(tx: Tx, matchId: string, userId: number | null, name: string, isBot: boolean): Promise<string> {
    const { rows } = await tx.query('SELECT count(*)::int AS n FROM players WHERE match_id=$1', [matchId]);
    const seat = rows[0].n;
    const pid = `p${seat + 1}`;
    await tx.query(
      `INSERT INTO players (match_id, id, user_id, name, faction, color, is_bot, seat, gold) VALUES ($1,$2,$3,$4,'union','#888',$5,$6,$7)`,
      [matchId, pid, userId, name.slice(0, 32), isBot, seat, this.b.economy.startGold],
    );
    return pid;
  }

  async joinByInvite(userId: number, inviteCode: string, displayName: string): Promise<MatchInfo> {
    const matchId = await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT * FROM matches WHERE invite_code=$1 FOR UPDATE', [inviteCode]);
      if (!m) throw new GameError('invite_not_found', 404);
      const { rows: existing } = await tx.query('SELECT id FROM players WHERE match_id=$1 AND user_id=$2', [m.id, userId]);
      if (existing.length) return m.id as string; // повторный переход по ссылке открывает ту же партию
      if (m.phase !== 'lobby') throw new GameError('match_already_started', 409);
      const { rows: [{ n }] } = await tx.query('SELECT count(*)::int AS n FROM players WHERE match_id=$1', [m.id]);
      if (n >= m.max_players) throw new GameError('match_full', 409);
      await this.addPlayer(tx, m.id, userId, displayName, false);
      await this.log(tx, m.id, `user:${userId}`, 'joined', {});
      return m.id as string;
    });
    const info = await this.matchInfo(matchId);
    if (info.phase === 'lobby' && info.players.length >= info.maxPlayers) await this.startMatch(matchId);
    return this.matchInfo(matchId);
  }

  /** Старт: генерация мира, начальное состояние, первый ход. */
  async startMatch(matchId: string, byUserId?: number): Promise<void> {
    // Мир зависит только от seed и пресета, поэтому строится заранее, в отдельном потоке и вне транзакции.
    const { rows: [pre] } = await this.db.query('SELECT preset, seed, phase FROM matches WHERE id=$1', [matchId]);
    if (!pre) throw new GameError('match_not_found', 404);
    if (pre.phase !== 'lobby') return;
    const preMp = this.b.map.presets[this.b.turnPresets[pre.preset].mapPreset];
    const world = await generateWorldAsync({ ...preMp, seed: pre.seed });
    if (!world.report.ok) throw new GameError('worldgen_failed', 500);
    let started: GameState | null = null;
    await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m) throw new GameError('match_not_found', 404);
      if (m.phase !== 'lobby') return;
      if (byUserId !== undefined && m.created_by !== byUserId) throw new GameError('only_creator_can_start', 403);
      const { rows: pl } = await tx.query('SELECT * FROM players WHERE match_id=$1 ORDER BY seat', [matchId]);
      if (pl.length < 2) throw new GameError('not_enough_players', 409);
      if (pl.length > world.capitals.length) throw new GameError('too_many_players', 409);
      const { state } = createInitialState(this.b, {
        matchId,
        spec: { ...preMp, seed: m.seed },
        world,
        players: pl.map(p => ({ id: p.id, name: p.name, faction: p.faction, isBot: p.is_bot })),
      });
      for (const p of state.players) await tx.query('UPDATE players SET color=$3 WHERE match_id=$1 AND id=$2', [matchId, p.id, p.color]);
      await saveMap(tx, matchId, world.map);
      await saveState(tx, state);
      const deadline = m.planning_seconds > 0 ? new Date(Date.now() + m.planning_seconds * 1000) : null;
      await tx.query(
        `UPDATE matches SET phase='planning', turn=1, deadline=$2, generator_version=$3, gen_report=$4, updated_at=now() WHERE id=$1`,
        [matchId, deadline, GENERATOR_VERSION, JSON.stringify(world.report)],
      );
      await tx.query('INSERT INTO turns (id, match_id, number, status, snapshot) VALUES ($1,$2,1,$3,$4)', [randomUUID(), matchId, 'planning', JSON.stringify(stateToJson(state))]);
      await this.log(tx, matchId, byUserId ? `user:${byUserId}` : 'system', 'match_started', { report: world.report.ok });
      started = state;
    });
    const st = started as GameState | null;
    if (st) setCachedState(st);
    this.emit('match_changed', matchId);
  }

  // ---------------- Чтение ----------------

  async matchInfo(matchId: string, q: Db | Tx = this.db): Promise<MatchInfo> {
    const { rows: [m] } = await q.query('SELECT * FROM matches WHERE id=$1', [matchId]);
    if (!m) throw new GameError('match_not_found', 404);
    const { rows: pl } = await q.query('SELECT id, name, ready, is_bot, faction, color FROM players WHERE match_id=$1 ORDER BY seat', [matchId]);
    return {
      id: m.id, preset: m.preset, phase: m.phase, turn: m.turn, deadline: m.deadline ? new Date(m.deadline).toISOString() : null,
      maxPlayers: m.max_players, winner: m.winner, inviteCode: m.invite_code,
      players: pl.map(p => ({ id: p.id, name: p.name, ready: p.ready, isBot: p.is_bot, faction: p.faction, color: p.color })),
    };
  }

  async playerIdFor(matchId: string, userId: number): Promise<string> {
    const { rows } = await this.db.query('SELECT id FROM players WHERE match_id=$1 AND user_id=$2', [matchId, userId]);
    if (!rows.length) throw new GameError('not_in_match', 403);
    return rows[0].id;
  }

  async listMatches(userId: number): Promise<MatchInfo[]> {
    const { rows } = await this.db.query(
      'SELECT m.id FROM matches m JOIN players p ON p.match_id=m.id WHERE p.user_id=$1 ORDER BY m.updated_at DESC LIMIT 50',
      [userId],
    );
    return Promise.all(rows.map(r => this.matchInfo(r.id)));
  }

  async activeOrders(q: Db | Tx, matchId: string, turn: number, playerId?: string): Promise<(OrderRecord & { playerId: string })[]> {
    const { rows } = await q.query(
      `SELECT id, subject, version, payload, player_id FROM orders WHERE match_id=$1 AND turn=$2 AND status='active' ${playerId ? 'AND player_id=$3' : ''} ORDER BY player_id, id`,
      playerId ? [matchId, turn, playerId] : [matchId, turn],
    );
    return rows.map(r => ({ id: r.id, subject: r.subject, version: r.version, order: r.payload, playerId: r.player_id }));
  }

  async getState(matchId: string, userId: number): Promise<StateResponse> {
    const match = await this.matchInfo(matchId);
    if (match.phase === 'lobby') throw new GameError('match_not_started', 409);
    const playerId = await this.playerIdFor(matchId, userId);
    const state = await loadStateCached(this.db, matchId);
    const orders = await this.activeOrders(this.db, matchId, state.turn, playerId);
    return {
      match,
      view: playerView(this.b, state, playerId),
      orders: orders.map(({ playerId: _p, ...o }) => o),
      reserved: { gold: reservedGold(this.b, orders.map(o => o.order)) },
    };
  }

  async getEvents(matchId: string, userId: number, turn: number): Promise<StoredEvent[]> {
    const playerId = await this.playerIdFor(matchId, userId);
    const { rows } = await this.db.query(
      'SELECT seq, phase, visible_to, event FROM turn_events WHERE match_id=$1 AND turn=$2 AND $3 = ANY(visible_to) ORDER BY seq',
      [matchId, turn, playerId],
    );
    // visibleTo наружу не отдаём: игроку не нужно знать, кто ещё видел событие.
    return rows.map(r => ({ seq: r.seq, phase: r.phase, visibleTo: [playerId], event: r.event }));
  }

  // ---------------- Приказы ----------------

  async submitOrder(matchId: string, userId: number, req: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    if (!req || typeof req.idempotencyKey !== 'string' || req.idempotencyKey.length < 8 || req.idempotencyKey.length > 80) throw new GameError('bad_idempotency_key');
    if (!req.order || typeof req.order !== 'object') throw new GameError('bad_order');
    const order = sanitizeOrder(req.order);
    const playerId = await this.playerIdFor(matchId, userId);
    return withTx(this.db, async tx => {
      // FOR SHARE: приём приказов не пересекается с расчётом хода (тот берёт FOR UPDATE).
      const { rows: [m] } = await tx.query('SELECT phase, turn FROM matches WHERE id=$1 FOR SHARE', [matchId]);
      // Сериализация приказов одного игрока.
      await tx.query('SELECT 1 FROM players WHERE match_id=$1 AND id=$2 FOR UPDATE', [matchId, playerId]);
      const { rows: dup } = await tx.query('SELECT id, subject, version, payload FROM orders WHERE match_id=$1 AND player_id=$2 AND idempotency_key=$3', [matchId, playerId, req.idempotencyKey]);
      if (dup.length) {
        const r = dup[0];
        return { ok: true, order: { id: r.id, subject: r.subject, version: r.version, order: r.payload } };
      }
      if (m.phase !== 'planning') return { ok: false, reason: 'not_planning' };
      if (req.turn !== m.turn) return { ok: false, reason: 'turn_closed' };
      const state = await loadStateCached(tx, matchId, m.turn);
      const subject = orderSubjectKey(order);
      const current = await this.activeOrders(tx, matchId, m.turn, playerId);
      const existing = current.find(o => o.subject === subject);
      if (req.baseVersion !== undefined && existing && existing.version !== req.baseVersion) return { ok: false, reason: 'version_conflict' };
      const others = current.filter(o => o.subject !== subject).map(o => o.order);
      const v = validateOrder(this.b, state, playerId, order, computeVision(this.b, state, playerId), others);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (existing) await tx.query(`UPDATE orders SET status='superseded' WHERE id=$1`, [existing.id]);
      const rec: OrderRecord = { id: randomUUID(), subject, version: (existing?.version ?? 0) + 1, order };
      await tx.query(
        `INSERT INTO orders (id, match_id, turn, player_id, subject, version, payload, idempotency_key, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
        [rec.id, matchId, m.turn, playerId, subject, rec.version, JSON.stringify(order), req.idempotencyKey],
      );
      await tx.query('UPDATE players SET ready=false WHERE match_id=$1 AND id=$2', [matchId, playerId]);
      await this.log(tx, matchId, playerId, 'order', { subject, version: rec.version });
      return { ok: true, order: rec, reserved: { gold: reservedGold(this.b, [...others, order]) } };
    });
  }

  async cancelOrder(matchId: string, userId: number, turn: number, subject: string): Promise<{ ok: boolean; reason?: string }> {
    const playerId = await this.playerIdFor(matchId, userId);
    return withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT phase, turn FROM matches WHERE id=$1 FOR SHARE', [matchId]);
      if (m.phase !== 'planning' || m.turn !== turn) return { ok: false, reason: 'turn_closed' };
      const r = await tx.query(`UPDATE orders SET status='cancelled' WHERE match_id=$1 AND turn=$2 AND player_id=$3 AND subject=$4 AND status='active'`, [matchId, turn, playerId, subject]);
      await tx.query('UPDATE players SET ready=false WHERE match_id=$1 AND id=$2', [matchId, playerId]);
      if (r.rowCount) await this.log(tx, matchId, playerId, 'order_cancelled', { subject });
      return { ok: true };
    });
  }

  async setReady(matchId: string, userId: number, turn: number, ready: boolean): Promise<{ ok: boolean; reason?: string }> {
    const playerId = await this.playerIdFor(matchId, userId);
    const res = await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT phase, turn FROM matches WHERE id=$1 FOR SHARE', [matchId]);
      if (m.phase !== 'planning' || m.turn !== turn) return { ok: false, reason: 'turn_closed' };
      await tx.query('UPDATE players SET ready=$3 WHERE match_id=$1 AND id=$2', [matchId, playerId, ready]);
      return { ok: true };
    });
    if (res.ok) {
      this.emit('ready_changed', { matchId, playerId, ready });
      if (ready) this.emit('maybe_due', matchId);
    }
    return res;
  }

  // ---------------- Расчёт хода ----------------

  /** Матчи, которым пора рассчитать ход: истёк срок или все живые люди готовы. */
  async dueMatches(): Promise<{ id: string; turn: number }[]> {
    const { rows } = await this.db.query(`
      SELECT m.id, m.turn FROM matches m
      WHERE m.phase = 'planning' AND (
        (m.deadline IS NOT NULL AND m.deadline <= now())
        OR NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = m.id AND NOT p.is_bot AND NOT p.eliminated AND NOT p.ready)
      )
      ORDER BY m.deadline NULLS FIRST LIMIT 20`);
    return rows;
  }

  /**
   * Рассчитать ход. Всё — одна транзакция под блокировкой строки партии:
   * сбой откатывает её целиком, повторный запуск даёт тот же результат, ресурсы не списываются дважды.
   */
  async processTurn(matchId: string, expectedTurn?: number): Promise<TurnResolvedInfo | null> {
    const t0 = performance.now();
    let resolvedState: GameState | null = null;
    const result = await withTx(this.db, async tx => {
      const { rows } = await tx.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE SKIP LOCKED', [matchId]);
      const m = rows[0];
      if (!m) return null; // другой обработчик уже считает этот ход
      if (m.phase !== 'planning') return null;
      if (expectedTurn !== undefined && m.turn !== expectedTurn) return null;
      const state = await loadState(tx, matchId);
      const active = await this.activeOrders(tx, matchId, m.turn);
      const orders: SubmittedOrder[] = active.map(o => ({ id: o.id, playerId: o.playerId, order: o.order }));
      for (const p of state.players.filter(p => p.isBot && !p.eliminated)) {
        botOrders(this.b, state, p.id).forEach((order, i) => orders.push({ id: `bot-${m.turn}-${p.id}-${String(i).padStart(3, '0')}`, playerId: p.id, order }));
      }
      const { state: next, events } = resolveTurn(this.b, state, orders);
      await saveState(tx, next);
      const roads = events.flatMap(e => (e.event.t === 'road_built' ? [e.event.at] : []));
      if (roads.length) await saveTileChanges(tx, matchId, next.map, roads, m.turn);
      resolvedState = next;
      if (events.length) {
        await tx.query(
          `INSERT INTO turn_events (match_id, turn, seq, phase, visible_to, event)
           SELECT $1, $2, (e->>'seq')::int, e->>'phase', ARRAY(SELECT jsonb_array_elements_text(e->'visibleTo')), e->'event'
           FROM jsonb_array_elements($3::jsonb) e`,
          [matchId, m.turn, JSON.stringify(events)],
        );
      }
      await tx.query(`UPDATE orders SET status='consumed' WHERE match_id=$1 AND turn=$2 AND status='active'`, [matchId, m.turn]);
      const alive = next.players.filter(p => !p.eliminated);
      const finished = alive.length <= 1;
      const winner = finished ? (alive[0]?.id ?? null) : null;
      const ms = Math.round(performance.now() - t0);
      await tx.query(`UPDATE turns SET status='resolved', resolved_at=now(), result_hash=$3, resolve_ms=$4 WHERE match_id=$1 AND number=$2`, [matchId, m.turn, stateHash(next), ms]);
      if (finished) {
        await tx.query(`UPDATE matches SET phase='finished', turn=$2, winner=$3, deadline=NULL, updated_at=now() WHERE id=$1`, [matchId, next.turn, winner]);
      } else {
        await tx.query('INSERT INTO turns (id, match_id, number, status, snapshot) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), matchId, next.turn, 'planning', JSON.stringify(stateToJson(next))]);
        const deadline = m.planning_seconds > 0 ? new Date(Date.now() + m.planning_seconds * 1000) : null;
        await tx.query(`UPDATE matches SET turn=$2, deadline=$3, updated_at=now() WHERE id=$1`, [matchId, next.turn, deadline]);
      }
      await tx.query('UPDATE players SET ready=false WHERE match_id=$1', [matchId]);
      await this.log(tx, matchId, 'system', 'turn_resolved', { turn: m.turn, events: events.length, ms });
      await this.queueTurnNotifications(tx, matchId, m.turn, state, events, finished, winner);
      return { matchId, turn: m.turn, events, finished, winner } satisfies TurnResolvedInfo;
    });
    // Публикуем и кешируем только после фиксации транзакции.
    const rs = resolvedState as GameState | null; // присваивается внутри транзакции
    if (result && rs) {
      setCachedMap(matchId, rs.map);
      setCachedState(rs);
    }
    if (result) this.emit('turn_resolved', result);
    return result;
  }

  private async queueTurnNotifications(tx: Tx, matchId: string, turn: number, before: GameState, events: StoredEvent[], finished: boolean, winner: string | null): Promise<void> {
    const ownerBefore = new Map(before.units.map(u => [u.id, u.owner]));
    const { rows: pl } = await tx.query('SELECT id, user_id FROM players WHERE match_id=$1 AND user_id IS NOT NULL', [matchId]);
    for (const p of pl) {
      const attacked = events.filter(e => e.event.t === 'attack' && e.event.kind !== 'counter' && ownerBefore.get(e.event.targetId) === p.id).length;
      const lostCities = events.filter(e => e.event.t === 'city_captured' && e.event.from === p.id).length;
      const kind = finished ? 'end' : 'turn';
      // Одно сообщение на игрока за ход: новые сведения объединяются в payload.
      await tx.query(
        `INSERT INTO notifications (user_id, match_id, kind, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
        [p.user_id, matchId, kind, JSON.stringify({ turn: turn + 1, attacked, lostCities, winner, won: winner === p.id }), `${kind}:${matchId}:${turn}:${p.user_id}`],
      );
    }
  }

  private async log(tx: Tx, matchId: string, actor: string, op: string, payload: unknown): Promise<void> {
    await tx.query('INSERT INTO operation_log (match_id, actor, op, payload) VALUES ($1,$2,$3,$4)', [matchId, actor, op, JSON.stringify(payload)]);
  }
}

/** Оставляет только известные поля приказа (защита от лишних данных в JSON). */
export function sanitizeOrder(o: any): Order {
  const coord = (c: any) => ({ x: Number(c?.x), y: Number(c?.y) });
  switch (o?.kind) {
    case 'unit':
      return {
        kind: 'unit',
        unitId: String(o.unitId ?? ''),
        mode: o.mode,
        path: Array.isArray(o.path) ? o.path.slice(0, 200).map(coord) : [],
        ...(o.targetUnitId ? { targetUnitId: String(o.targetUnitId) } : {}),
        ...(o.targetTile ? { targetTile: coord(o.targetTile) } : {}),
        ...(o.longRoute === true ? { longRoute: true, stopOnThreat: o.stopOnThreat !== false } : {}),
        ...(o.mode === 'build' ? { build: o.build === 'road' ? 'road' : (String(o.build) as 'road') } : {}),
      };
    case 'recruit':
      return { kind: 'recruit', cityId: String(o.cityId ?? ''), unitType: String(o.unitType ?? '') };
    case 'research':
      return { kind: 'research', queue: Array.isArray(o.queue) ? o.queue.slice(0, 16).map(String) : [] };
    default:
      throw new GameError('bad_order');
  }
}
