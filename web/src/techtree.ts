// Дерево исследований в духе Polytopia: ветви расходятся лучами от эмблемы народа,
// ярус = глубина зависимостей. Перетаскивание и масштаб пальцами, карточка технологии снизу.
import { BALANCE } from '../../src/shared/balance.ts';
import { factionIcon, techIcon } from './tech-icons.ts';

export interface TreeInput {
  faction: string;
  researched: string[];
  queue: string[];
  progress: number;
  income: number;
  canAct: boolean;
}
export interface TreeActions {
  setQueue(queue: string[]): void;
  describe(id: string): { opens: string; effects: string };
}

const BRANCHES: { id: string; name: string; color: string }[] = [
  { id: 'economy', name: 'Хозяйство', color: '#d9a441' },
  { id: 'movement', name: 'Передвижение', color: '#4f8fc9' },
  { id: 'knowledge', name: 'Знания', color: '#8d6bd1' },
  { id: 'legacy', name: 'Наследие', color: '#c0563b' },
  { id: 'military', name: 'Военное дело', color: '#5b8f4a' },
];
const RADII = [0, 160, 250, 340, 430, 520];
const SLOT = 70; // расстояние между центрами узлов по дуге, px
const NODE = 50;

interface Node { id: string; branch: string; depth: number; x: number; y: number; angle: number }
interface Layout { nodes: Map<string, Node>; extent: number; sectors: { id: string; a0: number; a1: number }[] }

const layoutCache = new Map<string, Layout>();

function techsFor(faction: string): string[] {
  return Object.entries(BALANCE.techs).filter(([, t]) => !t.faction || t.faction === faction).map(([id]) => id);
}

function layout(faction: string): Layout {
  const hit = layoutCache.get(faction);
  if (hit) return hit;
  const ids = techsFor(faction);
  const depth = new Map<string, number>();
  const dep = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const reqs = BALANCE.techs[id].requires.filter(r => ids.includes(r));
    const d = 1 + Math.max(0, ...reqs.map(dep));
    depth.set(id, d);
    return d;
  };
  ids.forEach(dep);
  // Ширина сектора — сколько угла нужно самому тесному ярусу ветви (число узлов × шаг / радиус).
  const rr = (d: number) => RADII[Math.min(d, RADII.length - 1)];
  const weight = (br: string) => {
    const rows = new Map<number, number>();
    for (const id of ids) if (BALANCE.techs[id].branch === br) rows.set(depth.get(id)!, (rows.get(depth.get(id)!) ?? 0) + 1);
    return Math.max(2 * SLOT / RADII[1], ...[...rows].map(([d, n]) => (n * SLOT) / rr(d)));
  };
  const total = BRANCHES.reduce((s, b) => s + weight(b.id), 0);
  const sectors: Layout['sectors'] = [];
  let a = -Math.PI / 2 - (weight(BRANCHES[0].id) / total) * Math.PI; // первая ветвь — сверху
  const nodes = new Map<string, Node>();
  for (const br of BRANCHES) {
    const w = (weight(br.id) / total) * Math.PI * 2;
    const a0 = a, a1 = a + w;
    sectors.push({ id: br.id, a0, a1 });
    const maxD = Math.max(0, ...ids.filter(id => BALANCE.techs[id].branch === br.id).map(id => depth.get(id)!));
    for (let d = 1; d <= maxD; d++) {
      const row = ids.filter(id => BALANCE.techs[id].branch === br.id && depth.get(id) === d);
      const r = RADII[Math.min(d, RADII.length - 1)];
      const gap = Math.min(SLOT / r, w / row.length);
      // Желаемый угол — среднее родителей той же ветви, иначе равномерно по сектору.
      const ideal = row.map((id, i) => {
        const ps = BALANCE.techs[id].requires.map(p => nodes.get(p)).filter((p): p is Node => !!p && p.branch === br.id);
        return { id, want: ps.length ? ps.reduce((s, p) => s + p.angle, 0) / ps.length : a0 + ((i + 0.5) / row.length) * w };
      }).sort((x, y) => x.want - y.want);
      // Раздвигаем, сохраняя порядок, и держим внутри сектора.
      const pos = ideal.map(x => x.want);
      for (let it = 0; it < 30; it++) {
        for (let i = 1; i < pos.length; i++) if (pos[i] - pos[i - 1] < gap) {
          const m = (pos[i] + pos[i - 1]) / 2;
          pos[i - 1] = m - gap / 2;
          pos[i] = m + gap / 2;
        }
        const lo = a0 + gap / 2, hi = a1 - gap / 2;
        if (pos.length && pos[0] < lo) { const s = lo - pos[0]; for (let i = 0; i < pos.length; i++) pos[i] += s; }
        if (pos.length && pos[pos.length - 1] > hi) { const s = pos[pos.length - 1] - hi; for (let i = 0; i < pos.length; i++) pos[i] -= s; }
      }
      ideal.forEach((x, i) => nodes.set(x.id, { id: x.id, branch: br.id, depth: d, angle: pos[i], x: Math.cos(pos[i]) * r, y: Math.sin(pos[i]) * r }));
    }
    a = a1;
  }
  const extent = Math.max(...[...nodes.values()].map(n => Math.hypot(n.x, n.y))) + NODE;
  const l = { nodes, extent, sectors };
  layoutCache.set(faction, l);
  return l;
}

