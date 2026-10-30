// Отфильтрованное представление состояния для конкретного игрока.
// Всё, что уходит клиенту, проходит через эти функции: скрытые отряды и неисследованная местность не раскрываются.
import type { Balance } from '../shared/balance.ts';
import type { GameState, PlayerId, StoredEvent } from '../shared/types.ts';
import { idx } from './grid.ts';
import { incomeFor } from './resolve.ts';
import { computeVision, canSeeUnit } from './vision.ts';
import { linkedObelisks } from './world.ts';
import type { Vision } from './vision.ts';
import type { PlayerView, ChunkView } from '../shared/protocol.ts';

export const UNKNOWN_TILE = 255;

export function playerView(b: Balance, state: GameState, playerId: PlayerId, vision?: Vision): PlayerView {
  const me = state.players.find(p => p.id === playerId);
  if (!me) throw new Error('not a player');
  const v = vision ?? computeVision(b, state, playerId);
  const explored = state.explored[playerId];
  const intel = state.intel[playerId] ?? { units: {}, cities: {} };

  const cargo = new Map<string, number>();
  for (const u of state.units) if (u.carriedBy) cargo.set(u.carriedBy, (cargo.get(u.carriedBy) ?? 0) + 1);
  const withCargo = <T extends { id: string }>(o: T): T & { cargo?: number } => (cargo.has(o.id) ? { ...o, cargo: cargo.get(o.id) } : o);
  const units = state.units
    .filter(u => canSeeUnit(b, state, playerId, v, u))
    .map(u =>
      withCargo(u.owner === playerId
        ? { ...u, statuses: u.statuses.map(s => ({ ...s })), perks: [...u.perks], stale: false as const }
        : { id: u.id, owner: u.owner, type: u.type, x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, rank: u.rank, statuses: u.statuses.map(s => ({ ...s })), stale: false as const }),
    );
  const linked = new Set(linkedObelisks(b, state, playerId).map(o => o.id));
  const structures = state.world.structures
    .filter(s => s.owner === playerId || v.visible[idx(state.map, s.x, s.y)])
    .map(s => ({ id: s.id, kind: s.kind, owner: s.owner, x: s.x, y: s.y, linked: s.owner === playerId ? linked.has(s.id) : null }));
  const worldEvents = state.world.events
    .filter(e => e.startTurn <= state.turn && state.turn <= e.endTurn)
    .map(e => ({ id: e.id, name: b.worldEvents.list[e.id]?.name ?? e.id, description: b.worldEvents.list[e.id]?.description ?? '', startTurn: e.startTurn, endTurn: e.endTurn }));
  const lootedRuins = state.world.lootedRuins.filter(i => explored?.[i]);
  const visibleIds = new Set(units.map(u => u.id));
  const staleUnits = Object.values(intel.units)
    .filter(su => !visibleIds.has(su.id))
    .map(su => ({ id: su.id, owner: su.owner, type: su.type, x: su.x, y: su.y, hp: su.hp, seenTurn: su.seenTurn, stale: true as const }));

  const cities = state.cities
    .filter(c => c.owner === playerId || (explored && explored[idx(state.map, c.x, c.y)]))
    .map(c => {
      const visibleNow = c.owner === playerId || !!v.visible[idx(state.map, c.x, c.y)];
      if (c.owner === playerId) return { id: c.id, name: c.name, x: c.x, y: c.y, owner: c.owner, level: c.level, isCapital: c.isCapital, contestedBy: c.contestedBy, contestedSinceTurn: c.contestedSinceTurn, queue: c.queue.map(q => ({ ...q })), visibleNow, seenTurn: state.turn, buildings: [...c.buildings], food: c.food, specialization: c.specialization };
      const seen = intel.cities[c.id];
      if (visibleNow) return { id: c.id, name: c.name, x: c.x, y: c.y, owner: c.owner, level: c.level, isCapital: c.isCapital, contestedBy: c.contestedBy, contestedSinceTurn: c.contestedSinceTurn, queue: [], visibleNow, seenTurn: state.turn, buildings: c.buildings.filter(x => x === 'walls'), food: null, specialization: c.specialization };
      return { id: c.id, name: c.name, x: c.x, y: c.y, owner: seen?.owner ?? null, level: seen?.level ?? c.level, isCapital: c.isCapital, contestedBy: seen?.contestedBy ?? null, contestedSinceTurn: null, queue: [], visibleNow, seenTurn: seen?.seenTurn ?? null, buildings: [], food: null, specialization: null };
    });

  return {
    matchId: state.matchId,
    turn: state.turn,
    balanceVersion: state.balanceVersion,
    rulesVersion: state.rulesVersion,
    map: { width: state.map.width, height: state.map.height, chunkSize: state.map.chunkSize },
    me: structuredClone(me),
    income: incomeFor(b, state, playerId),
    players: state.players.map(p => ({ id: p.id, name: p.name, faction: p.faction, color: p.color, eliminated: p.eliminated, isBot: p.isBot })),
    units,
    staleUnits,
    cities,
    // Политическая карта открыта: статусы и объявленные разрывы видны всем, предложения — только сторонам.
    diplomacy: state.diplomacy.map(t => ({
      a: t.a, b: t.b, status: t.status, since: t.since, pending: t.pending,
      proposal: t.proposal && (t.a === playerId || t.b === playerId) ? t.proposal : null,
    })),
    mode: structuredClone(state.mode),
    structures,
    worldEvents,
    lootedRuins,
  };
}

