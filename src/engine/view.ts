// Отфильтрованное представление состояния для конкретного игрока.
// Всё, что уходит клиенту, проходит через эти функции: скрытые отряды и неисследованная местность не раскрываются.
import type { Balance } from '../shared/balance.ts';
import type { GameState, PlayerId, StoredEvent } from '../shared/types.ts';
import { idx } from './grid.ts';
import { incomeFor } from './resolve.ts';
import { computeVision, canSeeUnit } from './vision.ts';
import type { Vision } from './vision.ts';
import type { PlayerView, ChunkView } from '../shared/protocol.ts';

export const UNKNOWN_TILE = 255;

export function playerView(b: Balance, state: GameState, playerId: PlayerId, vision?: Vision): PlayerView {
  const me = state.players.find(p => p.id === playerId);
  if (!me) throw new Error('not a player');
  const v = vision ?? computeVision(b, state, playerId);
  const explored = state.explored[playerId];
  const intel = state.intel[playerId] ?? { units: {}, cities: {} };

  const units = state.units
    .filter(u => canSeeUnit(b, state, playerId, v, u))
    .map(u =>
      u.owner === playerId
        ? { ...u, statuses: u.statuses.map(s => ({ ...s })), stale: false as const }
        : { id: u.id, owner: u.owner, type: u.type, x: u.x, y: u.y, hp: u.hp, rank: u.rank, statuses: u.statuses.map(s => ({ ...s })), stale: false as const },
    );
  const visibleIds = new Set(units.map(u => u.id));
  const staleUnits = Object.values(intel.units)
    .filter(su => !visibleIds.has(su.id))
    .map(su => ({ id: su.id, owner: su.owner, type: su.type, x: su.x, y: su.y, hp: su.hp, seenTurn: su.seenTurn, stale: true as const }));

  const cities = state.cities
    .filter(c => c.owner === playerId || (explored && explored[idx(state.map, c.x, c.y)]))
    .map(c => {
      const visibleNow = c.owner === playerId || !!v.visible[idx(state.map, c.x, c.y)];
      if (c.owner === playerId) return { id: c.id, name: c.name, x: c.x, y: c.y, owner: c.owner, level: c.level, isCapital: c.isCapital, contestedBy: c.contestedBy, contestedSinceTurn: c.contestedSinceTurn, queue: c.queue.map(q => ({ ...q })), visibleNow, seenTurn: state.turn };
      const seen = intel.cities[c.id];
      if (visibleNow) return { id: c.id, name: c.name, x: c.x, y: c.y, owner: c.owner, level: c.level, isCapital: c.isCapital, contestedBy: c.contestedBy, contestedSinceTurn: c.contestedSinceTurn, queue: [], visibleNow, seenTurn: state.turn };
      return { id: c.id, name: c.name, x: c.x, y: c.y, owner: seen?.owner ?? null, level: seen?.level ?? c.level, isCapital: c.isCapital, contestedBy: seen?.contestedBy ?? null, contestedSinceTurn: null, queue: [], visibleNow, seenTurn: seen?.seenTurn ?? null };
    });

  return {
    matchId: state.matchId,
    turn: state.turn,
    balanceVersion: state.balanceVersion,
    rulesVersion: state.rulesVersion,
    map: { width: state.map.width, height: state.map.height, chunkSize: state.map.chunkSize },
    me: { ...me, researched: [...me.researched], researchQueue: [...me.researchQueue] },
    income: incomeFor(b, state, playerId),
    players: state.players.map(p => ({ id: p.id, name: p.name, faction: p.faction, color: p.color, eliminated: p.eliminated, isBot: p.isBot })),
    units,
    staleUnits,
    cities,
  };
}

export function chunkView(state: GameState, playerId: PlayerId, cx: number, cy: number, vision: Vision): ChunkView {
  const { map } = state;
  const cs = map.chunkSize;
  const explored = state.explored[playerId];
  const terrain: number[] = [];
  const features: number[] = [];
  const visible: number[] = [];
  for (let y = cy * cs; y < Math.min(map.height, (cy + 1) * cs); y++) {
    for (let x = cx * cs; x < Math.min(map.width, (cx + 1) * cs); x++) {
      const i = idx(map, x, y);
      const known = explored ? explored[i] === 1 : false;
      terrain.push(known ? map.terrain[i] : UNKNOWN_TILE);
      features.push(known ? map.features[i] : 0);
      visible.push(vision.visible[i]);
    }
  }
  return { cx, cy, size: cs, terrain, features, visible };
}

/** События хода, которые видит игрок. */
export function eventsFor(events: StoredEvent[], playerId: PlayerId): StoredEvent[] {
  return events.filter(e => e.visibleTo.includes(playerId));
}
