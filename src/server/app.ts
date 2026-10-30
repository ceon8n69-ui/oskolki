// HTTP API, WebSocket и раздача клиента.
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { Balance } from '../shared/balance.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import { moveOptions, previewAttack } from '../engine/preview.ts';
import { computeVision } from '../engine/vision.ts';
import { computeSupply } from '../engine/supply.ts';
import { chunkView, minimapView } from '../engine/view.ts';
import { asciiMap, generateWorld } from '../worldgen/generate.ts';
import type { TelegramBot } from '../bot/telegram.ts';
import { AuthError, signSession, verifyInitData, verifySession } from './auth.ts';
import type { ServerConfig } from './config.ts';
import type { Db } from './db/pool.ts';
import { GameError, sanitizeOrder } from './game.ts';
import type { GameService, TurnResolvedInfo } from './game.ts';
import { loadStateCached } from './store.ts';

const WEB_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const SESSION_TTL = 7 * 24 * 3600;

export async function buildApp(deps: { cfg: ServerConfig; db: Db; game: GameService; b: Balance; bot?: TelegramBot | null }) {
  const { cfg, db, game, b } = deps;
  const app = Fastify({ logger: cfg.env !== 'test' ? { level: 'info', redact: ['req.headers.authorization'] } : false, bodyLimit: 64 * 1024, trustProxy: true });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof GameError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof AuthError) return reply.code(401).send({ error: err.code });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'bad_request' });
    if (err.message === 'match_not_found') return reply.code(404).send({ error: 'match_not_found' });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  // ---------- авторизация ----------
  const auth = (req: FastifyRequest): number => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AuthError('no_token');
    return verifySession(h.slice(7), cfg.sessionSecret).uid;
  };
  const issue = (uid: number) => signSession({ uid, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, cfg.sessionSecret);
  const displayName = async (uid: number) => {
    const { rows: [u] } = await db.query('SELECT username, first_name FROM users WHERE id=$1', [uid]);
    return u?.first_name || u?.username || `Игрок ${uid}`;
  };

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, protocol: PROTOCOL_VERSION, balance: b.version };
  });

  app.post('/api/auth/telegram', async (req: FastifyRequest<{ Body: { initData?: string } }>) => {
    if (!cfg.botToken) throw new GameError('telegram_auth_not_configured', 503);
    const initData = String(req.body?.initData ?? '');
    const r = verifyInitData(initData, cfg.botToken, cfg.initDataMaxAgeSec);
    const { rows: [u] } = await db.query(
      `INSERT INTO users (telegram_id, username, first_name) VALUES ($1,$2,$3)
       ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_seen_at=now()
       RETURNING id`,
      [r.user.id, r.user.username ?? null, r.user.first_name ?? null],
    );
    return { token: issue(u.id), userId: u.id, name: r.user.first_name ?? r.user.username ?? '', startParam: r.startParam };
  });

  // Тестовая авторизация: только вне production и только при DEV_AUTH=1.
  if (cfg.devAuth && cfg.env !== 'production') {
    app.post('/api/auth/dev', async (req: FastifyRequest<{ Body: { name?: string } }>) => {
      const name = String(req.body?.name ?? 'dev').replace(/[^\p{L}\p{N}_ -]/gu, '').slice(0, 24) || 'dev';
      const { rows: [u] } = await db.query(
        `INSERT INTO users (telegram_id, username, first_name, is_dev) VALUES (NULL, $1, $1, TRUE) RETURNING id`,
        [name],
      );
      return { token: issue(u.id), userId: u.id, name, startParam: null };
    });
  }

  // ---------- партии ----------
  app.get('/api/matches', async (req: FastifyRequest<{ Querystring: { archived?: string } }>) => ({ matches: await game.listMatches(auth(req), req.query.archived === '1') }));
  // Комнаты: удаление (создатель, до старта), выход (участник, до старта), сдача (идущая партия), личный архив.
  app.delete('/api/matches/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => game.deleteRoom(req.params.id, auth(req)));
  app.post('/api/matches/:id/leave', async (req: FastifyRequest<{ Params: { id: string } }>) => game.leaveRoom(req.params.id, auth(req)));
  app.post('/api/matches/:id/surrender', async (req: FastifyRequest<{ Params: { id: string } }>) => game.surrender(req.params.id, auth(req)));
  app.post('/api/matches/:id/archive', async (req: FastifyRequest<{ Params: { id: string } }>) => game.archive(req.params.id, auth(req), true));
  app.delete('/api/matches/:id/archive', async (req: FastifyRequest<{ Params: { id: string } }>) => game.archive(req.params.id, auth(req), false));

  app.post('/api/matches', async (req: FastifyRequest<{ Body: { preset?: string; faction?: string; victory?: string; turnLimit?: number | null; alliances?: boolean } }>) => {
    const uid = auth(req);
    const body = req.body ?? {};
    return game.createMatch(uid, String(body.preset ?? 'quick'), await displayName(uid), String(body.faction ?? 'union'), {
      ...(body.victory ? { victory: String(body.victory) as 'influence' } : {}),
      ...(body.turnLimit !== undefined ? { turnLimit: body.turnLimit === null ? null : Number(body.turnLimit) } : {}),
      ...(typeof body.alliances === 'boolean' ? { alliances: body.alliances } : {}),
    });
  });

  app.post('/api/matches/:id/bots', async (req: FastifyRequest<{ Params: { id: string }; Body: { count?: number } }>) =>
    game.addBots(req.params.id, auth(req), Number(req.body?.count ?? 1)),
  );

  app.get('/api/matches/:id/markers', async (req: FastifyRequest<{ Params: { id: string } }>) => ({ markers: await game.listMarkers(req.params.id, auth(req)) }));
  app.post('/api/matches/:id/markers', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => ({ markers: await game.addMarker(req.params.id, auth(req), (req.body ?? {}) as any) }));
  app.delete('/api/matches/:id/markers/:markerId', async (req: FastifyRequest<{ Params: { id: string; markerId: string } }>) =>
    ({ markers: await game.deleteMarker(req.params.id, auth(req), Number(req.params.markerId)) }),
  );

  app.post('/api/matches/:id/faction', async (req: FastifyRequest<{ Params: { id: string }; Body: { faction?: string } }>) =>
    game.setFaction(req.params.id, auth(req), String(req.body?.faction ?? '')),
  );

  /** Справочник правил для интерфейса: юниты, технологии, постройки, народы, эффекты (из конфигурации баланса). */
  app.get('/api/rules', async () => b);

  app.post('/api/matches/join', async (req: FastifyRequest<{ Body: { inviteCode?: string; faction?: string } }>) => {
    const uid = auth(req);
    return game.joinByInvite(uid, String(req.body?.inviteCode ?? ''), await displayName(uid), String(req.body?.faction ?? 'union'));
  });

  app.get('/api/matches/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const uid = auth(req);
    await game.playerIdFor(req.params.id, uid);
    const info = await game.matchInfo(req.params.id);
    return { ...info, inviteLink: deps.bot ? deps.bot.inviteLink(info.inviteCode) : `${cfg.publicUrl}/?join=${info.inviteCode}` };
  });

  app.post('/api/matches/:id/start', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const uid = auth(req);
    await game.startMatch(req.params.id, uid);
    return game.matchInfo(req.params.id);
  });

  app.get('/api/matches/:id/state', async (req: FastifyRequest<{ Params: { id: string } }>) => game.getState(req.params.id, auth(req)));

  app.get('/api/matches/:id/chunks', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { list?: string } }>) => {
    const uid = auth(req);
    const pid = await game.playerIdFor(req.params.id, uid);
    const state = await loadStateCached(db, req.params.id);
    const v = computeVision(b, state, pid);
    const supply = computeSupply(b, state, pid);
    const maxCx = Math.ceil(state.map.width / state.map.chunkSize);
    const maxCy = Math.ceil(state.map.height / state.map.chunkSize);
    const list = String(req.query.list ?? '').split(';').filter(Boolean).slice(0, 64).map(s => s.split(',').map(Number));
    const chunks = list
      .filter(([cx, cy]) => Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cy >= 0 && cx < maxCx && cy < maxCy)
      .map(([cx, cy]) => chunkView(state, pid, cx, cy, v, supply));
    return { turn: state.turn, chunks };
  });

  app.get('/api/matches/:id/minimap', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const pid = await game.playerIdFor(req.params.id, auth(req));
    const state = await loadStateCached(db, req.params.id);
    const mm = minimapView(b, state, pid, computeVision(b, state, pid));
    return { ...mm, turn: state.turn, terrain: Buffer.from(mm.terrain).toString('base64') };
  });

  app.get('/api/matches/:id/events', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { turn?: string } }>) => {
    const turn = Number(req.query.turn);
    if (!Number.isInteger(turn) || turn < 1) throw new GameError('bad_turn');
    return { turn, events: await game.getEvents(req.params.id, auth(req), turn) };
  });

  app.post('/api/matches/:id/orders', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => game.submitOrder(req.params.id, auth(req), req.body as any));

  app.delete('/api/matches/:id/orders', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { subject?: string; turn?: string } }>) =>
    game.cancelOrder(req.params.id, auth(req), Number(req.query.turn), String(req.query.subject ?? '')),
  );

  app.post('/api/matches/:id/ready', async (req: FastifyRequest<{ Params: { id: string }; Body: { turn?: number; ready?: boolean } }>) =>
    game.setReady(req.params.id, auth(req), Number(req.body?.turn), req.body?.ready !== false),
  );

  app.get('/api/matches/:id/preview/moves', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { unitId?: string } }>) => {
    const pid = await game.playerIdFor(req.params.id, auth(req));
    const state = await loadStateCached(db, req.params.id);
    const orders = (await game.activeOrders(db, req.params.id, state.turn, pid)).map(o => o.order);
    return { tiles: moveOptions(b, state, pid, String(req.query.unitId ?? ''), computeVision(b, state, pid), orders) };
  });

  app.post('/api/matches/:id/preview/attack', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const pid = await game.playerIdFor(req.params.id, auth(req));
    const state = await loadStateCached(db, req.params.id);
    const body = req.body as any;
    const o = sanitizeOrder({ kind: "unit", mode: "attack", unitId: body?.unitId, path: body?.path, targetUnitId: body?.targetUnitId });
    if (o.kind !== 'unit') throw new GameError('bad_order');
    const orders = (await game.activeOrders(db, req.params.id, state.turn, pid)).map(x => x.order);
    return previewAttack(b, state, pid, o.unitId, o.path, o.targetUnitId ?? '', computeVision(b, state, pid), orders);
  });

  // ---------- администрирование ----------
  const admin = (req: FastifyRequest) => {
    if (!cfg.adminToken || req.headers['x-admin-token'] !== cfg.adminToken) throw new GameError('forbidden', 403);
  };
  app.get('/api/admin/worldgen', async (req: FastifyRequest<{ Querystring: { preset?: string; seed?: string } }>) => {
    admin(req);
    const preset = b.map.presets[String(req.query.preset ?? 'test32')];
    if (!preset) throw new GameError('unknown_preset');
    const w = generateWorld(b, { ...preset, seed: String(req.query.seed ?? 'admin') });
    return { report: w.report, ascii: preset.width <= 128 ? asciiMap(w.map, w.capitals, w.neutralCities) : null };
  });
  app.get('/api/admin/matches/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    admin(req);
    const { rows: [m] } = await db.query('SELECT id, preset, phase, turn, seed, generator_version, balance_version, rules_version, gen_report FROM matches WHERE id=$1', [req.params.id]);
    if (!m) throw new GameError('match_not_found', 404);
    const { rows: turns } = await db.query('SELECT number, status, resolved_at, result_hash, resolve_ms FROM turns WHERE match_id=$1 ORDER BY number', [req.params.id]);
    return { match: m, turns };
  });

  // ---------- Telegram webhook ----------
  if (deps.bot && cfg.botMode === 'webhook') {
    app.post('/telegram/webhook', async (req, reply: FastifyReply) => {
      if (!cfg.webhookSecret || req.headers['x-telegram-bot-api-secret-token'] !== cfg.webhookSecret) return reply.code(401).send();
      await deps.bot!.handleUpdate(req.body).catch(e => app.log.error(e));
      return { ok: true };
    });
  }

  // ---------- WebSocket ----------
  const subs = new Map<string, Set<{ ws: WebSocket; playerId: string }>>();
  const send = (ws: WebSocket, m: ServerMessage) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  app.get('/ws', { websocket: true }, (ws, req: FastifyRequest<{ Querystring: { token?: string } }>) => {
    let uid: number;
    try {
      uid = verifySession(String(req.query.token ?? ''), cfg.sessionSecret).uid;
    } catch {
      send(ws, { type: 'error', message: 'unauthorized' });
      ws.close(4401, 'unauthorized');
      return;
    }
    send(ws, { type: 'hello', protocol: PROTOCOL_VERSION });
    const mine: { matchId: string; entry: { ws: WebSocket; playerId: string } }[] = [];
    ws.on('message', async raw => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg?.type === 'ping') return;
      if (msg?.type === 'subscribe' && typeof msg.matchId === 'string' && mine.length < 8) {
        try {
          const playerId = await game.playerIdFor(msg.matchId, uid);
          const entry = { ws, playerId };
          (subs.get(msg.matchId) ?? subs.set(msg.matchId, new Set()).get(msg.matchId)!).add(entry);
          mine.push({ matchId: msg.matchId, entry });
          send(ws, { type: 'match', match: await game.matchInfo(msg.matchId) });
        } catch {
          send(ws, { type: 'error', message: 'cannot_subscribe' });
        }
      }
    });
    ws.on('close', () => {
      for (const m of mine) subs.get(m.matchId)?.delete(m.entry);
    });
  });
  const broadcast = async (matchId: string, msgFor: (playerId: string) => ServerMessage) => {
    for (const s of subs.get(matchId) ?? []) send(s.ws, msgFor(s.playerId));
  };
  game.on('turn_resolved', async (r: TurnResolvedInfo) => {
    const info = await game.matchInfo(r.matchId).catch(() => null);
    await broadcast(r.matchId, () => ({ type: 'turn_resolved', matchId: r.matchId, turn: r.turn }));
    if (info) await broadcast(r.matchId, () => ({ type: 'match', match: info }));
  });
  game.on('match_changed', async (matchId: string) => {
    const info = await game.matchInfo(matchId).catch(() => null);
    if (info) await broadcast(matchId, () => ({ type: 'match', match: info }));
  });
  game.on('ready_changed', (e: { matchId: string; playerId: string; ready: boolean }) => {
    void broadcast(e.matchId, () => ({ type: 'ready_changed', ...e }));
  });

  // ---------- клиент ----------
  if (existsSync(WEB_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') });
  }

  return app;
}
