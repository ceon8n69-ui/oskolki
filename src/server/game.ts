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
import { computeAllVision, computeVision, updateExploredAndIntel } from '../engine/vision.ts';
import { newUnit } from '../engine/factory.ts';
import { isLandPassable } from '../engine/grid.ts';
import { playerView } from '../engine/view.ts';
import { GENERATOR_VERSION } from '../worldgen/generate.ts';
import { createInitialState } from '../worldgen/setup.ts';
import { generateWorldAsync } from '../worldgen/async.ts';
import type { Db, Tx } from './db/pool.ts';
import { withTx } from './db/pool.ts';
import { invalidateCachedState, loadState, loadStateCached, saveMap, saveState, saveTileChanges, setCachedMap, setCachedState, stateFromJson, stateHash, stateToJson } from './store.ts';

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
    const solo = preset === 'vsbot' || !!tp.tutorial;
    const maxPlayers = solo ? 2 : mp.players;
    await withTx(this.db, async tx => {
      await tx.query(
        `INSERT INTO matches (id, preset, phase, turn, seed, balance_version, rules_version, map_width, map_height, chunk_size, planning_seconds, max_players, invite_code, created_by, mode)
         VALUES ($1,$2,'lobby',0,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, preset, tp.tutorial ? 'tutorial-1' : randomBytes(8).toString('hex'), this.b.version, RULES_VERSION, mp.width, mp.height, this.b.map.chunkSize, tp.planningSeconds, maxPlayers, invite, userId, JSON.stringify(mode)],
      );
      await this.addPlayer(tx, id, userId, displayName, false, faction);
      if (tp.tutorial) {
        await this.addPlayer(tx, id, null, 'Разбойники', true, faction === 'ash' ? 'union' : 'ash');
      } else if (preset === 'vsbot') {
        // Бот берёт другой народ, чтобы партия проверяла их различия.
        const others = Object.keys(this.b.factions).filter(f => f !== faction);
        await this.addPlayer(tx, id, null, 'Бот', true, others[parseInt(id.slice(0, 2), 16) % others.length]);
      }
      await this.log(tx, id, `user:${userId}`, 'match_created', { preset, victory, turnLimit, alliances });
    });
    if (solo) await this.startMatch(id);
    return this.matchInfo(id);
  }

  private async addPlayer(tx: Tx, matchId: string, userId: number | null, name: string, isBot: boolean, faction = 'union'): Promise<string> {
    if (!this.b.factions[faction]) throw new GameError('unknown_faction');
    // Место — следующее после последнего: после выхода игрока из лобби номера не повторяются.
    const { rows } = await tx.query('SELECT coalesce(max(seat) + 1, 0)::int AS n FROM players WHERE match_id=$1', [matchId]);
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
      const { rows: [m] } = await tx.query('SELECT phase, deleted_at FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m || m.deleted_at) throw new GameError('match_not_found', 404);
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
      if (!m || m.deleted_at) throw new GameError('invite_not_found', 404);
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
    const { rows: [pre] } = await this.db.query('SELECT preset, seed, phase, deleted_at FROM matches WHERE id=$1', [matchId]);
    if (!pre || pre.deleted_at) throw new GameError('match_not_found', 404);
    if (pre.phase !== 'lobby') return;
    const preMp = this.b.map.presets[this.b.turnPresets[pre.preset].mapPreset];
    const world = await generateWorldAsync({ ...preMp, seed: pre.seed });
    if (!world.report.ok) throw new GameError('worldgen_failed', 500);
    let started: GameState | null = null;
    await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m || m.deleted_at) throw new GameError('match_not_found', 404); // удалена, пока строился мир
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
      if (tpm.tutorial) placeTutorialTarget(this.b, state);
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
    const { rows: pl } = await q.query('SELECT id, name, ready, is_bot, faction, color, replaced_by_bot, eliminated, surrendered_turn FROM players WHERE match_id=$1 ORDER BY seat', [matchId]);
    return {
      id: m.id, preset: m.preset, phase: m.deleted_at ? 'deleted' : m.phase, turn: m.turn, deadline: m.deadline ? new Date(m.deadline).toISOString() : null,
      maxPlayers: m.max_players, winner: m.winner, inviteCode: m.invite_code,
      winners: m.result?.winners ?? (m.winner ? [m.winner] : []),
      victory: m.mode?.victory, turnLimit: m.mode?.turnLimit ?? null, alliances: m.mode?.alliances ?? false,
      players: pl.map(p => ({ id: p.id, name: p.name, ready: p.ready, isBot: p.is_bot, faction: p.faction, color: p.color, replacedByBot: p.replaced_by_bot, eliminated: p.eliminated, surrendered: p.surrendered_turn !== null })),
    };
  }

  /** Сведения о партии с точки зрения пользователя: роль, сдача, архив. */
  async matchInfoFor(matchId: string, userId: number, q: Db | Tx = this.db): Promise<MatchInfo> {
    const info = await this.matchInfo(matchId, q);
    const { rows: [r] } = await q.query(
      `SELECT p.id, p.eliminated, p.surrendered_turn, m.created_by, EXISTS (SELECT 1 FROM match_hidden h WHERE h.user_id=$2 AND h.match_id=m.id) AS archived
       FROM matches m JOIN players p ON p.match_id=m.id AND p.user_id=$2 WHERE m.id=$1`, [matchId, userId]);
    if (r) info.me = { playerId: r.id, isCreator: Number(r.created_by) === userId, surrendered: r.surrendered_turn !== null, eliminated: r.eliminated, archived: r.archived };
    return info;
  }

  async playerIdFor(matchId: string, userId: number): Promise<string> {
    const { rows } = await this.db.query('SELECT id FROM players WHERE match_id=$1 AND user_id=$2', [matchId, userId]);
    if (!rows.length) throw new GameError('not_in_match', 403);
    return rows[0].id;
  }

  /** «Мои партии»: без удалённых комнат; архив — отдельно. */
  async listMatches(userId: number, archived = false): Promise<MatchInfo[]> {
    const { rows } = await this.db.query(
      `SELECT m.id FROM matches m JOIN players p ON p.match_id=m.id
       WHERE p.user_id=$1 AND m.deleted_at IS NULL
         AND ${archived ? '' : 'NOT '}EXISTS (SELECT 1 FROM match_hidden h WHERE h.user_id=$1 AND h.match_id=m.id)
       ORDER BY m.updated_at DESC LIMIT 100`,
      [userId],
    );
    return Promise.all(rows.map(r => this.matchInfoFor(r.id, userId)));
  }

  // ---------------- Комнаты: удаление, выход, сдача, архив ----------------

  /** Удалить комнату ожидания (только создатель). Мягкое удаление: строки и журнал остаются. Повтор — без ошибки. */
  async deleteRoom(matchId: string, userId: number): Promise<{ ok: true }> {
    await withTx(this.db, async tx => {
      // Та же блокировка строки, что у старта: удаление и запуск не пересекаются.
      const { rows: [m] } = await tx.query('SELECT phase, created_by, deleted_at FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m) throw new GameError('match_not_found', 404);
      const { rows: me } = await tx.query('SELECT id FROM players WHERE match_id=$1 AND user_id=$2', [matchId, userId]);
      if (!me.length && Number(m.created_by) !== userId) throw new GameError('not_in_match', 403);
      if (Number(m.created_by) !== userId) throw new GameError('only_creator_can_delete', 403);
      if (m.deleted_at) return;
      if (m.phase !== 'lobby') throw new GameError('match_already_started', 409);
      await tx.query('UPDATE matches SET deleted_at=now(), deleted_by=$2, updated_at=now() WHERE id=$1', [matchId, userId]);
      await this.log(tx, matchId, `user:${userId}`, 'room_deleted', {});
    });
    this.emit('match_changed', matchId);
    return { ok: true };
  }

  /** Покинуть комнату ожидания (участник, не создатель). Повтор — без ошибки. */
  async leaveRoom(matchId: string, userId: number): Promise<{ ok: true }> {
    await withTx(this.db, async tx => {
      const { rows: [m] } = await tx.query('SELECT phase, created_by, deleted_at FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m) throw new GameError('match_not_found', 404);
      const { rows: me } = await tx.query('SELECT id FROM players WHERE match_id=$1 AND user_id=$2', [matchId, userId]);
      if (!me.length) return; // уже вышел
      if (Number(m.created_by) === userId) throw new GameError('creator_must_delete', 409);
      if (m.deleted_at) return;
      if (m.phase !== 'lobby') throw new GameError('match_already_started', 409);
      await tx.query('DELETE FROM players WHERE match_id=$1 AND user_id=$2', [matchId, userId]);
      await this.log(tx, matchId, `user:${userId}`, 'left_room', { player: me[0].id });
    });
    this.emit('match_changed', matchId);
    return { ok: true };
  }

  /**
   * Сдача в идущей партии. Сразу: игрок исключается из ожидания готовности, его приказы хода отменяются,
   * новые приказы не принимаются. При расчёте хода сдача применяется первой (приказ «surrender» хранится
   * в журнале, ход воспроизводим): отряды распускаются, города становятся нейтральными.
   * Повтор — без ошибки и без повторного поражения.
   */
  async surrender(matchId: string, userId: number): Promise<{ ok: true; already: boolean }> {
    let resolveNow = false;
    const already = await withTx(this.db, async tx => {
      // Без SKIP LOCKED: ждём, если ход сейчас считается, — сдача попадёт в следующий ход.
      const { rows: [m] } = await tx.query('SELECT phase, turn, deleted_at FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      if (!m || m.deleted_at) throw new GameError('match_not_found', 404);
      const { rows: [p] } = await tx.query('SELECT id, eliminated, surrendered_turn FROM players WHERE match_id=$1 AND user_id=$2 FOR UPDATE', [matchId, userId]);
      if (!p) throw new GameError('not_in_match', 403);
      if (p.surrendered_turn !== null || p.eliminated || m.phase === 'finished') return true;
      if (m.phase === 'lobby') throw new GameError('match_not_started', 409);
      await tx.query(`UPDATE orders SET status='cancelled' WHERE match_id=$1 AND turn=$2 AND player_id=$3 AND status='active'`, [matchId, m.turn, p.id]);
      await tx.query(
        `INSERT INTO orders (id, match_id, turn, player_id, subject, version, payload, idempotency_key, status) VALUES ($1,$2,$3,$4,'surrender',1,$5,$6,'active')
         ON CONFLICT DO NOTHING`,
        [randomUUID(), matchId, m.turn, p.id, JSON.stringify({ kind: 'surrender' }), `surrender-${m.turn}`],
      );
      await tx.query('UPDATE players SET surrendered_turn=$3, ready=TRUE, is_bot=FALSE, replaced_by_bot=FALSE WHERE match_id=$1 AND id=$2', [matchId, p.id, m.turn]);
      await this.log(tx, matchId, p.id, 'surrendered', { turn: m.turn });
      // Если в партии не осталось противостоящих сторон — ход считается сразу, партия завершается.
      const { rows: left } = await tx.query('SELECT id FROM players WHERE match_id=$1 AND NOT eliminated AND surrendered_turn IS NULL', [matchId]);
      resolveNow = left.length <= 1;
      return false;
    });
    this.emit('match_changed', matchId);
    if (!already) {
      this.emit('maybe_due', matchId);
      if (resolveNow) await this.processTurn(matchId).catch(() => null);
    }
    return { ok: true, already };
  }

  /** Убрать партию из своего списка (только завершённую или после своего выбытия). */
  async archive(matchId: string, userId: number, hidden: boolean): Promise<{ ok: true }> {
    const { rows: [r] } = await this.db.query(
      'SELECT m.phase, m.deleted_at, p.eliminated, p.surrendered_turn FROM matches m JOIN players p ON p.match_id=m.id AND p.user_id=$2 WHERE m.id=$1',
      [matchId, userId],
    );
    if (!r) throw new GameError('not_in_match', 403);
    if (hidden) {
      const done = r.phase === 'finished' || r.deleted_at || r.eliminated || r.surrendered_turn !== null;
      if (!done) throw new GameError('match_in_progress', 409);
      await this.db.query('INSERT INTO match_hidden (user_id, match_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, matchId]);
    } else {
      await this.db.query('DELETE FROM match_hidden WHERE user_id=$1 AND match_id=$2', [userId, matchId]);
    }
    return { ok: true };
  }

  async activeOrders(q: Db | Tx, matchId: string, turn: number, playerId?: string): Promise<(OrderRecord & { playerId: string })[]> {
    const { rows } = await q.query(
      `SELECT id, subject, version, payload, player_id FROM orders WHERE match_id=$1 AND turn=$2 AND status='active' ${playerId ? 'AND player_id=$3' : ''} ORDER BY player_id, id`,
      playerId ? [matchId, turn, playerId] : [matchId, turn],
    );
    return rows.map(r => ({ id: r.id, subject: r.subject, version: r.version, order: r.payload, playerId: r.player_id }));
  }

  async getState(matchId: string, userId: number): Promise<StateResponse> {
    const match = await this.matchInfoFor(matchId, userId);
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

  // ---------------- Итоги, рейтинг, повтор ----------------

  /**
   * Итоги партии и рейтинг (Эло). Рейтинговые — партии хотя бы двух разных людей; боты не в счёт.
   * Каждый человек сравнивается с каждым: победитель против проигравшего — 1:0, оба победителя или оба проигравших — ничья.
   * Запись одна на пользователя и партию: повторный вызов ничего не меняет.
   */
  async recordResults(tx: Tx, matchId: string, winners: string[]): Promise<void> {
    const { rows: humans } = await tx.query(
      `SELECT p.id, p.user_id, p.surrendered_turn FROM players p WHERE p.match_id=$1 AND p.user_id IS NOT NULL ORDER BY p.user_id`, [matchId]);
    if (!humans.length) return;
    const { rows: done } = await tx.query('SELECT 1 FROM match_results WHERE match_id=$1 LIMIT 1', [matchId]);
    if (done.length) return;
    for (const h of humans) await tx.query('INSERT INTO ratings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [h.user_id]);
    const { rows: rr } = await tx.query('SELECT user_id, rating FROM ratings WHERE user_id = ANY($1::bigint[]) FOR UPDATE', [humans.map(h => h.user_id)]);
    const before = new Map(rr.map(r => [String(r.user_id), r.rating as number]));
    const rated = new Set(humans.map(h => String(h.user_id))).size >= 2;
    const won = (h: { id: string }) => winners.includes(h.id);
    const K = 32;
    for (const h of humans) {
      const rb = before.get(String(h.user_id))!;
      let delta = 0;
      if (rated) {
        const opp = humans.filter(o => String(o.user_id) !== String(h.user_id));
        for (const o of opp) {
          const ro = before.get(String(o.user_id))!;
          const expected = 1 / (1 + 10 ** ((ro - rb) / 400));
          const score = won(h) === won(o) ? 0.5 : won(h) ? 1 : 0;
          delta += (K / opp.length) * (score - expected);
        }
      }
      const ra = Math.round(rb + delta);
      const outcome = winners.length === 0 ? 'draw' : won(h) ? 'win' : 'loss';
      await tx.query(
        `INSERT INTO match_results (match_id, user_id, player_id, outcome, surrendered, rated, rating_before, rating_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [matchId, h.user_id, h.id, outcome, h.surrendered_turn !== null, rated, rb, ra],
      );
      await tx.query(
        `UPDATE ratings SET rating=$2, games=games + $3, wins=wins + $4, updated_at=now() WHERE user_id=$1`,
        [h.user_id, ra, rated ? 1 : 0, rated && outcome === 'win' ? 1 : 0],
      );
    }
  }

  async leaderboard(userId: number): Promise<{ top: { place: number; name: string; rating: number; games: number; wins: number; me: boolean }[]; me: { place: number; rating: number; games: number; wins: number } | null }> {
    const { rows } = await this.db.query(
      `SELECT r.user_id, r.rating, r.games, r.wins, coalesce(u.first_name, u.username, 'Игрок') AS name, rank() OVER (ORDER BY r.rating DESC) AS place
       FROM ratings r JOIN users u ON u.id=r.user_id WHERE r.games > 0 ORDER BY r.rating DESC, r.games DESC LIMIT 50`);
    const { rows: [me] } = await this.db.query(
      `SELECT rating, games, wins, (SELECT count(*)::int + 1 FROM ratings x WHERE x.games > 0 AND x.rating > r.rating) AS place FROM ratings r WHERE user_id=$1`, [userId]);
    return {
      top: rows.map(r => ({ place: Number(r.place), name: r.name, rating: r.rating, games: r.games, wins: r.wins, me: Number(r.user_id) === userId })),
      me: me ? { place: me.place, rating: me.rating, games: me.games, wins: me.wins } : null,
    };
  }

  /** Итоги завершённой партии: результат, владения в конце, события по игрокам, изменение рейтинга. */
  async summary(matchId: string, userId: number) {
    await this.playerIdFor(matchId, userId);
    const info = await this.matchInfo(matchId);
    if (info.phase !== 'finished') throw new GameError('match_in_progress', 409);
    const state = await loadStateCached(this.db, matchId);
    const { rows: ev } = await this.db.query(
      `SELECT event->>'t' AS t, coalesce(event->>'owner', event->>'to', event->>'playerId') AS p, count(*)::int AS n
       FROM turn_events WHERE match_id=$1 AND event->>'t' IN ('unit_destroyed', 'city_captured', 'unit_recruited', 'research_completed')
       GROUP BY 1, 2`, [matchId]);
    const { rows: res } = await this.db.query('SELECT player_id, outcome, rating_before, rating_after, rated FROM match_results WHERE match_id=$1', [matchId]);
    const count = (t: string, p: string) => ev.find(r => r.t === t && r.p === p)?.n ?? 0;
    return {
      matchId, turns: Math.max(1, info.turn - 1), winners: info.winners ?? [], reason: (state.mode.finished?.reason ?? null) as string | null,
      players: info.players.map(p => {
        const r = res.find(x => x.player_id === p.id);
        return {
          id: p.id, name: p.name, faction: p.faction, color: p.color, isBot: p.isBot, surrendered: !!p.surrendered,
          cities: state.cities.filter(c => c.owner === p.id).length,
          units: state.units.filter(u => u.owner === p.id).length,
          captured: count('city_captured', p.id), lost: count('unit_destroyed', p.id), recruited: count('unit_recruited', p.id), techs: count('research_completed', p.id),
          score: state.mode.scores[p.id] ?? null,
          rating: r ? { before: r.rating_before, after: r.rating_after, rated: r.rated } : null,
        };
      }),
    };
  }

  /**
   * Повтор хода N для участника: вид игрока до и после хода и его события (туман войны того хода сохраняется).
   * Доступны только уже рассчитанные ходы.
   */
  async replay(matchId: string, userId: number, turn: number): Promise<{ turn: number; before: StateResponse; after: StateResponse; events: StoredEvent[] }> {
    const playerId = await this.playerIdFor(matchId, userId);
    const { rows: [m] } = await this.db.query('SELECT * FROM matches WHERE id=$1', [matchId]);
    if (!Number.isInteger(turn) || turn < 1 || turn >= m.turn + (m.phase === 'finished' ? 1 : 0)) throw new GameError('turn_not_resolved', 409);
    const { rows: snaps } = await this.db.query('SELECT number, snapshot FROM turns WHERE match_id=$1 AND number IN ($2, $3) ORDER BY number', [matchId, turn, turn + 1]);
    const live = await loadStateCached(this.db, matchId);
    const before = snaps.find(s => s.number === turn);
    if (!before) throw new GameError('turn_not_found', 404);
    const sBefore = stateFromJson(before.snapshot, live.map);
    const afterRow = snaps.find(s => s.number === turn + 1);
    const sAfter = afterRow ? stateFromJson(afterRow.snapshot, live.map) : live;
    const match = await this.matchInfoFor(matchId, userId);
    const wrap = (s: GameState): StateResponse => ({ match, view: playerView(this.b, s, playerId), orders: [], reserved: { gold: 0, wood: 0, iron: 0, crystal: 0 } });
    return { turn, before: wrap(sBefore), after: wrap(sAfter), events: await this.getEvents(matchId, userId, turn) };
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
      const { rows: [pp] } = await tx.query('SELECT surrendered_turn, eliminated FROM players WHERE match_id=$1 AND id=$2', [matchId, playerId]);
      if (pp.surrendered_turn !== null || pp.eliminated) return { ok: false, reason: 'surrendered' };
      if (order.kind === 'surrender') return { ok: false, reason: 'use_surrender_endpoint' };
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
      const { rows: [pp] } = await tx.query('SELECT surrendered_turn, eliminated FROM players WHERE match_id=$1 AND id=$2', [matchId, playerId]);
      if (pp.surrendered_turn !== null || pp.eliminated) return { ok: false, reason: 'surrendered' };
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
        OR NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = m.id AND NOT p.is_bot AND NOT p.eliminated AND p.surrendered_turn IS NULL AND NOT p.ready)
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
      const botRows: { id: string; player: string; subject: string; payload: Order; key: string }[] = [];
      // Обучение: противник пассивен — стоит и ждёт, пока новичок осваивает приказы.
      const passive = !!this.b.turnPresets[m.preset]?.tutorial;
      for (const p of state.players.filter(p => p.isBot && !p.eliminated && !passive)) {
        const bo = botOrders(this.b, state, p.id);
        for (let i = 0; i < bo.length; i++) {
          const key = `bot-${m.turn}-${p.id}-${String(i).padStart(3, '0')}`;
          const id = deterministicUuid(`${matchId}/${key}`);
          orders.push({ id, playerId: p.id, order: bo[i] });
          botRows.push({ id, player: p.id, subject: subjectOf(bo[i]), payload: bo[i], key });
        }
      }
      if (botRows.length) {
        // Одним запросом: на полной карте это тысячи приказов.
        await tx.query(
          `INSERT INTO orders (id, match_id, turn, player_id, subject, version, payload, idempotency_key, status)
           SELECT (r->>'id')::uuid, $1, $2, r->>'player', r->>'subject', 1, r->'payload', r->>'key', 'consumed'
           FROM jsonb_array_elements($3::jsonb) r`,
          [matchId, m.turn, JSON.stringify(botRows)],
        );
      }
      const { state: next, events } = resolveTurn(this.b, state, orders);
      await saveState(tx, next);
      const roads = events.flatMap(e => (e.event.t === 'road_built' || e.event.t === 'fort_built' || e.event.t === 'forest_planted' || e.event.t === 'scorched' ? [e.event.at] : []));
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
        await this.recordResults(tx, matchId, winners);
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
    const { rows } = await tx.query('SELECT id, ready, missed_turns, is_bot, eliminated, user_id, surrendered_turn FROM players WHERE match_id=$1', [m.id]);
    const taken: string[] = [];
    for (const r of rows) {
      if (r.is_bot || r.eliminated || r.user_id === null || r.surrendered_turn !== null) continue;
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
      if (!m || m.deleted_at) throw new GameError('match_not_found', 404);
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
    case 'surrender':
      return { kind: 'surrender' };
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

/** Обучение: ослабленный разведчик противника в двух клетках от столицы игрока — цель первой атаки. */
export function placeTutorialTarget(b: Balance, state: GameState): void {
  const human = state.players.find(p => !p.isBot);
  const bot = state.players.find(p => p.isBot);
  const cap = human && state.cities.find(c => c.owner === human.id && c.isCapital);
  if (!human || !bot || !cap) return;
  const free = (x: number, y: number) => isLandPassable(b, state.map, x, y) && !state.units.some(u => u.x === x && u.y === y) && !state.cities.some(c => c.x === x && c.y === y);
  for (const [dx, dy] of [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 1], [1, 2], [-2, 1], [-1, 2], [2, -1], [1, -2], [-2, -1], [-1, -2]]) {
    const x = cap.x + dx, y = cap.y + dy;
    if (!free(x, y)) continue;
    const u = newUnit(b, state, { id: `u${state.nextIds.unit++}`, owner: bot.id, type: 'scout', x, y, createdTurn: 1 });
    u.hp = 3;
    state.units.push(u);
    updateExploredAndIntel(b, state, computeAllVision(b, state));
    return;
  }
}
