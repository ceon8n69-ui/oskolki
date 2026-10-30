// Сервис партий: лобби, приказы, готовность, расчёт хода.
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Balance } from '../shared/balance.ts';
import type { MatchInfo, OrderRecord, StateResponse, SubmitOrderRequest, SubmitOrderResponse } from '../shared/protocol.ts';
import type { BuildKind, GameState, Order, StoredEvent, SubmittedOrder, TreatyStatus } from '../shared/types.ts';
import { orderSubjectKey as subjectOf } from '../shared/types.ts';
import { allies } from '../engine/diplomacy.ts';
import { createHash } from 'node:crypto';
import { orderSubjectKey } from '../shared/types.ts';
import { botOrders } from '../ai/simple.ts';
import { RULES_VERSION, resolveTurn } from '../engine/resolve.ts';
import { reservedResources, validateOrder } from '../engine/validate.ts';
import { computeVision } from '../engine/vision.ts';
import { playerView } from '../engine/view.ts';
import { GENERATOR_VERSION } from '../worldgen/generate.ts';
import { createInitialState } from '../worldgen/setup.ts';
import { generateWorldAsync } from '../worldgen/async.ts';
import type { Db, Tx } from './db/pool.ts';
import { withTx } from './db/pool.ts';
import { invalidateCachedState, loadState, loadStateCached, saveMap, saveState, saveTileChanges, setCachedMap, setCachedState, stateHash, stateToJson } from './store.ts';

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

  async createMatch(userId: number, preset: string, displayName: string, faction = 'union', options: MatchOptions = {}): Promise<MatchInfo> {
    const tp = this.b.turnPresets[preset];
    if (!tp) throw new GameError('unknown_preset');
    // Условия победы выбираются до старта и дальше не меняются.
    const victory = options.victory ?? tp.victory;
    if (!this.b.victoryModes[victory]) throw new GameError('unknown_victory_mode');
    const turnLimit = options.turnLimit === undefined ? tp.turnLimit : options.turnLimit;
    if (turnLimit !== null && (!Number.isInteger(turnLimit) || turnLimit < 5 || turnLimit > 1000)) throw new GameError('bad_turn_limit');
    if (victory === 'influence' && turnLimit === null) throw new GameError('influence_needs_turn_limit');
    const alliances = options.alliances ?? tp.alliances;
    const mode = { victory, turnLimit, alliances, objectives: [], scores: {}, finished: null };
    const mp = this.b.map.presets[tp.mapPreset];
    const id = randomUUID();
    const invite = randomBytes(6).toString('base64url');
    const maxPlayers = preset === 'vsbot' ? 2 : mp.players;
    await withTx(this.db, async tx => {
      await tx.query(
        `INSERT INTO matches (id, preset, phase, turn, seed, balance_version, rules_version, map_width, map_height, chunk_size, planning_seconds, max_players, invite_code, created_by, mode)
         VALUES ($1,$2,'lobby',0,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, preset, randomBytes(8).toString('hex'), this.b.version, RULES_VERSION, mp.width, mp.height, this.b.map.chunkSize, tp.planningSeconds, maxPlayers, invite, userId, JSON.stringify(mode)],
      );
      await this.addPlayer(tx, id, userId, displayName, false, faction);
      if (preset === 'vsbot') {
        // Бот берёт другой народ, чтобы партия проверяла их различия.
        const others = Object.keys(this.b.factions).filter(f => f !== faction);
        await this.addPlayer(tx, id, null, 'Бот', true, others[parseInt(id.slice(0, 2), 16) % others.length]);
      }
      await this.log(tx, id, `user:${userId}`, 'match_created', { preset, victory, turnLimit, alliances });
    });
    if (preset === 'vsbot') await this.startMatch(id);
    return this.matchInfo(id);
  }

  private async addPlayer(tx: Tx, matchId: string, userId: number | null, name: string, isBot: boolean, faction = 'union'): Promise<string> {
    if (!this.b.factions[faction]) throw new GameError('unknown_faction');
    const { rows } = await tx.query('SELECT count(*)::int AS n FROM players WHERE match_id=$1', [matchId]);
    const seat = rows[0].n;
    const pid = `p${seat + 1}`;
    await tx.query(
      `INSERT INTO players (match_id, id, user_id, name, faction, color, is_bot, seat, gold) VALUES ($1,$2,$3,$4,$8,'#888',$5,$6,$7)`,
      [matchId, pid, userId, name.slice(0, 32), isBot, seat, this.b.economy.startGold, faction],
    );
    return pid;
  }

  /** Смена народа в лобби (до старта партии). */
  async setFaction(matchId: string, userId: number, faction: string): Promise<MatchInfo> {
    if (!this.b.factions[faction]) throw new GameError('unknown_faction');
    await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT phase FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m) throw new GameError('match_not_found', 404);
      if (m.phase !== 'lobby') throw new GameError('match_already_started', 409);
      const r = await tx.query('UPDATE players SET faction=$3 WHERE match_id=$1 AND user_id=$2', [matchId, userId, faction]);
      if (!r.rowCount) throw new GameError('not_in_match', 403);
    });
    this.emit('match_changed', matchId);
    return this.matchInfo(matchId);
  }

  async joinByInvite(userId: number, inviteCode: string, displayName: string, faction = 'union'): Promise<MatchInfo> {
    const matchId = await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT * FROM matches WHERE invite_code=$1 FOR UPDATE', [inviteCode]);
      if (!m) throw new GameError('invite_not_found', 404);
      const { rows: existing } = await tx.query('SELECT id FROM players WHERE match_id=$1 AND user_id=$2', [m.id, userId]);
      if (existing.length) return m.id as string; // повторный переход по ссылке открывает ту же партию
      if (m.phase !== 'lobby') throw new GameError('match_already_started', 409);
      const { rows: [{ n }] } = await tx.query('SELECT count(*)::int AS n FROM players WHERE match_id=$1', [m.id]);
      if (n >= m.max_players) throw new GameError('match_full', 409);
      await this.addPlayer(tx, m.id, userId, displayName, false, faction);
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
      const mm = m.mode ?? {};
      const tpm = this.b.turnPresets[m.preset];
      const { state } = createInitialState(this.b, {
        matchId,
        spec: { ...preMp, seed: m.seed },
        world,
        mode: { victory: mm.victory ?? tpm.victory, turnLimit: mm.turnLimit === undefined ? tpm.turnLimit : mm.turnLimit, alliances: mm.alliances ?? tpm.alliances },
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
    const { rows: pl } = await q.query('SELECT id, name, ready, is_bot, faction, color, replaced_by_bot FROM players WHERE match_id=$1 ORDER BY seat', [matchId]);
    return {
      id: m.id, preset: m.preset, phase: m.phase, turn: m.turn, deadline: m.deadline ? new Date(m.deadline).toISOString() : null,
      maxPlayers: m.max_players, winner: m.winner, inviteCode: m.invite_code,
      winners: m.result?.winners ?? (m.winner ? [m.winner] : []),
      victory: m.mode?.victory, turnLimit: m.mode?.turnLimit ?? null, alliances: m.mode?.alliances ?? false,
      players: pl.map(p => ({ id: p.id, name: p.name, ready: p.ready, isBot: p.is_bot, faction: p.faction, color: p.color, replacedByBot: p.replaced_by_bot })),
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
      reserved: reservedResources(this.b, state, playerId, orders.map(o => o.order)),
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
      await this.reclaimFromBot(tx, matchId, playerId);
      await this.log(tx, matchId, playerId, 'order', { subject, version: rec.version });
      return { ok: true, order: rec, reserved: reservedResources(this.b, state, playerId, [...others, order]) };
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
      await this.reclaimFromBot(tx, matchId, playerId);
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
      const takenOver = await this.applyBotTakeover(tx, m, state, active);
      const orders: SubmittedOrder[] = active.map(o => ({ id: o.id, playerId: o.playerId, order: o.order }));
      // Приказы ботов сохраняются как обычные приказы: журнал хода полный, расчёт воспроизводится без повторного запуска ИИ.
      for (const p of state.players.filter(p => p.isBot && !p.eliminated)) {
        const bo = botOrders(this.b, state, p.id);
        for (let i = 0; i < bo.length; i++) {
          const key = `bot-${m.turn}-${p.id}-${String(i).padStart(3, '0')}`;
          const id = deterministicUuid(`${matchId}/${key}`);
          orders.push({ id, playerId: p.id, order: bo[i] });
          await tx.query(
            `INSERT INTO orders (id, match_id, turn, player_id, subject, version, payload, idempotency_key, status) VALUES ($1,$2,$3,$4,$5,1,$6,$7,'consumed')`,
            [id, matchId, m.turn, p.id, subjectOf(bo[i]), JSON.stringify(bo[i]), key],
          );
        }
      }
      const { state: next, events } = resolveTurn(this.b, state, orders);
      await saveState(tx, next);
      const roads = events.flatMap(e => (e.event.t === 'road_built' || e.event.t === 'fort_built' || e.event.t === 'forest_planted' ? [e.event.at] : []));
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
      const finished = !!next.mode.finished;
      const winners = next.mode.finished?.winners ?? [];
      const winner = winners[0] ?? null;
      const ms = Math.round(performance.now() - t0);
      await tx.query(`UPDATE turns SET status='resolved', resolved_at=now(), result_hash=$3, resolve_ms=$4 WHERE match_id=$1 AND number=$2`, [matchId, m.turn, stateHash(next), ms]);
      if (finished) {
        await tx.query(`UPDATE matches SET phase='finished', turn=$2, winner=$3, result=$4, deadline=NULL, updated_at=now() WHERE id=$1`, [matchId, next.turn, winner, JSON.stringify(next.mode.finished)]);
      } else {
        await tx.query('INSERT INTO turns (id, match_id, number, status, snapshot) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), matchId, next.turn, 'planning', JSON.stringify(stateToJson(next))]);
        const deadline = m.planning_seconds > 0 ? new Date(Date.now() + m.planning_seconds * 1000) : null;
        await tx.query(`UPDATE matches SET turn=$2, deadline=$3, updated_at=now() WHERE id=$1`, [matchId, next.turn, deadline]);
      }
      await tx.query('UPDATE players SET ready=false WHERE match_id=$1', [matchId]);
      await this.log(tx, matchId, 'system', 'turn_resolved', { turn: m.turn, events: events.length, ms });
      await this.queueTurnNotifications(tx, matchId, m.turn, state, events, finished, winners, takenOver);
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

  private async queueTurnNotifications(tx: Tx, matchId: string, turn: number, before: GameState, events: StoredEvent[], finished: boolean, winners: string[], takenOver: string[]): Promise<void> {
    const ownerBefore = new Map(before.units.map(u => [u.id, u.owner]));
    const { rows: pl } = await tx.query('SELECT id, user_id FROM players WHERE match_id=$1 AND user_id IS NOT NULL', [matchId]);
    for (const p of pl) {
      const attacked = events.filter(e => e.event.t === 'attack' && e.event.kind !== 'counter' && ownerBefore.get(e.event.targetId) === p.id).length;
      const lostCities = events.filter(e => e.event.t === 'city_captured' && e.event.from === p.id).length;
      const proposals = events.filter(e => e.event.t === 'diplomacy_proposed' && e.event.to === p.id).length;
      const breaks = events.filter(e => e.event.t === 'diplomacy_break_announced' && e.event.to === p.id).length;
      const kind = finished ? 'end' : 'turn';
      // Одно сообщение на игрока за ход: новые сведения объединяются в payload.
      await tx.query(
        `INSERT INTO notifications (user_id, match_id, kind, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
        [p.user_id, matchId, kind, JSON.stringify({ turn: turn + 1, attacked, lostCities, proposals, breaks, botTakeover: takenOver.includes(p.id), winners, won: winners.includes(p.id) }), `${kind}:${matchId}:${turn}:${p.user_id}`],
      );
    }
  }

  /**
   * Замещение ботом: человек, пропустивший подряд botTakeoverAfter ходов (ни приказов, ни готовности),
   * передаёт управление боту. Любой его приказ или «Готов» возвращает управление.
   */
  private async applyBotTakeover(tx: Tx, m: any, state: GameState, active: { playerId: string }[]): Promise<string[]> {
    const after = this.b.turnPresets[m.preset]?.botTakeoverAfter ?? null;
    const { rows } = await tx.query('SELECT id, ready, missed_turns, is_bot, eliminated, user_id FROM players WHERE match_id=$1', [m.id]);
    const taken: string[] = [];
    for (const r of rows) {
      if (r.is_bot || r.eliminated || r.user_id === null) continue;
      const acted = r.ready || active.some(o => o.playerId === r.id);
      const missed = acted ? 0 : r.missed_turns + 1;
      if (after !== null && missed >= after) {
        await tx.query('UPDATE players SET missed_turns=$3, is_bot=TRUE, replaced_by_bot=TRUE WHERE match_id=$1 AND id=$2', [m.id, r.id, missed]);
        const p = state.players.find(x => x.id === r.id);
        if (p) p.isBot = true;
        taken.push(r.id);
        await this.log(tx, m.id, 'system', 'bot_takeover', { player: r.id, missed });
      } else {
        await tx.query('UPDATE players SET missed_turns=$3 WHERE match_id=$1 AND id=$2', [m.id, r.id, missed]);
      }
    }
    return taken;
  }

  /** Игрок вернулся: отдаёт приказ или жмёт «Готов» — управление снова у него. */
  private async reclaimFromBot(tx: Tx, matchId: string, playerId: string): Promise<void> {
    const r = await tx.query('UPDATE players SET is_bot=FALSE, replaced_by_bot=FALSE, missed_turns=0 WHERE match_id=$1 AND id=$2 AND replaced_by_bot', [matchId, playerId]);
    if (r.rowCount) {
      invalidateCachedState(matchId);
      await this.log(tx, matchId, playerId, 'bot_takeover_reclaimed', {});
    }
  }

  /** Добавить ботов в лобби (создатель партии). */
  async addBots(matchId: string, userId: number, count: number): Promise<MatchInfo> {
    if (!Number.isInteger(count) || count < 1 || count > 31) throw new GameError('bad_count');
    const info = await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m) throw new GameError('match_not_found', 404);
      if (m.created_by !== userId) throw new GameError('only_creator', 403);
      if (m.phase !== 'lobby') throw new GameError('match_already_started', 409);
      const { rows: [{ n }] } = await tx.query('SELECT count(*)::int AS n FROM players WHERE match_id=$1', [matchId]);
      const factions = Object.keys(this.b.factions);
      const add = Math.min(count, m.max_players - n);
      for (let i = 0; i < add; i++) await this.addPlayer(tx, matchId, null, `Бот ${n + i}`, true, factions[(n + i) % factions.length]);
      return add;
    });
    void info;
    this.emit('match_changed', matchId);
    return this.matchInfo(matchId);
  }

  // ---------------- Метки ----------------

  async listMarkers(matchId: string, userId: number) {
    const pid = await this.playerIdFor(matchId, userId);
    const state = await loadStateCached(this.db, matchId);
    const visibleFrom = [pid, ...allies(this.b, state, pid)];
    const { rows } = await this.db.query(
      'SELECT id, player_id, x, y, label, shared, created_turn FROM markers WHERE match_id=$1 AND (player_id=$2 OR (shared AND player_id = ANY($3))) ORDER BY id',
      [matchId, pid, visibleFrom],
    );
    return rows.map(r => ({ id: Number(r.id), playerId: r.player_id, x: r.x, y: r.y, label: r.label, shared: r.shared, turn: r.created_turn }));
  }

  async addMarker(matchId: string, userId: number, body: { x?: number; y?: number; label?: string; shared?: boolean }) {
    const pid = await this.playerIdFor(matchId, userId);
    const state = await loadStateCached(this.db, matchId);
    const x = Number(body.x), y = Number(body.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= state.map.width || y >= state.map.height) throw new GameError('bad_coord');
    const label = String(body.label ?? '').trim().slice(0, 40);
    if (!label) throw new GameError('empty_label');
    const { rows: [{ n }] } = await this.db.query('SELECT count(*)::int n FROM markers WHERE match_id=$1 AND player_id=$2', [matchId, pid]);
    if (n >= 30) throw new GameError('too_many_markers');
    await this.db.query('INSERT INTO markers (match_id, player_id, x, y, label, shared, created_turn) VALUES ($1,$2,$3,$4,$5,$6,$7)', [matchId, pid, x, y, label, body.shared !== false, state.turn]);
    return this.listMarkers(matchId, userId);
  }

  async deleteMarker(matchId: string, userId: number, id: number) {
    const pid = await this.playerIdFor(matchId, userId);
    await this.db.query('DELETE FROM markers WHERE match_id=$1 AND player_id=$2 AND id=$3', [matchId, pid, id]);
    return this.listMarkers(matchId, userId);
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
        ...(o.mode === 'build' ? { build: String(o.build ?? 'road') as BuildKind } : {}),
        ...(o.ability === 'knockback' ? { ability: 'knockback' as const } : {}),
      };
    case 'recruit':
      return { kind: 'recruit', cityId: String(o.cityId ?? ''), unitType: String(o.unitType ?? '') };
    case 'research':
      return { kind: 'research', queue: Array.isArray(o.queue) ? o.queue.slice(0, 16).map(String) : [] };
    case 'construct':
      return { kind: 'construct', cityId: String(o.cityId ?? ''), building: String(o.building ?? '') };
    case 'specialize':
      return { kind: 'specialize', cityId: String(o.cityId ?? ''), specialization: String(o.specialization ?? '') };
    case 'promote':
      return { kind: 'promote', unitId: String(o.unitId ?? ''), perk: String(o.perk ?? '') };
    case 'diplomacy':
      return {
        kind: 'diplomacy',
        action: ['propose', 'accept', 'decline', 'break'].includes(o.action) ? o.action : 'propose',
        target: String(o.target ?? ''),
        ...(o.status ? { status: String(o.status) as TreatyStatus } : {}),
      };
    case 'commander':
      return {
        kind: 'commander',
        action: o.action === 'direction' ? 'direction' : 'ability',
        ...(o.ability ? { ability: String(o.ability) } : {}),
        ...(o.direction ? { direction: String(o.direction) } : {}),
        ...(o.target ? { target: coord(o.target) } : {}),
      };
    default:
      throw new GameError('bad_order');
  }
}

export interface MatchOptions {
  victory?: 'influence' | 'capitals' | 'elimination';
  turnLimit?: number | null;
  alliances?: boolean;
}

/** UUID, детерминированно получаемый из строки (для приказов ботов: тот же порядок при воспроизведении). */
export function deterministicUuid(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