/** Недостающие предшественники в порядке изучения (без уже изученных и стоящих в очереди). */
export function missingPath(id: string, researched: string[], queue: string[]): string[] | null {
  const out: string[] = [];
  const have = new Set([...researched, ...queue]);
  const visit = (t: string): boolean => {
    if (have.has(t) || out.includes(t)) return true;
    for (const r of BALANCE.techs[t].requires) if (!visit(r)) return false;
    out.push(t);
    return true;
  };
  visit(id);
  const chosen = new Set([...have, ...out]);
  // Взаимоисключающие технологии: путь невозможен, если выбрана альтернатива.
  for (const t of out) if ((BALANCE.techs[t].excludes ?? []).some(x => chosen.has(x))) return null;
  return out;
}

/** Очередь без технологии и всего, что от неё зависит. */
function withoutTech(queue: string[], id: string): string[] {
  const drop = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of queue) if (!drop.has(t) && BALANCE.techs[t].requires.some(r => drop.has(r))) {
      drop.add(t);
      changed = true;
    }
  }
  return queue.filter(t => !drop.has(t));
}

type State = 'done' | 'queued' | 'open' | 'path' | 'locked' | 'excluded';
function stateOf(id: string, inp: TreeInput): State {
  if (inp.researched.includes(id)) return 'done';
  if (inp.queue.includes(id)) return 'queued';
  const t = BALANCE.techs[id];
  const chosen = [...inp.researched, ...inp.queue];
  if ((t.excludes ?? []).some(x => chosen.includes(x))) return 'excluded';
  if (t.requires.every(r => chosen.includes(r))) return 'open';
  return missingPath(id, inp.researched, inp.queue) ? 'path' : 'locked';
}

// Состояние вида сохраняется между перерисовками панели.
const view = { faction: '', x: 0, y: 0, scale: 0, selected: null as string | null };

