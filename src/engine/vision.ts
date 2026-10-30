import type { Balance } from '../shared/balance.ts';
import { terrainRule } from '../shared/balance.ts';
import type { GameState, PlayerId, UnitState } from '../shared/types.ts';
import { NEUTRAL } from '../shared/types.ts';
import { idx, inBounds, terrainAt } from './grid.ts';
import { commanderAura, techs, visionOf } from './stats.ts';
import { allies } from './diplomacy.ts';
import { linkedObelisks } from './world.ts';

export interface Vision {
  /** 1 — клетка видна сейчас. */
  visible: Uint8Array;
  /** 1 — рядом (≤1) есть наблюдатель: видит отряды в лесу. */
  close: Uint8Array;
}

function stamp(state: GameState, grid: Uint8Array, cx: number, cy: number, r: number): void {
  const map = state.map;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (inBounds(map, x, y)) grid[idx(map, x, y)] = 1;
    }
  }
}

/** Дополнительный временный источник обзора (например, «Разведывательный импульс» командира). */
export interface ExtraVision {
  owner: PlayerId;
  x: number;
  y: number;
  r: number;
}

export function computeVision(b: Balance, state: GameState, playerId: PlayerId, extra: ExtraVision[] = []): Vision {
  const n = state.map.width * state.map.height;
  const visible = new Uint8Array(n);
  const close = new Uint8Array(n);
  // Союзники делят обзор (ограниченный обмен разведданными — только текущий обзор, без их памяти).
  const sources = new Set<PlayerId>([playerId]);
  if (b.diplomacy.statuses.alliance.shareVision) for (const a of allies(b, state, playerId)) sources.add(a);
  for (const u of state.units) {
    if (!sources.has(u.owner) || u.hp <= 0) continue;
    const bonus = terrainRule(b, terrainAt(state.map, u.x, u.y)).visionBonus + commanderAura(b, state, u.owner, u, 'scouting');
    stamp(state, visible, u.x, u.y, visionOf(b, state, u) + bonus);
    stamp(state, close, u.x, u.y, 1);
  }
  const cityBonus = techs(b, state, playerId).cityVisionBonus;
  for (const c of state.cities) {
    if (!c.owner || !sources.has(c.owner)) continue;
    stamp(state, visible, c.x, c.y, b.cities.visionRadius + cityBonus);
    stamp(state, close, c.x, c.y, 1);
  }
  // Связанные обелиски — постоянные источники обзора.
  for (const src of sources) {
    for (const o of linkedObelisks(b, state, src)) {
      stamp(state, visible, o.x, o.y, b.obelisks.visionRadius);
      stamp(state, close, o.x, o.y, 1);
    }
  }
  for (const e of extra) if (e.owner === playerId) stamp(state, visible, e.x, e.y, e.r);
  return { visible, close };
}

export function computeAllVision(b: Balance, state: GameState, extra: ExtraVision[] = []): Map<PlayerId, Vision> {
  const out = new Map<PlayerId, Vision>();
  for (const p of state.players) out.set(p.id, computeVision(b, state, p.id, extra));
  return out;
}

/** Видит ли игрок отряд, стоящий на клетке (x,y). Свои отряды видны всегда. */
export function canSeeUnitAt(b: Balance, state: GameState, v: Vision, x: number, y: number): boolean {
  const i = idx(state.map, x, y);
  if (!v.visible[i]) return false;
  if (terrainRule(b, terrainAt(state.map, x, y)).hidesUnits && !v.close[i]) return false;
  return true;
}

export function canSeeUnit(b: Balance, state: GameState, viewer: PlayerId, v: Vision, u: UnitState): boolean {
  if (u.owner === viewer) return true;
  // Груз транспорта противнику не виден: видно только число отрядов на борту.
  if (u.carriedBy) return false;
  return canSeeUnitAt(b, state, v, u.x, u.y);
}

/** Отметить видимые клетки как исследованные и обновить разведданные. */
export function updateExploredAndIntel(b: Balance, state: GameState, vision: Map<PlayerId, Vision>): void {
  for (const p of state.players) {
    const v = vision.get(p.id)!;
    let ex = state.explored[p.id];
    if (!ex) ex = state.explored[p.id] = new Uint8Array(state.map.width * state.map.height);
    for (let i = 0; i < ex.length; i++) if (v.visible[i]) ex[i] = 1;

    const intel = (state.intel[p.id] ??= { units: {}, cities: {} });
    // Убираем устаревшие отметки там, где клетка видна сейчас (отряда там уже может не быть).
    for (const [id, su] of Object.entries(intel.units)) {
      if (v.visible[idx(state.map, su.x, su.y)] && canSeeUnitAt(b, state, v, su.x, su.y)) delete intel.units[id];
    }
    for (const u of state.units) {
      if (u.owner === p.id || u.hp <= 0) continue;
      if (canSeeUnit(b, state, p.id, v, u)) {
        intel.units[u.id] = { id: u.id, owner: u.owner, type: u.type, x: u.x, y: u.y, hp: u.hp, seenTurn: state.turn };
      }
    }
    for (const c of state.cities) {
      if (v.visible[idx(state.map, c.x, c.y)]) {
        intel.cities[c.id] = { owner: c.owner, level: c.level, contestedBy: c.contestedBy, seenTurn: state.turn };
      }
    }
  }
}

export function isNeutral(owner: PlayerId | null): boolean {
  return owner === null || owner === NEUTRAL;
}
