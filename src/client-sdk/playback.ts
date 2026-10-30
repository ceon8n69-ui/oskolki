// Превращает журнал событий хода в временную шкалу для анимаций.
// Анимации только показывают уже рассчитанный сервером результат: их завершение ни на что не влияет.
import type { Coord, StoredEvent, TurnEvent } from '../shared/types.ts';

export type StepKind =
  | 'fortify' | 'move' | 'blocked' | 'attack' | 'impact' | 'counter' | 'destroy' | 'attack_failed'
  | 'contest' | 'contest_cleared' | 'capture' | 'recruit' | 'rank_up' | 'research' | 'income' | 'info';

export interface PlaybackStep {
  id: number;
  kind: StepKind;
  start: number; // мс от начала при скорости ×1
  duration: number;
  event: TurnEvent;
  focus: Coord | null; // куда смотреть камере
  important: boolean; // касается игрока напрямую
  /** Для impact: урон, который нужно показать числом в момент попадания. */
  damage?: number;
}

export interface Timeline {
  steps: PlaybackStep[];
  total: number;
}

export interface TimelineOptions {
  moveStepMs?: number;
  attackMs?: number;
  impactDelayMs?: number;
  reducedMotion?: boolean;
}

export function buildTimeline(events: StoredEvent[], myPlayerId: string, opts: TimelineOptions = {}): Timeline {
  const reduced = !!opts.reducedMotion;
  const moveMs = reduced ? 120 : (opts.moveStepMs ?? 320);
  const atkMs = reduced ? 200 : (opts.attackMs ?? 650);
  const impact = reduced ? 100 : (opts.impactDelayMs ?? Math.round(atkMs * 0.6));
  const steps: PlaybackStep[] = [];
  let id = 0;
  let t = 0;
  const add = (kind: StepKind, start: number, duration: number, e: TurnEvent, focus: Coord | null, important: boolean, damage?: number) =>
    steps.push({ id: id++, kind, start, duration, event: e, focus, important, damage });
  const mine = (owner?: string | null) => owner === myPlayerId;
  const byPhase = (p: string) => events.filter(e => e.phase === p).map(e => e.event);

  // Подготовка
  const prep = byPhase('prepare');
  for (const e of prep) if (e.t === 'fortify') add('fortify', t, 400, e, e.at, false);
  if (prep.length) t += reduced ? 100 : 400;

  // Движение: шаги одного такта идут параллельно.
  const moves = byPhase('move');
  const ticks = [...new Set(moves.map(e => ('tick' in e ? e.tick : 0)))].sort((a, b) => a - b);
  for (const tick of ticks) {
    for (const e of moves) {
      if (e.t === 'move' && e.tick === tick) add('move', t, moveMs, e, e.to, mine(e.owner));
      if (e.t === 'move_blocked' && e.tick === tick) add('blocked', t + moveMs * 0.5, 400, e, e.at, mine(e.owner));
    }
    t += moveMs;
  }

  // Бой по ступеням инициативы: основные удары ступени параллельны, затем контратаки, затем потери.
  const combat = byPhase('combat');
  let i = 0;
  while (i < combat.length) {
    const e = combat[i];
    if (e.t === 'attack' && e.kind !== 'counter') {
      const tier = e.tier;
      const group: TurnEvent[] = [];
      while (i < combat.length) {
        const x = combat[i];
        if (x.t === 'attack' && x.tier === tier && x.kind !== 'counter') group.push(x);
        else break;
        i++;
      }
      for (const g of group) if (g.t === 'attack') {
        add('attack', t, atkMs, g, g.to, true);
        add('impact', t + impact, 300, g, g.to, true, g.damage);
      }
      t += atkMs;
      const counters: TurnEvent[] = [];
      while (i < combat.length) {
        const x = combat[i];
        if (x.t === 'attack' && x.kind === 'counter') counters.push(x);
        else break;
        i++;
      }
      for (const c of counters) if (c.t === 'attack') {
        add('counter', t, atkMs, c, c.to, true);
        add('impact', t + impact, 300, c, c.to, true, c.damage);
      }
      if (counters.length) t += atkMs;
      continue;
    }
    if (e.t === 'unit_destroyed') {
      add('destroy', t, 500, e, e.at, true);
      // Удаление объекта — после эффекта; следующие события ступени начинаются после него.
      if (combat[i + 1]?.t !== 'unit_destroyed') t += 500;
    } else if (e.t === 'attack_failed') add('attack_failed', t, 300, e, e.at, mine(e.owner));
    else if (e.t === 'xp' && e.rankUp) add('rank_up', t, 700, e, null, true);
    i++;
  }

  // Захват
  const cap = byPhase('capture');
  for (const e of cap) {
    if (e.t === 'city_contested') add('contest', t, 700, e, e.at, mine(e.by) || mine(e.owner));
    if (e.t === 'city_contest_cleared') add('contest_cleared', t, 500, e, e.at, false);
    if (e.t === 'city_captured') add('capture', t, 900, e, e.at, mine(e.to) || mine(e.from));
  }
  if (cap.length) t += 900;

  // Экономика
  for (const e of byPhase('economy')) {
    if (e.t === 'unit_recruited') add('recruit', t, 600, e, e.at, true);
    if (e.t === 'research_completed') add('research', t, 600, e, null, true);
    if (e.t === 'income') add('income', t, 0, e, null, false);
  }
  t += 600;
  for (const e of byPhase('validate')) add('info', 0, 0, e, null, true);
  steps.sort((a, b) => a.start - b.start || a.id - b.id);
  return { steps, total: t };
}

/** Проигрыватель шкалы: скорость ×1/×2, пропуск. Рендерер вызывает frame() каждый кадр. */
export class TimelinePlayer {
  timeline: Timeline;
  speed = 1;
  private elapsed = 0;
  private last: number | null = null;
  done = false;
  constructor(timeline: Timeline) {
    this.timeline = timeline;
  }
  setSpeed(s: 1 | 2): void {
    this.speed = s;
  }
  skip(): void {
    this.elapsed = this.timeline.total;
    this.done = true;
  }
  /** Активные шаги с прогрессом 0..1 и шаги, завершившиеся к этому моменту. */
  frame(nowMs: number): { active: { step: PlaybackStep; p: number }[]; finished: PlaybackStep[]; time: number } {
    if (this.last !== null && !this.done) this.elapsed += (nowMs - this.last) * this.speed;
    this.last = nowMs;
    if (this.elapsed >= this.timeline.total) this.done = true;
    const active: { step: PlaybackStep; p: number }[] = [];
    const finished: PlaybackStep[] = [];
    for (const s of this.timeline.steps) {
      if (this.elapsed >= s.start + s.duration) finished.push(s);
      else if (this.elapsed >= s.start) active.push({ step: s, p: s.duration ? (this.elapsed - s.start) / s.duration : 1 });
    }
    return { active, finished, time: this.elapsed };
  }
}

/** Последний показанный ход — чтобы после сворачивания приложения не показывать бой заново. */
export function lastPlayedTurn(matchId: string): number {
  try {
    return Number(localStorage.getItem(`oskolki:played:${matchId}`) ?? 0);
  } catch {
    return 0;
  }
}
export function markPlayed(matchId: string, turn: number): void {
  try {
    localStorage.setItem(`oskolki:played:${matchId}`, String(turn));
  } catch {
    /* хранилище недоступно — не критично */
  }
}