export function renderTechTree(host: HTMLElement, inp: TreeInput, act: TreeActions) {
  const L = layout(inp.faction);
  if (view.faction !== inp.faction) Object.assign(view, { faction: inp.faction, x: 0, y: 0, scale: 0, selected: null });
  const fac = BALANCE.factions[inp.faction];
  const head = inp.queue[0];
  const pct = head ? Math.min(1, inp.progress / BALANCE.techs[head].cost) : 0;
  const sector = (s: Layout['sectors'][number]) => {
    const R = L.extent + 6, r0 = RADII[1] - NODE * 0.9;
    const p = (ang: number, rr: number) => `${(Math.cos(ang) * rr).toFixed(1)} ${(Math.sin(ang) * rr).toFixed(1)}`;
    const large = s.a1 - s.a0 > Math.PI ? 1 : 0;
    const br = BRANCHES.find(b => b.id === s.id)!;
    const mid = (s.a0 + s.a1) / 2, lr = L.extent - 4;
    return `<path class="sec" d="M${p(s.a0, r0)} L${p(s.a0, R)} A${R} ${R} 0 ${large} 1 ${p(s.a1, R)} L${p(s.a1, r0)} A${r0} ${r0} 0 ${large} 0 ${p(s.a0, r0)}Z" style="--c:${br.color}"/>
      <text class="sec-l" x="${(Math.cos(mid) * lr).toFixed(1)}" y="${(Math.sin(mid) * lr).toFixed(1)}" style="--c:${br.color}">${br.id === 'legacy' ? fac.name : br.name}</text>`;
  };
  const edges: string[] = [];
  for (const n of L.nodes.values()) {
    const t = BALANCE.techs[n.id];
    if (n.depth === 1) {
      const c = Math.cos(n.angle), s = Math.sin(n.angle);
      edges.push(`<line class="e ${inp.researched.includes(n.id) ? 'on' : ''}" x1="${(c * 44).toFixed(1)}" y1="${(s * 44).toFixed(1)}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"/>`);
    }
    for (const r of t.requires) {
      const p = L.nodes.get(r);
      if (!p) continue;
      const on = inp.researched.includes(n.id) && inp.researched.includes(r);
      edges.push(`<line class="e ${p.branch !== n.branch ? 'x' : ''} ${on ? 'on' : ''}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"/>`);
    }
  }
  const E = L.extent + 10;
  const nodesHtml = [...L.nodes.values()].map(n => {
    const st = stateOf(n.id, inp);
    const qi = inp.queue.indexOf(n.id);
    const br = BRANCHES.find(b => b.id === n.branch)!;
    const ring = qi === 0 ? `<svg class="prog" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" pathLength="100" style="stroke-dasharray:${(pct * 100).toFixed(1)} 100"/></svg>` : '';
    return `<button class="tn ${st} ${view.selected === n.id ? 'sel' : ''}" data-tech="${n.id}" style="left:${(n.x + E).toFixed(1)}px;top:${(n.y + E).toFixed(1)}px;--c:${br.color}" aria-label="${BALANCE.techs[n.id].name}">
      ${techIcon(n.id, 'tg')}${ring}${qi >= 0 ? `<i class="qn">${qi + 1}</i>` : ''}<span class="tl">${BALANCE.techs[n.id].name}</span></button>`;
  }).join('');
  host.classList.add('tree-host');
  host.innerHTML = `
    <div class="tq">${inp.queue.length ? inp.queue.map((t, i) => `<button class="tq-chip ${i === 0 ? 'head' : ''}" data-tech="${t}">${techIcon(t, 'tg')}<span>${BALANCE.techs[t].name}</span></button>`).join('<span class="tq-arr">›</span>') : '<span class="muted">Очередь пуста — выберите технологию на дереве</span>'}
      ${inp.queue.length && inp.canAct ? '<button class="icon-btn sm" id="tqClear" aria-label="Очистить очередь"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' : ''}</div>
    <div class="tv" id="tv">
      <div class="tw" id="tw" style="width:${2 * E}px;height:${2 * E}px">
        <svg class="tsvg" viewBox="${-E} ${-E} ${2 * E} ${2 * E}" width="${2 * E}" height="${2 * E}">${L.sectors.map(sector).join('')}${edges.join('')}</svg>
        <div class="tcore" style="left:${E}px;top:${E}px;--c:${fac.color}">${factionIcon(inp.faction, 'tg')}<b>${inp.progress}</b><small>+${inp.income}</small></div>
        ${nodesHtml}
      </div>
      <div class="tzoom"><button class="icon-btn sm" id="tzIn" aria-label="Приблизить">+</button><button class="icon-btn sm" id="tzOut" aria-label="Отдалить">−</button></div>
    </div>
    <div class="tsheet" id="tsheet"></div>`;

  const tv = host.querySelector<HTMLElement>('#tv')!;
  const tw = host.querySelector<HTMLElement>('#tw')!;
  const fit = () => Math.min(tv.clientWidth, tv.clientHeight) / (2 * E);
  if (!view.scale) view.scale = Math.max(0.58, Math.min(1, fit() * 1.15));
  const apply = () => {
    const w = tv.clientWidth, h = tv.clientHeight;
    const lim = E * view.scale;
    view.x = Math.max(-lim, Math.min(lim, view.x));
    view.y = Math.max(-lim, Math.min(lim, view.y));
    tw.style.transform = `translate(${w / 2 - E * view.scale + view.x}px, ${h / 2 - E * view.scale + view.y}px) scale(${view.scale})`;
    tw.classList.toggle('labels', view.scale >= 0.78);
  };
  apply();
  const zoom = (k: number) => {
    const ns = Math.max(Math.min(0.3, fit()), Math.min(1.6, view.scale * k));
    view.x *= ns / view.scale;
    view.y *= ns / view.scale;
    view.scale = ns;
    apply();
  };
  host.querySelector<HTMLButtonElement>('#tzIn')!.onclick = () => zoom(1.25);
  host.querySelector<HTMLButtonElement>('#tzOut')!.onclick = () => zoom(0.8);
  tv.onwheel = e => {
    e.preventDefault();
    zoom(e.deltaY > 0 ? 0.9 : 1.1);
  };

  // Перетаскивание/щипок; касание без сдвига — выбор узла.
  const pts = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  let pinch: { d: number; s: number } | null = null;
  tv.onpointerdown = e => {
    if ((e.target as HTMLElement).closest('.tzoom')) return;
    tv.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.scale };
      if (drag) drag.moved = true;
    }
  };
  tv.onpointermove = e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      zoom((pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d / view.scale);
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      if (drag.moved) {
        view.x = drag.vx + dx;
        view.y = drag.vy + dy;
        apply();
      }
    }
  };
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (drag && !drag.moved && pts.size === 0) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-tech]');
      select(el?.dataset.tech ?? null);
    }
    if (pts.size === 0) drag = null;
  };
  tv.onpointerup = up;
  tv.onpointercancel = e => {
    pts.delete(e.pointerId);
    drag = null;
    pinch = null;
  };
  host.querySelectorAll<HTMLButtonElement>('.tq-chip').forEach(b => (b.onclick = () => select(b.dataset.tech!, true)));
  const clr = host.querySelector<HTMLButtonElement>('#tqClear');
  if (clr) clr.onclick = () => act.setQueue([]);

  function select(id: string | null, center = false) {
    view.selected = id;
    host.querySelectorAll('.tn.sel').forEach(x => x.classList.remove('sel'));
    if (id) host.querySelector(`.tn[data-tech="${id}"]`)?.classList.add('sel');
    if (id && center) {
      const n = L.nodes.get(id)!;
      view.x = -n.x * view.scale;
      view.y = -n.y * view.scale + 40;
      apply();
    }
    sheet();
  }

  function sheet() {
    const box = host.querySelector<HTMLElement>('#tsheet')!;
    const id = view.selected;
    if (!id) {
      box.classList.remove('open');
      box.innerHTML = '';
      return;
    }
    const t = BALANCE.techs[id];
    const st = stateOf(id, inp);
    const path = missingPath(id, inp.researched, inp.queue);
    const d = act.describe(id);
    const reqs = t.requires.map(r => `<span class="tag ${inp.researched.includes(r) ? 'ok' : inp.queue.includes(r) ? '' : 'war'}">${BALANCE.techs[r].name}</span>`).join(' ');
    const excl = (t.excludes ?? []).map(x => BALANCE.techs[x].name).join(', ');
    const pathCost = (path ?? []).reduce((s, x) => s + BALANCE.techs[x].cost, 0);
    let btn = '';
    if (!inp.canAct) btn = '';
    else if (st === 'done') btn = '<span class="tag ok">Изучено</span>';
    else if (st === 'queued') btn = `<button class="btn sm" id="tsRemove">Убрать из очереди</button>`;
    else if (st === 'open') btn = `<button class="btn gold" id="tsAdd">Исследовать · ✦${t.cost}</button>`;
    else if (st === 'path' && path) btn = `<button class="btn gold" id="tsAdd">Изучить путь · ${path.length} техн. · ✦${pathCost}</button>`;
    else btn = `<span class="why">${st === 'excluded' ? `Исключено выбором «${excl}»` : 'Путь закрыт другим выбором'}</span>`;
    const br = BRANCHES.find(b => b.id === t.branch)!;
    box.innerHTML = `<div class="ts-row"><div class="ts-ic ${st}" style="--c:${br.color}">${techIcon(id, 'tg')}</div>
        <div class="grow"><b>${t.name}</b><div class="muted">${t.branch === 'legacy' ? fac.name : br.name} · ✦${t.cost}</div></div>
        <button class="icon-btn sm" id="tsClose" aria-label="Закрыть"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      ${d.opens ? `<div class="ts-line"><span class="muted">Открывает</span> ${d.opens}</div>` : ''}
      ${d.effects ? `<div class="ts-line"><span class="muted">Эффект</span> ${d.effects}</div>` : ''}
      ${reqs ? `<div class="ts-line"><span class="muted">Нужно</span> ${reqs}</div>` : ''}
      ${excl ? `<div class="ts-line"><span class="muted">Взамен</span> ${excl}</div>` : ''}
      ${st === 'path' && path && path.length > 1 ? `<div class="ts-line muted">Очередь: ${path.map(x => BALANCE.techs[x].name).join(' → ')}</div>` : ''}
      <div class="ts-act">${btn}</div>`;
    box.classList.add('open');
    box.querySelector<HTMLButtonElement>('#tsClose')!.onclick = () => select(null);
    const add = box.querySelector<HTMLButtonElement>('#tsAdd');
    if (add && path) add.onclick = () => act.setQueue([...inp.queue, ...path]);
    const rm = box.querySelector<HTMLButtonElement>('#tsRemove');
    if (rm) rm.onclick = () => act.setQueue(withoutTech(inp.queue, id));
  }
  sheet();
}