export function chunkView(state: GameState, playerId: PlayerId, cx: number, cy: number, vision: Vision, supplyGrid?: Uint8Array): ChunkView {
  const { map } = state;
  const cs = map.chunkSize;
  const explored = state.explored[playerId];
  const terrain: number[] = [];
  const features: number[] = [];
  const visible: number[] = [];
  const supply: number[] = [];
  for (let y = cy * cs; y < Math.min(map.height, (cy + 1) * cs); y++) {
    for (let x = cx * cs; x < Math.min(map.width, (cx + 1) * cs); x++) {
      const i = idx(map, x, y);
      const known = explored ? explored[i] === 1 : false;
      terrain.push(known ? map.terrain[i] : UNKNOWN_TILE);
      features.push(known ? map.features[i] : 0);
      visible.push(vision.visible[i]);
      supply.push(supplyGrid ? supplyGrid[i] : 0);
    }
  }
  return { cx, cy, size: cs, terrain, features, visible, supply };
}

/**
 * Мини-карта: исследованная местность целиком (1 байт на клетку, 255 — неизвестно),
 * известные города и свои отряды. Чужие отряды — только видимые сейчас.
 */
export function minimapView(b: Balance, state: GameState, playerId: PlayerId, vision: Vision): MinimapView {
  const ex = state.explored[playerId];
  const n = state.map.width * state.map.height;
  const terrain = new Uint8Array(n);
  for (let i = 0; i < n; i++) terrain[i] = ex && ex[i] ? state.map.terrain[i] : UNKNOWN_TILE;
  const v = playerView(b, state, playerId, vision);
  return {
    width: state.map.width,
    height: state.map.height,
    terrain,
    cities: v.cities.map(c => ({ x: c.x, y: c.y, owner: c.owner, isCapital: c.isCapital })),
    units: v.units.map(u => ({ x: u.x, y: u.y, owner: u.owner })),
  };
}

export interface MinimapView {
  width: number;
  height: number;
  terrain: Uint8Array;
  cities: { x: number; y: number; owner: string | null; isCapital: boolean }[];
  units: { x: number; y: number; owner: string }[];
}

/** События хода, которые видит игрок. */
export function eventsFor(events: StoredEvent[], playerId: PlayerId): StoredEvent[] {
  return events.filter(e => e.visibleTo.includes(playerId));
}
