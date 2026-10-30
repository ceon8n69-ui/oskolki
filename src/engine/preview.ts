// Предпросмотр для интерфейса: доступные клетки и прогноз боя. Учитывает только то, что игрок видит.
import type { Balance } from '../shared/balance.ts';
import type { AttackPreview } from '../shared/protocol.ts';
import type { Coord, GameState, PlayerId } from '../shared/types.ts';
import { computeDamage } from './combat.ts';
import { idx } from './grid.ts';
import { reachable } from './path.ts';
import { validateOrder } from './validate.ts';
import type { Vision } from './vision.ts';
import { canSeeUnit } from './vision.ts';

export const SIMULTANEOUS_WARNING = 'Прогноз по текущему состоянию: одновременные приказы противника могут изменить результат.';

export function knownBlockers(b: Balance, state: GameState, playerId: PlayerId, vision: Vision): Set<number> {
  const out = new Set<number>();
  for (const u of state.units) {
    if (u.owner !== playerId && canSeeUnit(b, state, playerId, vision, u)) out.add(idx(state.map, u.x, u.y));
  }
  return out;
}

export function moveOptions(b: Balance, state: GameState, playerId: PlayerId, unitId: string, vision: Vision): { x: number; y: number; cost: number }[] {
  const u = state.units.find(x => x.id === unitId && x.owner === playerId);
  if (!u) return [];
  const r = reachable(b, state.map, u, b.units[u.type].move, knownBlockers(b, state, playerId, vision));
  return [...r].map(([i, cost]) => ({ x: i % state.map.width, y: Math.floor(i / state.map.width), cost }));
}

export function previewAttack(b: Balance, state: GameState, playerId: PlayerId, unitId: string, path: Coord[], targetUnitId: string, vision: Vision): AttackPreview {
  const v = validateOrder(b, state, playerId, { kind: 'unit', unitId, mode: 'attack', path, targetUnitId }, vision);
  if (!v.ok) return { ok: false, reason: v.reason, warning: SIMULTANEOUS_WARNING };
  const attacker = structuredClone(state.units.find(u => u.id === unitId)!);
  const end = path.length ? path[path.length - 1] : attacker;
  attacker.x = end.x;
  attacker.y = end.y;
  if (path.length) attacker.statuses = attacker.statuses.filter(s => s.id !== 'fortified');
  const target = state.units.find(u => u.id === targetUnitId)!;
  const r = computeDamage(b, state, attacker, target);
  return { ok: true, damage: r.damage, counter: r.counter, counterPossible: r.counterPossible && target.hp - r.damage > 0, modifiers: r.modifiers, warning: SIMULTANEOUS_WARNING };
}
