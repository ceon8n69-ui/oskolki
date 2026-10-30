// Долгие маршруты: путь длиннее одного хода продолжается автоматически, пока его не отменят,
// не заблокируют или пока рядом не появится угроза (если так задано в приказе).
import type { Balance } from '../shared/balance.ts';
import type { Coord, GameState, PlayerId, TurnEvent, UnitOrder, UnitState } from '../shared/types.ts';
import { dist, isAdjacent, landMoveCost } from './grid.ts';
import type { Vision } from './vision.ts';
import { canSeeUnit } from './vision.ts';

interface Log {
  push(event: TurnEvent, visibleTo: Iterable<PlayerId>): void;
}

/** Префикс пути, который укладывается в бюджет движения отряда за ход. */
export function prefixWithinBudget(b: Balance, state: GameState, u: UnitState, path: Coord[]): Coord[] {
  const out: Coord[] = [];
  let spent = 0;
  let cur: Coord = u;
  for (const s of path) {
    const c = landMoveCost(b, state.map, cur, s);
    if (c === null || !isAdjacent(cur, s) || spent + c > b.units[u.type].move + 1e-9) break;
    spent += c;
    out.push(s);
    cur = s;
  }
  return out;
}

function threatNear(b: Balance, state: GameState, u: UnitState, v: Vision): boolean {
  const r = b.routes.threatRadius;
  return state.units.some(e => e.owner !== u.owner && e.hp > 0 && dist(e, u) <= r && canSeeUnit(b, state, u.owner, v, e));
}

/**
 * Фаза подготовки:
 * — явный приказ с longRoute: ход выполняет префикс в пределах бюджета, остаток сохраняется на отряде;
 * — любой другой явный приказ отменяет сохранённый маршрут;
 * — отряд без приказа с маршрутом продолжает движение (или останавливается при угрозе).
 */
export function planRoutes(b: Balance, state: GameState, unitOrders: Map<string, UnitOrder>, log: Log, vision0: Map<PlayerId, Vision>): void {
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    if (o) {
      if (o.mode === 'move' && o.longRoute) {
        const now = prefixWithinBudget(b, state, u, o.path);
        const rest = o.path.slice(now.length);
        u.route = rest.length ? { path: rest, stopOnThreat: o.stopOnThreat !== false, orderedTurn: state.turn } : null;
        unitOrders.set(u.id, { ...o, path: now });
      } else {
        u.route = null;
      }
      continue;
    }
    if (!u.route || !u.route.path.length) continue;
    const v = vision0.get(u.owner);
    if (!v) continue;
    if (u.route.stopOnThreat && threatNear(b, state, u, v)) {
      u.route = null;
      log.push({ t: 'route_paused', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, reason: 'threat' }, [u.owner]);
      continue;
    }
    const now = prefixWithinBudget(b, state, u, u.route.path);
    if (!now.length) {
      u.route = null;
      log.push({ t: 'route_paused', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, reason: 'invalid' }, [u.owner]);
      continue;
    }
    // Видимый противник на ближайших шагах — остановка без раскрытия невидимых.
    const visibleBlock = now.some(s => state.units.some(e => e.owner !== u.owner && e.x === s.x && e.y === s.y && canSeeUnit(b, state, u.owner, v, e)));
    if (visibleBlock) {
      u.route = null;
      log.push({ t: 'route_paused', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, reason: 'blocked' }, [u.owner]);
      continue;
    }
    u.route = { ...u.route, path: u.route.path.slice(now.length) };
    unitOrders.set(u.id, { kind: 'unit', unitId: u.id, mode: 'move', path: now });
    log.push({ t: 'route_continued', unitId: u.id, owner: u.owner, remaining: u.route.path.length + now.length }, [u.owner]);
  }
}

/** После движения: недошедший остаток возвращается в маршрут, при угрозе маршрут останавливается. */
export function updateRoutesAfterMove(
  b: Balance,
  state: GameState,
  unitOrders: Map<string, UnitOrder>,
  moved: Map<string, { executed: number; blocked: string | null }>,
  log: Log,
  vision1: Map<PlayerId, Vision>,
): void {
  for (const u of state.units) {
    const o = unitOrders.get(u.id);
    const m = moved.get(u.id);
    if (!u.route) continue;
    if (o?.mode === 'move' && m && m.executed < o.path.length) {
      if (m.blocked === 'unexpected_obstacle') {
        u.route = null;
        log.push({ t: 'route_paused', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, reason: 'blocked' }, [u.owner]);
        continue;
      }
      // Временная помеха (спор за клетку, свой отряд) — повторим в следующем ходу.
      u.route = { ...u.route, path: [...o.path.slice(m.executed), ...u.route.path] };
    }
    if (!u.route.path.length) {
      u.route = null;
      log.push({ t: 'route_completed', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y } }, [u.owner]);
      continue;
    }
    const v = vision1.get(u.owner);
    if (v && u.route.stopOnThreat && threatNear(b, state, u, v)) {
      u.route = null;
      log.push({ t: 'route_paused', unitId: u.id, owner: u.owner, at: { x: u.x, y: u.y }, reason: 'threat' }, [u.owner]);
    }
  }
}
