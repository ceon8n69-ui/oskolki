import { loadLiveArt, drawLiveArtIso } from './live-art.ts';
// Клиент: 2.5D-изометрия на Canvas 2D (рельеф с высотой, спрайты из web/art), без расчёта правил — только данные сервера.
import { BALANCE } from '../../src/shared/balance.ts';
import type { MatchInfo, StateResponse, ViewUnit } from '../../src/shared/protocol.ts';
import type { Coord, MapData, StoredEvent } from '../../src/shared/types.ts';
import { Terrain } from '../../src/shared/types.ts';
import { dist } from '../../src/engine/grid.ts';
import { findPath } from '../../src/engine/path.ts';
import { ApiError, OskolkiClient, TimelinePlayer, buildTimeline, lastPlayedTurn, markPlayed } from '../../src/client-sdk/index.ts';
import type { MatchSummary } from '../../src/client-sdk/index.ts';
import type { PlaybackStep } from '../../src/client-sdk/index.ts';

const tg = (window as any).Telegram?.WebApp;
const client = new OskolkiClient('');
const app = document.getElementById('app')!;
const REASONS: Record<string, string> = {
  not_enough_movement: 'Не хватает очков движения', path_through_enemy: 'Путь проходит через противника', target_out_of_range: 'Цель вне дальности',
  target_not_visible: 'Цель не видна', not_enough_gold: 'Недостаточно золота', unit_locked: 'Нужна технология', queue_full: 'Очередь заполнена',
  turn_closed: 'Ход уже закрыт', version_conflict: 'Приказ изменён в другом окне', impassable: 'Непроходимо', deficit: 'Дефицит золота',
  city_contested: 'Город оспаривается', not_planning: 'Сейчас не фаза планирования',
  not_enough_resources: 'Не хватает материалов', cannot_attack_after_move: 'Это орудие не стреляет после движения', unit_cannot_build: 'Этот отряд так не строит',
  outside_territory: 'Только на своей территории', building_locked: 'Нужна технология', building_exists: 'Уже построено или строится',
  city_level_too_low: 'Нужен 3-й уровень города', ability_on_cooldown: 'Способность перезаряжается', not_enough_command_points: 'Мало очков командования',
  commander_absent: 'Командир пал', tech_unavailable: 'Технология недоступна вашему народу или исключена выбором', tech_excluded: 'Взаимоисключающие технологии',
  forest_needs_plains: 'Лес сажают на равнине', treaty_forbids_attack: 'Договор запрещает атаку', territory_closed: 'Перемирие: чужая территория закрыта',
  alliances_disabled: 'В этом режиме союзы запрещены', proposal_not_delivered: 'Предложение ещё не дошло (будет видно со следующего хода)', break_pending: 'Уже объявлен разрыв', fort_exists: 'Укрепление уже есть', route_through_unexplored: 'Маршрут — только по разведанным клеткам',
  needs_port: 'Нужен порт в этом городе', not_coastal: 'Только в прибрежном городе', transport_full: 'Транспорт заполнен', embark_move_only: 'Погрузка — только движением',
  disembark_one_step: 'Высадка — один шаг на соседнюю сушу', bad_landing: 'Сюда не высадиться', landing_occupied: 'Клетка высадки занята',
  nothing_to_scorch: 'Здесь нечего жечь', scorch_in_city: 'Нельзя жечь город', obelisk_in_city: 'Обелиск нельзя ставить в городе',
  structure_exists: 'Здесь уже есть сооружение', obelisk_too_close: 'Слишком близко к другому обелиску',
};
const TERRAIN_COLORS: Record<number, string> = { 0: '#1f4e79', 1: '#2f6f9f', 2: '#8fb36b', 3: '#3f7a46', 4: '#a99a63', 5: '#7d7f86', 255: '#0d1013' };
const UNIT_LETTER: Record<string, string> = { scout: 'Р', infantry: 'П', spearman: 'К', archer: 'Л', shieldbearer: 'Щ', cavalry: 'В', siege: 'О', engineer: 'И', legionary: 'Лг', standard: 'Зн', ranger: 'Сл', warden: 'Ст', ironclad: 'Лт', bombard: 'Б', corsair: 'Кр', tidecaller: 'З', raider: 'Н', firebrand: 'М', runesmith: 'Ру', sentinel: 'Пс', transport: '⛵', warship: '⚓', commander: '★' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(text: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => (el.style.opacity = '0'), 2200);
  setTimeout(() => el.remove(), 2600);
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ===================== вход и лобби =====================

async function boot() {
  void loadLiveArt();
  tg?.ready?.();
  tg?.expand?.();
  // Свайп по карте не должен сворачивать мини-приложение (Telegram Bot API 7.7+).
  tg?.disableVerticalSwipes?.();
  // Старые клиенты Telegram: гасим протягивание страницы вне прокручиваемых панелей.
  document.addEventListener('touchmove', e => {
    if (!(e.target as HTMLElement).closest?.('.drawer-body, .screen, .card-sel, .dlg, .nav')) e.preventDefault();
  }, { passive: false });
  try {
    if (tg?.initData) await client.loginTelegram(tg.initData);
    else {
      const saved = sessionStorage.getItem('oskolki:dev');
      if (saved) client.session = JSON.parse(saved);
      else return loginScreen();
    }
  } catch (e) {
    return loginScreen(String((e as Error).message));
  }
  await afterLogin();
}

function loginScreen(err?: string) {
  app.innerHTML = `<div class="screen rooms"><header class="rooms-head">${icon('crown', 'crest')}<h1>Осколки королевств</h1></header>
    <div class="panel-card"><p class="muted">Вне Telegram — тестовый вход (сервер с DEV_AUTH=1).</p>
    ${err ? `<p class="why">${esc(err)}</p>` : ''}
    <div class="field join"><input id="nm" placeholder="Имя" value="Игрок" aria-label="Имя"><button class="btn gold" id="go">Войти</button></div></div></div>`;
  document.getElementById('go')!.onclick = async () => {
    try {
      const s = await client.loginDev((document.getElementById('nm') as HTMLInputElement).value);
      sessionStorage.setItem('oskolki:dev', JSON.stringify(s));
      await afterLogin();
    } catch (e) {
      loginScreen(String((e as Error).message));
    }
  };
}

async function afterLogin() {
  const start = client.session?.startParam ?? new URLSearchParams(location.search).get('tgWebAppStartParam') ?? tg?.initDataUnsafe?.start_param ?? null;
  const join = new URLSearchParams(location.search).get('join') ?? (start?.startsWith('join_') ? start.slice(5) : null);
  if (join) {
    try {
      const m = await client.joinMatch(join);
      history.replaceState(null, '', location.pathname);
      return openMatch(m.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.code : String(e));
    }
  }
  if (start?.startsWith('match_')) return openMatch(start.slice(6));
  lobby();
}

// ---------- иконки (единый набор SVG, без системных эмодзи) ----------
const ICONS: Record<string, string> = {
  flask: '<path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7.5 15h9"/>',
  castle: '<path d="M4 21V10h2V7h2v3h3V7h2v3h3V7h2v3h2v11z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>',
  army: '<circle cx="8" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M2.5 20c.5-3.5 2.8-5.5 5.5-5.5s5 2 5.5 5.5M14 15.2c.8-.5 1.6-.7 2.5-.7 2.4 0 4.3 1.8 5 5.5"/>',
  menu: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  map: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>',
  move: '<path d="M7 4c1.5 0 2.5 1.8 2.5 4S8.5 12 7 12 4.5 10.2 4.5 8 5.5 4 7 4zM15.5 9c1.5 0 2.5 1.8 2.5 4s-1 4-2.5 4S13 15.2 13 13s1-4 2.5-4z"/><path d="M5.5 15h3M14 20h3"/>',
  sword: '<path d="M14.5 3.5H20v5.5L9 20l-3-3z"/><path d="m5 13 6 6M4 20l2.5-2.5"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/>',
  star: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4l-5.3 3 1.2-6L3.4 9.3l6-.7z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-4 3.3-6 6.5-6s5.9 2 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .7 3.2 2.6 3.5 6"/>',
  archive: '<path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
};
const icon = (k: string, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] ?? ''}</svg>`;
const RES_ICON: Record<string, string> = {
  gold: '<svg class="res" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="#f2b33d" stroke="#b77b12" stroke-width="1.5"/><circle cx="10" cy="10" r="4.5" fill="none" stroke="#b77b12" stroke-width="1.2"/></svg>',
  wood: '<svg class="res" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="7" width="16" height="7" rx="3.5" fill="#a86a35" stroke="#6e4220" stroke-width="1.3"/><ellipse cx="16" cy="10.5" rx="2" ry="3.4" fill="#e7c48f" stroke="#6e4220" stroke-width="1.1"/></svg>',
  iron: '<svg class="res" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15l3-8 6-3 5 4 1 6-6 3z" fill="#8f98a3" stroke="#535b64" stroke-width="1.3"/></svg>',
  crystal: '<svg class="res" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l6 6-6 10-6-10z" fill="#7fd6f2" stroke="#2c86a6" stroke-width="1.3"/></svg>',
  knowledge: '<svg class="res" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l2.2 5.3 5.8.5-4.4 3.8 1.3 5.6L10 14.3l-4.9 2.9 1.3-5.6L2 7.8l5.8-.5z" fill="#c7a6ff" stroke="#6f4ab0" stroke-width="1.1"/></svg>',
  command: '<svg class="res" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7l3.5 3L10 4l3.5 6L17 7l-1.5 9h-11z" fill="#f2b33d" stroke="#b77b12" stroke-width="1.2"/></svg>',
};
const PRESET_NAMES: Record<string, string> = { tutorial: 'Обучение', quick: 'Быстрая', vsbot: 'Против бота', async: 'Асинхронная', campaign: 'Кампания', conquest: 'Завоевание', islands: 'Архипелаг' };
const RANKS = ['Новобранец', 'Ветеран', 'Элита'];
const TERRAIN_RU: Record<number, string> = { 0: 'Глубокая вода', 1: 'Мелководье', 2: 'Равнина', 3: 'Лес', 4: 'Холмы', 5: 'Горы' };
const TERRAIN_KEY: Record<number, string> = { 0: 'deep_water', 1: 'shallow_water', 2: 'plains', 3: 'forest', 4: 'hills', 5: 'mountain' };
const errText = (e: unknown) => (e instanceof ApiError ? (REASONS[e.code] ?? e.code) : 'Нет связи');

// ---------- диалог подтверждения ----------
function confirmDialog(title: string, text: string, ok: string, cancel = 'Отмена', danger = true): Promise<boolean> {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'dlg-back';
    el.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="dlg-row"><button class="btn" data-r="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'gold'}" data-r="1">${esc(ok)}</button></div></div>`;
    const done = (v: boolean) => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 160);
      backStack.pop();
      syncBack();
      resolve(v);
    };
    el.querySelectorAll<HTMLButtonElement>('[data-r]').forEach(b => (b.onclick = () => done(b.dataset.r === '1')));
    el.onclick = e => e.target === el && done(false);
    backStack.push(() => done(false));
    syncBack();
    document.body.appendChild(el);
  });
}
/** Лист действий (меню ⋯). */
function actionSheet(title: string, items: { label: string; danger?: boolean; run: () => void }[]) {
  const el = document.createElement('div');
  el.className = 'dlg-back';
  el.innerHTML = `<div class="dlg sheet-dlg" role="dialog" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${items.map((it, i) => `<button class="btn wide ${it.danger ? 'danger-text' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('')}<button class="btn wide" data-i="-1">Закрыть</button></div>`;
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 160);
    backStack.pop();
    syncBack();
  };
  el.querySelectorAll<HTMLButtonElement>('[data-i]').forEach(b => (b.onclick = () => {
    close();
    const i = Number(b.dataset.i);
    if (i >= 0) items[i].run();
  }));
  el.onclick = e => e.target === el && close();
  backStack.push(close);
  syncBack();
  document.body.appendChild(el);
}

// ---------- кнопка «Назад» Telegram ----------
const backStack: (() => void)[] = [];
function syncBack() {
  const bb = tg?.BackButton;
  if (!bb) return;
  if (backStack.length) bb.show?.();
  else bb.hide?.();
}
tg?.BackButton?.onClick?.(() => backStack[backStack.length - 1]?.());

// ===================== «Мои партии» =====================

type RoomTab = 'active' | 'waiting' | 'finished' | 'archive';
let roomTab: RoomTab = 'active';

function roomGroup(m: MatchInfo): RoomTab {
  if (m.me?.archived) return 'archive';
  if (m.phase === 'lobby') return 'waiting';
  if (m.phase === 'finished' || m.me?.surrendered || m.me?.eliminated) return 'finished';
  return 'active';
}

async function lobby() {
  client.close();
  backStack.length = 0;
  syncBack();
  const [list, archived] = await Promise.all([client.listMatches().catch(() => [] as MatchInfo[]), client.listMatches(true).catch(() => [] as MatchInfo[])]);
  const all = [...list, ...archived];
  const counts = { active: 0, waiting: 0, finished: 0, archive: 0 } as Record<RoomTab, number>;
  for (const m of all) counts[roomGroup(m)]++;
  if (!counts[roomTab] && roomTab !== 'active') roomTab = counts.active ? 'active' : counts.waiting ? 'waiting' : 'active';
  const rooms = all.filter(m => roomGroup(m) === roomTab);
  const tabs: [RoomTab, string][] = [['active', 'Активные'], ['waiting', 'Ожидание'], ['finished', 'Завершённые'], ['archive', 'Архив']];
  const status = (m: MatchInfo) => {
    if (m.phase === 'lobby') return `Ожидание · ${m.players.length}/${m.maxPlayers}`;
    if (m.me?.surrendered) return 'Вы сдались';
    if (m.me?.eliminated && m.phase !== 'finished') return 'Вы выбыли';
    if (m.phase === 'finished') return m.me && (m.winners ?? []).includes(m.me.playerId) ? 'Победа' : 'Завершена';
    const me = m.players.find(p => p.id === m.me?.playerId);
    return `Ход ${m.turn}${me?.ready ? ' · вы готовы' : ''}`;
  };
  app.innerHTML = `<div class="screen rooms">
    <header class="rooms-head">${icon('crown', 'crest')}<h1>Осколки королевств</h1><button class="btn sm hb" id="shopBtn" aria-label="Лавка">${icon('crown')}<span>Лавка</span></button><button class="btn sm hb" id="lbBtn" aria-label="Рейтинг">${icon('star')}<span>Рейтинг</span></button></header>
    <details class="new-game" ${all.length ? '' : 'open'}><summary>${icon('plus')} Новая партия</summary>
      <div class="field"><label for="fac">Народ</label><select id="fac">${Object.entries(BALANCE.factions).map(([id, f]) => `<option value="${id}">${esc(f.name)}</option>`).join('')}</select></div>
      <div class="presets">${Object.keys(BALANCE.turnPresets).map(p => `<button class="btn preset" data-p="${p}"><b>${esc(PRESET_NAMES[p] ?? p)}</b><span>${esc(presetHint(p))}</span></button>`).join('')}</div>
      <details class="more"><summary>Условия</summary>
        <div class="field"><label for="vic">Победа</label><select id="vic"><option value="" selected>По пресету</option>${Object.entries(BALANCE.victoryModes).map(([id, v]) => `<option value="${id}">${esc(v.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="tl">Лимит ходов</label><input id="tl" type="number" min="5" max="1000" inputmode="numeric" placeholder="По пресету"></div>
      </details>
      <div class="field join"><input id="code" placeholder="Код приглашения" aria-label="Код приглашения"><button class="btn" id="join">Вступить</button></div>
    </details>
    <nav class="tabs" role="tablist">${tabs.map(([id, t]) => `<button role="tab" aria-selected="${roomTab === id}" class="tab ${roomTab === id ? 'on' : ''}" data-tab="${id}">${t}${counts[id] ? ` <span class="cnt">${counts[id]}</span>` : ''}</button>`).join('')}</nav>
    <div class="room-list">${rooms.map(m => `<div class="room" data-m="${m.id}">
        <div class="room-main"><b>${esc(PRESET_NAMES[m.preset] ?? m.preset)}</b><span class="muted">${esc(status(m))}</span>
          <span class="room-players">${icon('users')} ${m.players.length}${m.phase === 'lobby' ? `/${m.maxPlayers}` : ''}${m.me?.isCreator ? ' · вы создатель' : ''}</span></div>
        <button class="icon-btn" data-more="${m.id}" aria-label="Действия с партией">${icon('menu', 'fill')}</button></div>`).join('') || `<p class="empty">${roomTab === 'archive' ? 'Архив пуст' : 'Нет партий'}</p>`}</div>
  </div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => (b.onclick = () => ((roomTab = b.dataset.tab as RoomTab), lobby())));
  document.getElementById('lbBtn')!.onclick = () => leaderboardScreen();
  document.getElementById('shopBtn')!.onclick = () => shopScreen();
  app.querySelectorAll<HTMLButtonElement>('[data-p]').forEach(b => (b.onclick = async () => {
    const vic = (document.getElementById('vic') as HTMLSelectElement).value;
    const tl = (document.getElementById('tl') as HTMLInputElement).value;
    try {
      b.disabled = true;
      const m = await client.createMatch(b.dataset.p!, (document.getElementById('fac') as HTMLSelectElement).value, { ...(vic ? { victory: vic } : {}), ...(tl ? { turnLimit: Number(tl) } : {}) });
      openMatch(m.id);
    } catch (e) {
      b.disabled = false;
      toast(errText(e));
    }
  }));
  document.getElementById('join')!.onclick = async () => {
    try {
      const m = await client.joinMatch((document.getElementById('code') as HTMLInputElement).value.trim(), (document.getElementById('fac') as HTMLSelectElement).value);
      openMatch(m.id);
    } catch (e) {
      toast(errText(e));
    }
  };
  app.querySelectorAll<HTMLElement>('.room-main').forEach(el => (el.onclick = () => openMatch(el.parentElement!.dataset.m!)));
  app.querySelectorAll<HTMLButtonElement>('[data-more]').forEach(b => (b.onclick = e => {
    e.stopPropagation();
    const m = all.find(x => x.id === b.dataset.more)!;
    roomActions(m, lobby);
  }));
}

async function leaderboardScreen() {
  const lb = await client.leaderboard().catch(() => null);
  app.innerHTML = `<div class="screen rooms">
    <header class="rooms-head"><button class="icon-btn" id="back" aria-label="К партиям">${icon('back')}</button><h1>Рейтинг</h1></header>
    ${lb?.me ? `<div class="panel-card row-between"><b>Ваше место ${lb.me.place}</b><span>${lb.me.rating} · партий ${lb.me.games} · побед ${lb.me.wins}</span></div>` : '<div class="panel-card muted">Рейтинг появится после первой партии с другим игроком</div>'}
    <div class="lb">${(lb?.top ?? []).map(r => `<div class="lb-row ${r.me ? 'me' : ''}"><span class="lb-place">${r.place}</span><b>${r.crown ? `<span class="crown" title="Корона">${icon('crown', 'fill')}</span>` : ''}${esc(r.name)}</b><span class="lb-r">${r.rating}</span><span class="muted">${r.wins}/${r.games}</span></div>`).join('') || '<p class="empty">Пока пусто</p>'}</div></div>`;
  backStack.length = 0;
  backStack.push(() => lobby());
  syncBack();
  document.getElementById('back')!.onclick = () => lobby();
}

async function shopScreen() {
  const data = await client.shop().catch(e => (toast(errText(e)), null));
  if (!data) return lobby();
  app.innerHTML = `<div class="screen rooms">
    <header class="rooms-head"><button class="icon-btn" id="back" aria-label="К партиям">${icon('back')}</button><h1>Лавка</h1></header>
    <div class="panel-card muted">Только внешний вид — на силу в игре не влияет. Оплата — Telegram Stars.</div>
    <div class="shop">${data.items.map(i => {
      const equipped = i.kind === 'color' && data.equippedColor === i.id;
      const action = !i.owned ? `<button class="btn gold sm" data-buy="${i.id}">★ ${i.stars}</button>`
        : i.kind === 'color' ? `<button class="btn sm" data-equip="${equipped ? '' : i.id}">${equipped ? 'Снять' : 'Выбрать'}</button>` : '<span class="tag ok">Куплено</span>';
      return `<div class="shop-item ${equipped ? 'on' : ''}"><div class="swatch" style="${i.color ? `background:${i.color}` : ''}">${i.kind === 'badge' ? icon('crown', 'fill') : ''}</div>
        <div class="grow"><b>${esc(i.name)}</b><div class="muted">${esc(i.description)}</div></div>${action}</div>`;
    }).join('')}</div></div>`;
  backStack.length = 0;
  backStack.push(() => lobby());
  syncBack();
  document.getElementById('back')!.onclick = () => lobby();
  app.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach(b => (b.onclick = async () => {
    if (!tg?.openInvoice) return toast('Оплата доступна в Telegram');
    try {
      b.disabled = true;
      const { link } = await client.shopInvoice(b.dataset.buy!);
      tg.openInvoice(link, (status: string) => {
        b.disabled = false;
        if (status === 'paid') {
          toast('Покупка получена');
          // Выдача приходит от Telegram отдельным уведомлением — обновляем лавку чуть позже.
          setTimeout(() => void shopScreen(), 1500);
        } else if (status === 'failed') toast('Оплата не прошла');
      });
    } catch (e) {
      b.disabled = false;
      toast(errText(e));
    }
  }));
  app.querySelectorAll<HTMLButtonElement>('[data-equip]').forEach(b => (b.onclick = () => client.equip(b.dataset.equip || null).then(() => shopScreen()).catch(e => toast(errText(e)))));
}

function presetHint(p: string): string {
  const t = BALANCE.turnPresets[p];
  const mp = BALANCE.map.presets[t.mapPreset];
  const time = t.planningSeconds === 0 ? 'по готовности' : t.planningSeconds < 3600 ? `${t.planningSeconds} с на ход` : `${Math.round(t.planningSeconds / 3600)} ч на ход`;
  return `${mp.width}×${mp.height} · до ${mp.players} · ${time}`;
}

/** Действия с комнатой по роли и состоянию: удалить / покинуть / сдаться / убрать из списка / вернуть. */
function roomActions(m: MatchInfo, after: () => void) {
  const g = roomGroup(m);
  const items: { label: string; danger?: boolean; run: () => void }[] = [{ label: 'Открыть', run: () => openMatch(m.id) }];
  const act = (p: Promise<unknown>) => p.then(after).catch(e => toast(errText(e)));
  if (g === 'archive') items.push({ label: 'Вернуть в список', run: () => act(client.archive(m.id, false)) });
  else if (m.phase === 'lobby' && m.me?.isCreator) items.push({ label: 'Удалить комнату', danger: true, run: async () => (await confirmDialog('Удалить комнату?', 'Комната исчезнет у всех участников', 'Удалить')) && act(client.deleteRoom(m.id)) });
  else if (m.phase === 'lobby') items.push({ label: 'Покинуть', danger: true, run: () => act(client.leaveRoom(m.id)) });
  else if (g === 'active') items.push({ label: 'Сдаться', danger: true, run: () => surrenderFlow(m.id, after) });
  else items.push({ label: 'Убрать из списка', run: () => act(client.archive(m.id, true)) });
  actionSheet(PRESET_NAMES[m.preset] ?? m.preset, items);
}

async function surrenderFlow(matchId: string, after: () => void) {
  if (!(await confirmDialog('Сдаться?', 'В этой партии тебе будет засчитано поражение. Вернуться в неё как игрок нельзя', 'Сдаться', 'Продолжить игру'))) return;
  try {
    await client.surrender(matchId);
    toast('Поражение засчитано');
    after();
  } catch (e) {
    toast(errText(e));
  }
}

async function openMatch(id: string) {
  let info: MatchInfo & { inviteLink: string };
  try {
    info = await client.matchDetails(id);
  } catch (e) {
    toast(errText(e));
    return lobby();
  }
  if (info.phase === 'deleted') {
    toast('Комната удалена');
    return lobby();
  }
  if (info.phase === 'lobby') {
    const mine = (await client.listMatches().catch(() => [] as MatchInfo[])).find(x => x.id === id);
    const isCreator = !!mine?.me?.isCreator;
    app.innerHTML = `<div class="screen rooms">
      <header class="rooms-head"><button class="icon-btn" id="back" aria-label="К партиям">${icon('back')}</button><h1>${esc(PRESET_NAMES[info.preset] ?? info.preset)}</h1></header>
      <div class="panel-card"><div class="row-between"><b>Игроки ${info.players.length}/${info.maxPlayers}</b><span class="muted">${esc(BALANCE.victoryModes[info.victory as 'influence']?.name ?? '')}${info.turnLimit ? ` · ${info.turnLimit} ходов` : ''}</span></div>
        ${info.players.map(p => `<div class="player-line"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.isBot ? ' · бот' : ''}<span class="muted">${esc(BALANCE.factions[p.faction]?.name ?? p.faction)}</span></div>`).join('')}</div>
      <div class="panel-card"><div class="muted">Приглашение · код ${esc(info.inviteCode)}</div><div class="link">${esc(info.inviteLink)}</div>
        <div class="btn-row"><button class="btn" id="share">Поделиться</button>${isCreator ? '<button class="btn" id="addBot">Добавить бота</button>' : ''}</div></div>
      <div class="panel-card field"><label for="fac2">Мой народ</label><select id="fac2">${Object.entries(BALANCE.factions).map(([fid, f]) => `<option value="${fid}" ${info.players.find(p => p.id === mine?.me?.playerId)?.faction === fid ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
      <div class="btn-row sticky">${isCreator ? '<button class="btn danger-text" id="del">Удалить</button><button class="btn gold" id="startNow">Начать</button>' : '<button class="btn danger-text" id="leave">Покинуть</button>'}</div>
    </div>`;
    const back = () => lobby();
    backStack.length = 0;
    backStack.push(back);
    syncBack();
    document.getElementById('back')!.onclick = back;
    document.getElementById('share')!.onclick = () => (tg?.openTelegramLink ? tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(info.inviteLink)}`) : navigator.clipboard?.writeText(info.inviteLink).then(() => toast('Ссылка скопирована')));
    const ab = document.getElementById('addBot');
    if (ab) ab.onclick = () => client.addBots(id, 1).then(() => openMatch(id)).catch(e => toast(errText(e)));
    (document.getElementById('fac2') as HTMLSelectElement).onchange = e => client.setFaction(id, (e.target as HTMLSelectElement).value).then(() => toast('Народ изменён')).catch(err => toast(errText(err)));
    const sn = document.getElementById('startNow');
    if (sn) sn.onclick = async () => {
      try {
        (sn as HTMLButtonElement).disabled = true;
        toast('Генерация мира…');
        await client.startMatch(id);
        openMatch(id);
      } catch (e) {
        (sn as HTMLButtonElement).disabled = false;
        toast(errText(e));
      }
    };
    const del = document.getElementById('del');
    if (del) del.onclick = async () => (await confirmDialog('Удалить комнату?', 'Комната исчезнет у всех участников', 'Удалить')) && client.deleteRoom(id).then(lobby).catch(e => toast(errText(e)));
    const lv = document.getElementById('leave');
    if (lv) lv.onclick = () => client.leaveRoom(id).then(lobby).catch(e => toast(errText(e)));
    const unsub = client.on('match', m => {
      if (m.phase === 'deleted') {
        unsub();
        toast('Создатель удалил комнату');
        lobby();
      } else if (m.phase !== 'lobby') {
        unsub();
        openMatch(id);
      } else if (m.players.length !== info.players.length) {
        unsub();
        openMatch(id);
      }
    });
    client.matchId = id;
    (client as any).connectWs();
    return;
  }
  await client.open(id);
  await gameScreen();
}

// ===================== игровой экран =====================

let cam = { x: 16, y: 16, size: 72 };
let selected: string | null = null;
let selectedCity: string | null = null;
let tileInfo: Coord | null = null;
let moveTiles: { x: number; y: number; cost: number; embark?: boolean; disembark?: boolean }[] = [];
let targetIds = new Set<string>();
let actionMode: 'move' | 'attack' | 'ability' = 'move';
let attackPlan: { unitId: string; targetId: string; path: Coord[]; damage: number; counter: number; counterPossible: boolean; modifiers: { id: string; value: number }[]; warning: string } | null = null;
type PanelKind = 'research' | 'cities' | 'army' | 'commander' | 'diplomacy' | 'log' | 'menu' | 'economy' | 'results' | null;
let summary: MatchSummary | null = null;
let replayTurn = 1;
let panel: PanelKind = null;
let panelFocus: string | null = null;
let markers: { id: number; playerId: string; x: number; y: number; label: string; shared: boolean }[] = [];
let bashMode = false;
let pulseMode = false;
let markerAt: Coord | null = null;
let supplyLayer = false;
let miniOpen = false;
let player: TimelinePlayer | null = null;
let playback: { before: StateResponse; after: StateResponse; events: StoredEvent[] } | null = null;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let logLines: string[] = [];
let hudTimer: ReturnType<typeof setInterval> | null = null;

async function gameScreen() {
  backStack.length = 0;
  syncBack();
  panel = null;
  selected = null;
  selectedCity = null;
  tileInfo = null;
  attackPlan = null;
  app.innerHTML = `<canvas id="map" aria-label="Карта"></canvas>
    <header class="hud" id="top"></header>
    <div class="goal" id="goal"></div>
    <div class="status" id="status"></div>
    <button class="icon-btn mini-btn" id="miniBtn" aria-label="Мини-карта" title="Мини-карта">${icon('map')}</button>
    <canvas id="mini" width="132" height="132" hidden></canvas>
    <div class="ctx" id="ctx"></div>
    <section class="card-sel" id="card" aria-live="polite"></section>
    <section class="drawer" id="panel" aria-hidden="true"></section>
    <nav class="nav" id="nav">
      <button class="nav-btn" id="nResearch">${icon('flask')}<span>Исследования</span></button>
      <button class="nav-btn" id="nCities">${icon('castle')}<span>Города</span></button>
      <button class="nav-btn" id="nArmy">${icon('army')}<span>Войска</span></button>
      <button class="nav-main" id="nMain"></button>
    </nav>`;
  canvas = document.getElementById('map') as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;
  resize();
  onresize = () => (resize(), layout());
  tg?.onEvent?.('viewportChanged', () => (resize(), layout()));
  const st = client.state!;
  const cap = st.view.cities.find(c => c.owner === st.view.me.id && c.isCapital) ?? st.view.units.find(u => u.owner === st.view.me.id);
  if (cap) cam = { ...cam, x: cap.x, y: cap.y };
  await loadVisibleChunks();
  bindInput();
  const mini = document.getElementById('mini') as HTMLCanvasElement;
  document.getElementById('miniBtn')!.onclick = () => {
    miniOpen = !miniOpen;
    mini.hidden = !miniOpen;
    document.getElementById('miniBtn')!.classList.toggle('on', miniOpen);
    if (miniOpen) void drawMinimap();
  };
  mini.onclick = e => {
    const r = mini.getBoundingClientRect();
    const v = client.state!.view.map;
    cam = { ...cam, x: ((e.clientX - r.left) / r.width) * v.width, y: ((e.clientY - r.top) / r.height) * v.height };
    void loadVisibleChunks();
  };
  document.getElementById('nResearch')!.onclick = () => openPanel('research');
  document.getElementById('nCities')!.onclick = () => openPanel('cities');
  document.getElementById('nArmy')!.onclick = () => openPanel('army');
  markers = await client.markers().catch(() => []);
  client.on('state', () => renderAll());
  client.on('match', () => renderAll());
  client.on('turnResolved', ({ turn, events, before, after }) => startPlayback(turn, events, before, after));
  if (st.view.turn > 1 && lastPlayedTurn(st.match.id) < st.view.turn - 1) {
    const ev = await client.events(st.view.turn - 1);
    logEvents(ev);
    markPlayed(st.match.id, st.view.turn - 1);
  }
  summary = null;
  replayTurn = Math.max(1, st.view.turn - 1);
  renderAll();
  if (st.match.phase === 'finished') openPanel('results');
  requestAnimationFrame(frame);
  if (hudTimer) clearInterval(hudTimer);
  // Раз в секунду — только таймер и готовность; панели и карточка не перерисовываются.
  hudTimer = setInterval(renderStatus, 1000);
}

async function drawMinimap() {
  const mini = document.getElementById('mini') as HTMLCanvasElement | null;
  if (!mini || mini.hidden) return;
  const mm = await client.minimap().catch(() => null);
  if (!mm) return;
  const c = mini.getContext('2d')!;
  const img = c.createImageData(mm.width, mm.height);
  const rgb: Record<number, number[]> = { 0: [31, 78, 121], 1: [47, 111, 159], 2: [143, 179, 107], 3: [63, 122, 70], 4: [169, 154, 99], 5: [125, 127, 134], 255: [13, 16, 19] };
  for (let i = 0; i < mm.terrain.length; i++) {
    const [r, g, bb] = rgb[mm.terrain[i]] ?? rgb[255];
    img.data.set([r, g, bb, 255], i * 4);
  }
  const off = new OffscreenCanvas(mm.width, mm.height);
  off.getContext('2d')!.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, 132, 132);
  c.drawImage(off, 0, 0, 132, 132);
  const sx = 132 / mm.width, sy = 132 / mm.height;
  const st = client.state!;
  for (const ct of mm.cities) {
    c.fillStyle = st.view.players.find(p => p.id === ct.owner)?.color ?? '#ddd';
    c.fillRect(ct.x * sx - 2, ct.y * sy - 2, 4, 4);
  }
  for (const u of mm.units) {
    c.fillStyle = st.view.players.find(p => p.id === u.owner)?.color ?? '#999';
    c.fillRect(u.x * sx - 1, u.y * sy - 1, 2, 2);
  }
}

function resize() {
  const d = Math.min(devicePixelRatio, 2);
  canvas.width = innerWidth * d;
  canvas.height = innerHeight * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
}

/** Размеры панелей → CSS-переменные (карточка над навигацией, мини-карта под статусом). */
function layout() {
  const h = tg?.viewportStableHeight || innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--app-h', `${h}px`);
  root.setProperty('--nav-h', `${document.getElementById('nav')?.offsetHeight ?? 64}px`);
  root.setProperty('--top-h', `${document.getElementById('top')?.offsetHeight ?? 48}px`);
  root.setProperty('--card-h', `${(document.getElementById('card')?.offsetHeight ?? 0)}px`);
}

// ---------- верхняя панель, цель, статус ----------
function myMatchState() {
  const st = client.state!;
  const meInfo = st.match.players.find(p => p.id === st.view.me.id);
  const out = !!(st.match.me?.surrendered || st.view.me.eliminated || meInfo?.surrendered);
  const humans = st.match.players.filter(p => !p.isBot && !p.eliminated && !p.surrendered);
  return { meInfo, out, humans, ready: humans.filter(p => p.ready).length };
}

function renderTop() {
  const st = client.state!;
  const me = st.view.me;
  const net = st.view.income.gold - st.view.income.upkeep;
  document.getElementById('top')!.innerHTML = `
    <span class="brand">${icon('crown', 'crest')}<b>Осколки</b></span>
    <button class="res-bar" id="resBtn" aria-label="Ресурсы и доход">
      <span>${RES_ICON.gold}${me.gold}${st.reserved.gold ? `<small>−${st.reserved.gold}</small>` : ''}</span>
      <span>${RES_ICON.wood}${me.materials.wood}</span>
      <span>${RES_ICON.iron}${me.materials.iron}</span>
      <span class="hide-xs">${RES_ICON.crystal}${me.materials.crystal}</span>
      <small class="${net < 0 ? 'neg' : 'pos'} hide-xs">${net >= 0 ? '+' : ''}${net}</small>
    </button>
    <span class="turn">Ход ${st.view.turn}</span>
    <button class="icon-btn" id="menuBtn" aria-label="Меню" title="Меню">${icon('menu', 'fill')}</button>`;
  document.getElementById('resBtn')!.onclick = () => openPanel('economy');
  document.getElementById('menuBtn')!.onclick = () => openPanel('menu');
  const mode = st.view.mode;
  let goal = '';
  if (mode.victory === 'influence') {
    const held = mode.objectives.filter(o => o.holder === me.id).length;
    goal = `${icon('flag')}<span>Удерживайте цели: ${held}/${mode.objectives.length}</span><b>${mode.scores[me.id] ?? 0}</b>`;
  } else if (mode.victory === 'capitals') {
    const caps = st.view.cities.filter(c => c.isCapital);
    goal = `${icon('castle')}<span>Столицы: ${caps.filter(c => c.owner === me.id).length}/${caps.length}</span>`;
  } else {
    const alive = st.view.players.filter(p => !p.eliminated && p.id !== me.id).length;
    goal = `${icon('sword')}<span>До последнего · соперников: ${alive}</span>`;
  }
  if (mode.turnLimit) goal += `<span class="muted">до хода ${mode.turnLimit}</span>`;
  if (st.view.worldEvents.length) goal += `<span class="event" title="${esc(st.view.worldEvents[0].description)}">${esc(st.view.worldEvents[0].name)}</span>`;
  document.getElementById('goal')!.innerHTML = goal;
  renderStatus();
}

function renderStatus() {
  const st = client.state;
  const el = document.getElementById('status');
  if (!st || !el) return;
  const left = st.match.deadline ? Math.max(0, Math.round((Date.parse(st.match.deadline) - Date.now()) / 1000)) : null;
  const time = left === null ? '' : left > 3600 ? `${Math.floor(left / 3600)} ч ${Math.floor((left % 3600) / 60)} м` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const { humans, ready, out } = myMatchState();
  if (st.match.phase === 'finished' || out) {
    el.innerHTML = `<span>${st.match.phase === 'finished' ? 'Партия завершена' : 'Вы выбыли'}</span>`;
    return;
  }
  el.innerHTML = `${time ? `<span>${icon('clock')}${time}</span>` : ''}<span class="${ready === humans.length ? 'ok' : ''}">Готовы ${ready}/${humans.length}</span>`;
}

// ---------- основное действие хода ----------
function renderNav() {
  const st = client.state!;
  const btn = document.getElementById('nMain') as HTMLButtonElement;
  const { meInfo, out, humans } = myMatchState();
  let label = 'Готов', cls = 'nav-main', run: () => void = () => {};
  if (player && !player.done) {
    label = 'Пропустить';
    run = () => player?.skip();
  } else if (st.match.phase === 'finished') {
    label = 'К партиям';
    run = () => lobby();
  } else if (out) {
    label = 'К партиям';
    cls += ' muted-main';
    run = () => lobby();
  } else if (meInfo?.ready) {
    // Отмена готовности разрешена сервером, пока идёт планирование хода.
    label = 'Отменить';
    cls += ' is-ready';
    run = () => setReady(false);
  } else {
    const othersReady = humans.filter(p => p.id !== st.view.me.id).every(p => p.ready);
    label = othersReady ? 'Завершить ход' : 'Готов';
    run = () => setReady(true);
  }
  btn.className = cls;
  btn.innerHTML = `<span>${esc(label)}</span>${meInfo?.ready && !out ? icon('check') : icon('back', 'flip')}`;
  btn.onclick = run;
}

async function setReady(v: boolean) {
  const btn = document.getElementById('nMain');
  btn?.classList.add('pulse');
  setTimeout(() => btn?.classList.remove('pulse'), 220);
  try {
    const r = await client.setReady(v);
    if (!r.ok) toast(REASONS[r.reason ?? ''] ?? r.reason ?? 'Ошибка');
  } catch (e) {
    toast(errText(e));
  }
}

function renderAll() {
  if (!client.state || !document.getElementById('top')) return;
  renderTop();
  renderNav();
  renderCard();
  if (panel) renderPanel();
  renderTutorial();
  layout();
}
// ---------- обучение ----------
interface TutStep { title: string; text: string; done: (st: StateResponse) => boolean; target?: (st: StateResponse) => Coord | null; nav?: string }
const myUnitOf = (st: StateResponse, type: string) => st.view.units.find(u => u.owner === st.view.me.id && u.type === type && !u.carriedBy) ?? null;
const TUT_STEPS: TutStep[] = [
  { title: 'Выберите пехотинца', text: 'Нажмите на пехотинца рядом со столицей.', done: st => !!selected && st.view.units.find(u => u.id === selected)?.type === 'infantry' && st.view.units.find(u => u.id === selected)?.owner === st.view.me.id, target: st => myUnitOf(st, 'infantry') },
  { title: 'Атакуйте разведчика', text: 'Красная клетка — цель. Нажмите на неё, проверьте прогноз и нажмите «Атаковать».', done: st => st.orders.some(o => (o.order as any).mode === 'attack') || st.view.turn > 1, target: st => st.view.units.find(u => u.owner !== st.view.me.id && u.type === 'scout') ?? null },
  { title: 'Завершите ход', text: 'Все игроки отдают приказы одновременно. «Завершить ход» — и сервер рассчитает результат.', done: st => st.view.turn >= 2, nav: 'nMain' },
  { title: 'Наймите отряд', text: 'Откройте «Города» и выберите отряд в разделе «Нанять».', done: st => st.orders.some(o => o.order.kind === 'recruit') || st.view.cities.some(c => c.owner === st.view.me.id && c.queue.length > 0), nav: 'nCities' },
  { title: 'Выберите исследование', text: 'Откройте «Исследования» и нажмите «Исследовать» у любой технологии.', done: st => st.orders.some(o => o.order.kind === 'research') || st.view.me.researchQueue.length > 0 || st.view.me.researched.length > 0, nav: 'nResearch' },
  { title: 'Разведайте округу', text: 'Выберите разведчика и нажмите на дальнюю разведанную клетку — он проложит маршрут на несколько ходов.', done: st => { const s = myUnitOf(st, 'scout'); return !!s && (st.orders.some(o => o.subject === `unit:${s.id}` && (o.order as any).path?.length) || !!s.route?.path?.length); }, target: st => myUnitOf(st, 'scout') },
  { title: 'Завершите ход', text: 'Готово — посмотрите, как ход разыгрывается на карте.', done: st => st.view.turn >= 3, nav: 'nMain' },
];
const tutKey = (id: string) => `oskolki:tut:${id}`;
function tutStep(st: StateResponse): number {
  try {
    return Number(localStorage.getItem(tutKey(st.match.id)) ?? 0);
  } catch {
    return tutMem.get(st.match.id) ?? 0;
  }
}
const tutMem = new Map<string, number>();
function setTutStep(st: StateResponse, n: number) {
  tutMem.set(st.match.id, n);
  try {
    localStorage.setItem(tutKey(st.match.id), String(n));
  } catch { /* приватный режим — прогресс в памяти */ }
}
function tutorialActive(st: StateResponse): boolean {
  return !!BALANCE.turnPresets[st.match.preset]?.tutorial && st.match.phase !== 'finished';
}
/** Цель текущего шага на карте (пульсирующее кольцо) — для frame. */
function tutTarget(): Coord | null {
  const st = client.state;
  if (!st || !tutorialActive(st)) return null;
  const s = TUT_STEPS[tutStep(st)];
  return s?.target?.(st) ?? null;
}
function renderTutorial() {
  const st = client.state!;
  let el = document.getElementById('tut');
  document.querySelectorAll('.tut-pulse').forEach(e => e.classList.remove('tut-pulse'));
  document.body.classList.remove('tut-on');
  if (!tutorialActive(st)) {
    el?.remove();
    return;
  }
  let n = tutStep(st);
  while (n < TUT_STEPS.length && TUT_STEPS[n].done(st)) n++;
  if (n !== tutStep(st)) setTutStep(st, n);
  if (!el) {
    el = document.createElement('section');
    el.id = 'tut';
    el.className = 'tut';
    el.setAttribute('aria-live', 'polite');
    app.appendChild(el);
  }
  if (n >= TUT_STEPS.length) {
    el.innerHTML = `<div class="tut-head"><b>Обучение пройдено</b></div><div class="tut-text">Дальше — настоящая партия: захватывайте города и побеждайте соперников.</div>
      <div class="btn-row"><button class="btn sm" id="tutStay">Остаться</button><button class="btn sm gold" id="tutBot">Против бота</button></div>`;
    document.getElementById('tutStay')!.onclick = () => el!.remove();
    document.getElementById('tutBot')!.onclick = () => client.createMatch('vsbot', st.view.me.faction).then(m => openMatch(m.id)).catch(e => toast(errText(e)));
    return;
  }
  const s = TUT_STEPS[n];
  document.body.classList.add('tut-on');
  el.innerHTML = `<div class="tut-head"><span class="tut-n">${n + 1}/${TUT_STEPS.length}</span><b>${esc(s.title)}</b><button class="tut-skip" id="tutSkip">Пропустить</button></div><div class="tut-text">${esc(s.text)}</div>`;
  document.getElementById('tutSkip')!.onclick = () => {
    setTutStep(st, TUT_STEPS.length);
    el!.remove();
    document.body.classList.remove('tut-on');
  };
  if (s.nav) document.getElementById(s.nav)?.classList.add('tut-pulse');
}

/** Совместимость со старым кодом воспроизведения. */
const renderHud = () => renderAll();

// ---------- карточка выбранного объекта ----------
function terrainLine(x: number, y: number): string {
  const t = client.tile(x, y);
  if (!t || t.terrain === 255) return '';
  const rule = BALANCE.terrain[TERRAIN_KEY[t.terrain]];
  const parts = [`<b>${TERRAIN_RU[t.terrain]}</b>`];
  if (rule.defense !== 1) parts.push(`${icon('shield')}×${rule.defense}`);
  if (t.features & 128) parts.push('укрепление');
  if (t.features & 1) parts.push('дорога');
  return `<div class="terrain">${parts.join(' ')}</div>`;
}

function hpBar(hp: number, max: number): string {
  const f = Math.max(0, Math.min(1, hp / max));
  return `<div class="hp"><div style="width:${Math.round(f * 100)}%" class="${f > 0.6 ? 'g' : f > 0.3 ? 'y' : 'r'}"></div></div><span class="hp-t">Здоровье ${hp}/${max}</span>`;
}

function describeOrder(o: any): string {
  if (o.mode === 'hold') return 'защита';
  if (o.mode === 'build') return ({ fort: 'укрепление', forest: 'посадка леса', scorch: 'выжигание', obelisk: 'обелиск', road: 'дорога' } as Record<string, string>)[o.build ?? 'road'] ?? 'строительство';
  if (o.ability === 'knockback') return 'удар щитом';
  if (o.longRoute) return `маршрут · ${o.path.length}`;
  if (o.mode === 'move') return `движение · ${o.path.length}`;
  return 'атака';
}

/** Доступные способности отряда (строительство, особые удары) — только применимые по типу и народу. */
function unitAbilities(u: ViewUnit): { id: string; label: string }[] {
  const st = client.state!;
  const rule = BALANCE.units[u.type];
  const tr = BALANCE.factions[st.view.me.faction]?.traits ?? {};
  const builder = rule.abilities.includes('build') || BALANCE.roads.builders.includes(u.type);
  const out: { id: string; label: string }[] = [];
  if (rule.class === 'naval' || u.carriedBy) return out;
  if (builder) out.push({ id: 'road', label: `Дорога · ${BALANCE.roads.goldCost}` });
  if (rule.abilities.includes('build_fort') || (tr.buildFort && builder)) out.push({ id: 'fort', label: `Укрепление · ${BALANCE.forts.goldCost}` });
  if (rule.abilities.includes('plant_forest') || (tr.plantForest && builder)) out.push({ id: 'forest', label: `Лес · ${BALANCE.plantForest.goldCost}` });
  if (tr.scorch) out.push({ id: 'scorch', label: 'Выжечь' });
  if (rule.abilities.includes('build_obelisk') || (tr.buildObelisk && builder)) out.push({ id: 'obelisk', label: `Обелиск · ${BALANCE.obelisks.goldCost}` });
  if (rule.abilities.includes('knockback')) out.push({ id: 'knockback', label: bashMode ? 'Удар щитом · вкл' : 'Удар щитом' });
  return out;
}

function portrait(type: string, color: string): string {
  return `<canvas class="portrait" width="112" height="112" data-type="${type}" data-color="${color}" aria-hidden="true"></canvas>`;
}
function paintPortraits(root: HTMLElement) {
  root.querySelectorAll<HTMLCanvasElement>('canvas.portrait').forEach(cv => {
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, 112, 112);
    const type = cv.dataset.type!;
    if (!drawLiveArtIso(c, type, 56, 108, 104)) {
      c.fillStyle = cv.dataset.color!;
      c.beginPath();
      c.arc(56, 56, 40, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#fff';
      c.font = 'bold 34px system-ui';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(UNIT_LETTER[type] ?? '?', 56, 58);
    }
  });
}

function renderCard() {
  const el = document.getElementById('card')!;
  const st = client.state!;
  const me = st.view.me;
  const planning = st.match.phase === 'planning' && !(player && !player.done) && !myMatchState().out;
  const u = selected ? st.view.units.find(x => x.id === selected) : null;
  let html = '';
  if (u) {
    const rule = BALANCE.units[u.type];
    const mine = u.owner === me.id;
    const owner = st.view.players.find(p => p.id === u.owner);
    const color = owner?.color ?? '#999';
    const ord = st.orders.find(o => o.subject === `unit:${u.id}`);
    const effects = u.statuses.map(s => BALANCE.effects[s.id]?.name ?? s.id);
    html = `<div class="card-row">${portrait(u.type, color)}
      <div class="card-main"><div class="card-title"><span class="dot" style="background:${color}"></span><b>${esc(rule.name)}</b>${mine ? '' : `<span class="muted"> · ${esc(owner?.name ?? 'нейтрал')}</span>`}</div>
        <div class="muted">${RANKS[u.rank] ?? ''}${effects.length ? ' · ' + esc(effects.join(', ')) : ''}</div>
        ${hpBar(u.hp, u.maxHp)}
        <div class="stats"><span>${icon('sword')}${rule.attack}</span><span>${icon('shield')}${rule.defense}</span><span>${icon('move')}${rule.move}</span><span>${icon('target')}${rule.range}</span></div></div>
      ${terrainLine(u.x, u.y)}</div>`;
    if (attackPlan && attackPlan.unitId === u.id) {
      const t = st.view.units.find(x => x.id === attackPlan!.targetId);
      html += `<div class="forecast"><div>${icon('sword')}<b>Урон ${attackPlan.damage}</b> · ${attackPlan.counterPossible ? `Ответ ${attackPlan.counter}` : 'без ответа'}</div>
        <div class="muted">${t ? `Цель: ${esc(BALANCE.units[t.type].name)} · ${t.hp}/${t.maxHp}` : ''}</div>
        ${attackPlan.modifiers.length ? `<div class="chips">${attackPlan.modifiers.map(m => `<span class="chip ${m.value >= 1 ? 'up' : 'down'}">${esc(BALANCE.effects[m.id]?.name ?? m.id)} ×${m.value}</span>`).join('')}</div>` : ''}
        <div class="btn-row"><button class="btn" id="aCancel">Отмена</button><button class="btn danger" id="aGo">${icon('sword')}Атаковать</button></div></div>`;
    } else if (mine) {
      const perkOrder = st.orders.find(o => o.subject === `promote:${u.id}`);
      if (u.pendingPerks && !perkOrder && planning) {
        html += `<div class="sub">Новый ранг · улучшение</div><div class="btn-row wrap">${Object.entries(BALANCE.perks).filter(([id]) => !u.perks?.includes(id)).map(([id, p]) => `<button class="btn sm" data-perk="${id}" title="${esc(p.description)}">${esc(p.name)}</button>`).join('')}</div>`;
      }
      if (actionMode === 'ability' && planning) {
        html += `<div class="btn-row wrap">${unitAbilities(u).map(a => `<button class="btn sm ${a.id === 'scorch' ? 'danger-text' : ''}" data-ab="${a.id}">${esc(a.label)}</button>`).join('')}</div>`;
      }
      const ctxFallback = planning && !ctxFits;
      html += `<div class="card-foot"><span class="muted">${ord ? `Приказ: ${describeOrder(ord.order)}` : u.carriedBy ? 'На борту' : u.cargo ? `На борту: ${u.cargo}` : 'Без приказа'}${u.route?.path?.length ? ` · маршрут ${u.route.path.length}` : ''}</span>
        ${ord && planning ? `<button class="btn sm" id="uCancel">Отменить приказ</button>` : ''}</div>
        ${ctxFallback ? `<div class="btn-row">${ctxButtons(u).map(b => `<button class="btn sm ${b.cls}" data-ctx="${b.id}">${icon(b.icon)}${esc(b.label)}</button>`).join('')}</div>` : ''}`;
    }
  } else if (selectedCity) {
    const c = st.view.cities.find(x => x.id === selectedCity);
    if (c) {
      const owner = st.view.players.find(p => p.id === c.owner);
      const mine = c.owner === me.id;
      const ci = st.view.income.cities[c.id];
      const head = c.queue[0];
      html = `<div class="card-row"><div class="city-ico" style="--c:${owner?.color ?? '#bbb'}">${icon('castle')}</div>
        <div class="card-main"><div class="card-title"><b>${esc(c.name)}</b><span class="muted"> · ур. ${c.level}${c.isCapital ? ' · столица' : ''}</span></div>
          <div class="muted">${esc(owner?.name ?? 'Нейтральный')}${c.contestedBy ? ' · оспаривается' : ''}${!c.visibleNow ? ` · сведения хода ${c.seenTurn ?? '—'}` : ''}</div>
          ${mine && ci ? `<div class="stats"><span>${RES_ICON.gold}+${ci.gold}</span><span>⚒ +${ci.production}</span><span>${RES_ICON.knowledge}+${ci.knowledge}</span></div>` : ''}
          ${mine ? `<div class="muted">${head ? `Строится: ${esc(head.kind === 'building' ? BALANCE.buildings[head.unitType].name : BALANCE.units[head.unitType].name)} ${head.progress}/${head.kind === 'building' ? BALANCE.buildings[head.unitType].cost.production : BALANCE.units[head.unitType].cost.production}` : 'Очередь пуста'}</div>` : ''}</div>
        ${terrainLine(c.x, c.y)}</div>
        ${mine ? `<div class="btn-row"><button class="btn gold sm" id="cOpen">Нанять и строить</button></div>` : ''}`;
    }
  } else if (tileInfo) {
    const t = client.tile(tileInfo.x, tileInfo.y);
    const feats: string[] = [];
    if (t) {
      if (t.features & 4) feats.push('руины');
      if (t.features & 8) feats.push('святилище');
      if (t.features & 16) feats.push('древесина');
      if (t.features & 32) feats.push('железо');
      if (t.features & 64) feats.push('кристаллы');
    }
    html = `<div class="card-row"><div class="card-main"><div class="card-title"><b>Клетка ${tileInfo.x}, ${tileInfo.y}</b></div><div class="muted">${feats.join(', ') || (t && t.terrain !== 255 ? '' : 'не разведано')}</div></div>${terrainLine(tileInfo.x, tileInfo.y)}</div>
      <div class="btn-row"><button class="btn sm" id="tMark">${icon('flag')}Метка</button><button class="btn sm" id="tClose">Закрыть</button></div>`;
  }
  const show = !!html && !panel;
  el.classList.toggle('open', show);
  el.innerHTML = html;
  paintPortraits(el);
  // Обработчики
  const on = (id: string, fn: () => void) => {
    const b = document.getElementById(id);
    if (b) b.onclick = fn;
  };
  on('aCancel', () => ((attackPlan = null), renderAll()));
  on('aGo', async () => {
    const plan = attackPlan!;
    attackPlan = null;
    const unit = st.view.units.find(x => x.id === plan.unitId)!;
    await submit(bashMode && BALANCE.units[unit.type].abilities.includes('knockback') ? client.shieldBash(plan.unitId, plan.targetId, plan.path) : client.attack(plan.unitId, plan.targetId, plan.path));
    renderAll();
  });
  on('uCancel', () => u && client.cancel(`unit:${u.id}`));
  on('cOpen', () => ((panelFocus = selectedCity), openPanel('cities')));
  on('tClose', () => ((tileInfo = null), renderAll()));
  on('tMark', async () => {
    const at = tileInfo!;
    const label = prompt('Текст метки');
    if (label) markers = await client.addMarker(at.x, at.y, label, true).catch(() => markers);
    tileInfo = null;
    renderAll();
  });
  el.querySelectorAll<HTMLButtonElement>('[data-perk]').forEach(bt => (bt.onclick = () => u && submit(client.promote(u.id, bt.dataset.perk!))));
  el.querySelectorAll<HTMLButtonElement>('[data-ab]').forEach(bt => (bt.onclick = () => {
    if (!u) return;
    if (bt.dataset.ab === 'knockback') {
      bashMode = !bashMode;
      return renderAll();
    }
    actionMode = 'move';
    void submit(client.build(u.id, bt.dataset.ab as 'road'));
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-ctx]').forEach(bt => (bt.onclick = () => u && runCtx(u, bt.dataset.ctx!)));
  renderCtx();
}

// ---------- контекстные действия рядом с отрядом ----------
let ctxFits = true;
function ctxButtons(u: ViewUnit): { id: string; icon: string; label: string; cls: string }[] {
  const out = [{ id: 'move', icon: 'move', label: 'Движение', cls: actionMode === 'move' ? 'own on' : 'own' }];
  if (targetIds.size) out.push({ id: 'attack', icon: 'sword', label: 'Атака', cls: actionMode === 'attack' ? 'atk on' : 'atk' });
  if (!u.carriedBy) out.push({ id: 'hold', icon: 'shield', label: 'Защита', cls: 'own' });
  if (unitAbilities(u).length) out.push({ id: 'ability', icon: 'star', label: 'Способность', cls: actionMode === 'ability' ? 'own on' : 'own' });
  return out;
}
function runCtx(u: ViewUnit, id: string) {
  if (id === 'hold') {
    void submit(client.hold(u.id));
    actionMode = 'move';
  } else if (id === 'move' || id === 'attack' || id === 'ability') {
    actionMode = actionMode === id && id !== 'move' ? 'move' : (id as typeof actionMode);
  }
  renderAll();
}
function renderCtx() {
  const box = document.getElementById('ctx');
  if (!box) return;
  const st = client.state!;
  const u = selected ? st.view.units.find(x => x.id === selected && x.owner === st.view.me.id) : null;
  const planning = st.match.phase === 'planning' && !(player && !player.done) && !myMatchState().out;
  if (!u || !planning || attackPlan || panel) {
    box.innerHTML = '';
    return;
  }
  const items = ctxButtons(u);
  box.innerHTML = items.map(b => `<button class="ctx-btn ${b.cls}" data-ctx="${b.id}" aria-label="${b.label}" title="${b.label}">${icon(b.icon)}</button>`).join('');
  box.querySelectorAll<HTMLButtonElement>('[data-ctx]').forEach(bt => (bt.onclick = () => runCtx(u, bt.dataset.ctx!)));
  positionCtx();
}
/** Каждый кадр: кнопки под отрядом (или над ним), в пределах видимой области; иначе — в карточке. */
function positionCtx() {
  const box = document.getElementById('ctx');
  if (!box || !box.firstChild) return;
  const st = client.state!;
  const u = st.view.units.find(x => x.id === selected);
  if (!u) return;
  const S = cam.size;
  const p = tileToScreen(u.x, u.y);
  const w = box.childElementCount * 54;
  const topLimit = (document.getElementById('goal')?.getBoundingClientRect().bottom ?? 90) + 6;
  const bottomLimit = (document.getElementById('card')?.getBoundingClientRect().top ?? innerHeight - 160) - 6;
  // Точки, которые кнопки не должны закрывать: цели атаки (их фигуры выше клетки).
  const avoid = [...targetIds].map(id => st.view.units.find(x => x.id === id)).filter(Boolean).map(t => tileToScreen(t!.x, t!.y));
  const hits = (x: number, y: number) => avoid.some(a => a.sx > x - S * 0.3 && a.sx < x + w + S * 0.3 && a.sy + S * 0.15 > y && a.sy - S * 0.9 < y + 50);
  const clampX = (x: number) => Math.max(8, Math.min(innerWidth - w - 8, x));
  const options = [
    { x: clampX(p.sx - w / 2), y: p.sy + S * 0.22 + 6 },
    { x: clampX(p.sx - w / 2), y: p.sy - S * 1.05 - 54 },
    { x: clampX(p.sx - w - S * 0.4), y: p.sy - 25 },
    { x: clampX(p.sx + S * 0.4), y: p.sy - 25 },
  ];
  const inView = (o: { x: number; y: number }) => o.y >= topLimit && o.y + 50 <= bottomLimit;
  const pick = options.find(o => inView(o) && !hits(o.x, o.y));
  const { x, y } = pick ?? options[0];
  const fits = !!pick && p.sx > -20 && p.sx < innerWidth + 20;
  if (fits !== ctxFits) {
    ctxFits = fits;
    renderCard();
    return;
  }
  box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  box.style.visibility = fits ? 'visible' : 'hidden';
}

// ---------- выдвижные панели ----------
function openPanel(k: PanelKind) {
  if (panel === k) return closePanel();
  if (k === 'results' && client.state?.match.phase === 'finished' && !summary) {
    void client.summary(client.state.match.id).then(x => ((summary = x), panel === 'results' && renderPanel())).catch(() => null);
  }
  if (!backStack.includes(closePanel)) {
    backStack.push(closePanel);
    syncBack();
  }
  panel = k;
  attackPlan = null;
  renderPanel();
  renderCard();
  renderCtx();
  const el = document.getElementById('panel')!;
  el.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => el.classList.add('open'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('on'));
  const navId = { research: 'nResearch', cities: 'nCities', army: 'nArmy' }[k as string];
  if (navId) document.getElementById(navId)?.classList.add('on');
}
function closePanel() {
  if (!panel) return;
  panel = null;
  panelFocus = null;
  const i = backStack.indexOf(closePanel);
  if (i >= 0) backStack.splice(i, 1);
  syncBack();
  const el = document.getElementById('panel')!;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('on'));
  renderCard();
}
/** «На карте»: закрыть панель, перевести камеру, выделить объект. */
function showOnMap(kind: 'unit' | 'city', id: string) {
  const st = client.state!;
  closePanel();
  if (kind === 'unit') {
    const u = st.view.units.find(x => x.id === id);
    if (u) void select(u.id, true);
  } else {
    const c = st.view.cities.find(x => x.id === id);
    if (c) {
      cam = { ...cam, x: c.x, y: c.y };
      void select(null);
      selectedCity = c.id;
      renderAll();
    }
  }
  void loadVisibleChunks();
}

const MOD_TEXT: Record<string, (v: any) => string> = {
  attackBonus: v => `атака +${v}`, cityDefenseBonus: v => `защита городов +${v}`, goldPerCity: v => `+${v} золота с города`, foodPerCity: v => `+${v} еды в городе`,
  supplyRadius: v => `снабжение +${v}`, healBonus: v => `лечение +${v}`, xpMul: v => `опыт ×${v}`, roadCostMul: v => `дороги ×${v}`, cityVisionBonus: v => `обзор городов +${v}`,
  siegeAttackAfterMove: () => 'осадные стреляют после движения', roadSupply: () => 'снабжение по дорогам', plantForestAny: () => 'лес сажают строители',
  deepWater: () => 'амфибии по глубокой воде', coastalGold: v => `+${v} золота у моря`, mountainMoveCost: v => `горы — ${v} очка`, fortBonus: v => `укрепления +${v}`,
  formationBonus: v => `строй +${v}`, ambushBonus: v => `засада +${v}`, lootBonus: v => `руины +${Math.round(v * 100)}%`, plunderBonus: v => `добыча +${v}`,
  frontLimitBonus: v => `предел фронта +${v}`, scorchGold: v => `выжигание +${v} золота`, resonanceBonus: v => `резонанс +${v}`, obeliskLink: v => `связь обелисков +${v}`,
  ruinsKnowledge: v => `+${v} знания с руин`, obeliskField: v => `поле обелиска +${v}`,
};
function modsText(m: Record<string, any>): string {
  return Object.entries(m).map(([k, v]) => {
    if (typeof v === 'object') return Object.entries(v).map(([cls, n]) => `${k === 'rangeBonus' ? 'дальность' : k === 'moveBonus' ? 'движение' : k === 'visionBonusClass' ? 'обзор' : 'атака'} ${BALANCE.classes[cls] ?? cls} +${n}`).join(', ');
    return MOD_TEXT[k]?.(v) ?? k;
  }).join(', ');
}

function renderPanel() {
  const el = document.getElementById('panel')!;
  if (!panel) return;
  const st = client.state!;
  const me = st.view.me;
  const locked = (req: string | null) => !!req && !me.researched.includes(req);
  const costStr = (cst: Record<string, number | undefined>) => ['gold', 'wood', 'iron', 'crystal'].filter(k => cst[k]).map(k => `${RES_ICON[k]}${cst[k]}`).join(' ');
  const scrollBox = el.querySelector('.drawer-body');
  const keepScroll = el.dataset.kind === panel ? scrollBox?.scrollTop ?? 0 : 0;
  let title = '';
  let body = '';
  if (panel === 'research') {
    const ord = st.orders.find(o => o.subject === 'research');
    const queue: string[] = ord ? (ord.order as any).queue : me.researchQueue;
    const branches: Record<string, string> = { economy: 'Хозяйство', military: 'Военное дело', movement: 'Передвижение', knowledge: 'Знания', legacy: 'Наследие народа' };
    const techs = Object.entries(BALANCE.techs).filter(([, t]) => !t.faction || t.faction === me.faction);
    title = `Исследования`;
    body = `<div class="summary">${RES_ICON.knowledge}${me.researchProgress} · +${st.view.income.knowledge} за ход${queue.length ? ` · очередь: ${queue.map(t => esc(BALANCE.techs[t].name)).join(' → ')}` : ''}</div>
      ${queue.length ? '<button class="btn sm" id="rClear">Очистить очередь</button>' : ''}
      ${Object.entries(branches).map(([br, name]) => `<h4>${name}</h4>` + techs.filter(([, t]) => t.branch === br).map(([id, t]) => {
        const done = me.researched.includes(id);
        const inQ = queue.includes(id);
        const missing = t.requires.filter(r => !me.researched.includes(r) && !queue.includes(r));
        const excluded = (t.excludes ?? []).filter(x => me.researched.includes(x) || queue.includes(x));
        const opens = [...t.unlocksUnits.map(u => BALANCE.units[u].name), ...t.unlocksBuildings.map(x => BALANCE.buildings[x].name)];
        const why = missing.length ? `Нужно: ${missing.map(r => BALANCE.techs[r].name).join(', ')}` : excluded.length ? `Исключено выбором «${excluded.map(x => BALANCE.techs[x].name).join(', ')}»` : '';
        return `<div class="item ${done ? 'done' : ''}"><div><b>${esc(t.name)}</b><div class="muted">${esc([opens.length ? opens.join(', ') : '', modsText(t.modifiers)].filter(Boolean).join(' · '))}${why ? `<br><span class="why">${esc(why)}</span>` : ''}</div></div>
          ${done ? `<span class="tag ok">${icon('check')}</span>` : inQ ? '<span class="tag">в очереди</span>' : `<button class="btn sm gold" data-t="${id}" ${why ? 'disabled' : ''}>Исследовать · ${t.cost}</button>`}</div>`;
      }).join('')).join('')}`;
  } else if (panel === 'cities') {
    const cities = st.view.cities.filter(c => c.owner === me.id).sort((a, b) => (a.id === panelFocus ? -1 : b.id === panelFocus ? 1 : 0));
    title = `Города · ${cities.length}`;
    body = cities.map(c => {
      const ord = st.orders.find(o => o.subject === `recruit:${c.id}`);
      const cons = st.orders.find(o => o.subject === `construct:${c.id}`);
      const ci = st.view.income.cities[c.id];
      const need = BALANCE.cities.growthThresholds[c.level + 1];
      const itemName = (q: { kind: string; unitType: string }) => (q.kind === 'building' ? BALANCE.buildings[q.unitType].name : BALANCE.units[q.unitType].name);
      const units = Object.entries(BALANCE.units).filter(([, r]) => r.recruitable !== false && (!r.faction || r.faction === me.faction));
      const blds = Object.entries(BALANCE.buildings).filter(([id]) => !c.buildings.includes(id));
      return `<div class="block ${c.id === panelFocus ? 'focus' : ''}"><div class="row-between"><b>${esc(c.name)} · ур. ${c.level}${c.isCapital ? ' · столица' : ''}</b><button class="btn sm" data-map-city="${c.id}">${icon('map')}На карте</button></div>
        <div class="stats"><span>${RES_ICON.gold}+${ci?.gold ?? 0}</span><span>⚒ +${ci?.production ?? 0}</span><span>${RES_ICON.knowledge}+${ci?.knowledge ?? 0}</span><span>Еда ${c.food ?? 0}/${need ?? '—'}</span></div>
        ${c.contestedBy ? '<div class="why">Город оспаривается — найм недоступен</div>' : ''}
        <div class="muted">${c.queue.length ? 'Очередь: ' + c.queue.map(q => `${itemName(q)} ${q.progress}`).join(', ') : 'Очередь пуста'}${c.buildings.length ? ` · ${c.buildings.map(x => BALANCE.buildings[x].name).join(', ')}` : ''}</div>
        ${ord ? `<div class="row-between"><span>Заказано: ${esc(BALANCE.units[(ord.order as any).unitType].name)}</span><button class="btn sm" data-cancel="recruit:${c.id}">Отменить</button></div>` : ''}
        ${cons ? `<div class="row-between"><span>Стройка: ${esc(BALANCE.buildings[(cons.order as any).building].name)}</span><button class="btn sm" data-cancel="construct:${c.id}">Отменить</button></div>` : ''}
        <h4>Нанять</h4><div class="grid">${units.map(([id, r]) => `<button class="btn tile-btn" data-c="${c.id}" data-u="${id}" ${locked(r.requires) ? 'disabled' : ''}><b>${esc(r.name)}</b><span>${costStr(r.cost as any)}</span>${locked(r.requires) ? `<small>${esc(BALANCE.techs[r.requires!].name)}</small>` : ''}</button>`).join('')}</div>
        <h4>Построить</h4><div class="grid">${blds.map(([id, x]) => `<button class="btn tile-btn" data-c="${c.id}" data-b="${id}" ${locked(x.requires) ? 'disabled' : ''}><b>${esc(x.name)}</b><span>⚒${x.cost.production} ${costStr(x.cost as any)}</span></button>`).join('')}</div>
        ${!c.specialization && c.level >= BALANCE.cities.specializeMinLevel ? `<h4>Специализация</h4><div class="btn-row wrap">${Object.entries(BALANCE.specializations).map(([id, x]) => `<button class="btn sm" data-c="${c.id}" data-spec="${id}">${esc(x.name)}</button>`).join('')}</div>` : ''}</div>`;
    }).join('') || '<p class="empty">Нет городов</p>';
  } else if (panel === 'army') {
    const mine = st.view.units.filter(u => u.owner === me.id);
    title = `Войска · ${mine.length}`;
    body = mine.map(u => {
      const ord = st.orders.find(o => o.subject === `unit:${u.id}`);
      const rule = BALANCE.units[u.type];
      return `<div class="item">${portrait(u.type, st.view.players.find(p => p.id === me.id)?.color ?? '#36c')}<div class="grow"><b>${esc(rule.name)}</b><div class="muted">Здоровье ${u.hp}/${u.maxHp} · ${ord ? describeOrder(ord.order) : u.carriedBy ? 'на борту' : 'без приказа'}${u.pendingPerks ? ' · новый ранг' : ''}</div></div>
        <button class="btn sm" data-map-unit="${u.id}">${icon('map')}На карте</button></div>`;
    }).join('') || '<p class="empty">Нет отрядов</p>';
  } else if (panel === 'economy') {
    const inc = st.view.income;
    title = 'Казна';
    body = `<div class="block"><div class="row-between"><span>${RES_ICON.gold}Золото</span><b>${me.gold}</b></div>
      <div class="row-between muted"><span>Доход</span><span>+${inc.gold}</span></div><div class="row-between muted"><span>Содержание</span><span>−${inc.upkeep}</span></div>
      ${st.reserved.gold ? `<div class="row-between muted"><span>Зарезервировано приказами</span><span>−${st.reserved.gold}</span></div>` : ''}</div>
      <div class="block">${(['wood', 'iron', 'crystal'] as const).map(k => `<div class="row-between"><span>${RES_ICON[k]}${({ wood: 'Древесина', iron: 'Железо', crystal: 'Кристаллы' })[k]}</span><span>${me.materials[k]} <span class="muted">+${inc.materials[k]}</span></span></div>`).join('')}
      <div class="row-between"><span>${RES_ICON.knowledge}Знания</span><span>${me.researchProgress} <span class="muted">+${inc.knowledge}</span></span></div>
      <div class="row-between"><span>${RES_ICON.command}Очки командования</span><span>${me.commander.points}/${BALANCE.commander.maxPoints}</span></div></div>
      <h4>По городам</h4>${Object.entries(inc.cities).map(([cid, ci]) => `<div class="row-between muted"><span>${esc(st.view.cities.find(c => c.id === cid)?.name ?? cid)}</span><span>+${ci.gold} · ⚒${ci.production} · ✦${ci.knowledge}</span></div>`).join('')}`;
  } else if (panel === 'menu') {
    const { out } = myMatchState();
    title = 'Меню';
    body = `<div class="menu-list">
      <button class="btn wide" data-go="commander">${RES_ICON.command}Командир</button>
      <button class="btn wide" data-go="diplomacy">${icon('users')}Дипломатия</button>
      <button class="btn wide" id="mSupply">${icon('shield')}Снабжение: ${supplyLayer ? 'показано' : 'скрыто'}</button>
      <button class="btn wide" data-go="log">${icon('archive')}Журнал</button>
      ${st.view.turn > 1 || st.match.phase === 'finished' ? `<button class="btn wide" data-go="results">${icon('clock')}${st.match.phase === 'finished' ? 'Итоги и повтор' : 'Повтор ходов'}</button>` : ''}
      <button class="btn wide" id="mRooms">${icon('back')}Мои партии</button>
      ${st.match.phase !== 'finished' && !out ? `<button class="btn wide danger-text" id="mSurrender">${icon('flag')}Сдаться</button>` : ''}</div>`;
  } else if (panel === 'commander') {
    const cs = me.commander;
    const fac = BALANCE.factions[me.faction];
    const cmd = st.view.units.find(x => x.id === cs.unitId);
    title = fac.commander.name;
    body = `<div class="block"><div class="row-between"><span>${RES_ICON.command}Очки командования</span><b>${cs.points}/${BALANCE.commander.maxPoints}</b></div>
      ${cmd ? hpBar(cmd.hp, cmd.maxHp) : `<div class="why">Командир пал · вернётся с хода ${cs.respawnTurn} за ${BALANCE.commander.respawnGold} золота</div>`}
      ${cmd ? `<button class="btn sm" data-map-unit="${cmd.id}">${icon('map')}На карте</button>` : ''}</div>
      <h4>Способности</h4>${fac.commander.abilities.map(a => {
        const ab = BALANCE.commander.abilities[a];
        const cd = (cs.cooldowns[a] ?? 0) > st.view.turn;
        const why = !cmd ? 'Командир пал' : cd ? `Перезарядка до хода ${cs.cooldowns[a]}` : cs.points < ab.cost ? 'Мало очков' : '';
        return `<div class="item"><div class="grow"><b>${esc(ab.name)}</b><div class="muted">${esc(ab.description)}${why ? `<br><span class="why">${esc(why)}</span>` : ''}</div></div><button class="btn sm gold" data-cab="${a}" ${why ? 'disabled' : ''}>Применить · ${ab.cost}</button></div>`;
      }).join('')}
      <h4>Направления</h4><div class="btn-row wrap">${Object.entries(BALANCE.commander.directions).map(([d, x]) => `<button class="btn sm" data-dir="${d}" ${cs.pendingChoices > 0 ? '' : 'disabled'} title="${esc(x.description)}">${esc(x.name)} ${cs.directions[d] ?? 0}</button>`).join('')}</div>
      <div class="muted">${esc(fac.mechanic)}</div>`;
  } else if (panel === 'diplomacy') {
    const statusOf = (pid: string) => st.view.diplomacy.find(t => (t.a === pid && t.b === me.id) || (t.b === pid && t.a === me.id));
    const SN: Record<string, string> = { war: 'Война', truce: 'Перемирие', alliance: 'Союз' };
    title = 'Дипломатия';
    body = st.view.players.filter(p => p.id !== me.id).map(p => {
      const t = statusOf(p.id);
      const status = t?.status ?? BALANCE.diplomacy.default;
      const incoming = t?.proposal && t.proposal.from === p.id;
      const outgoing = t?.proposal && t.proposal.from === me.id;
      return `<div class="block"><div class="row-between"><span><span class="dot" style="background:${p.color}"></span><b>${esc(p.name)}</b> <span class="muted">${esc(BALANCE.factions[p.faction]?.name ?? '')}</span></span><span class="tag ${status}">${p.eliminated ? 'выбыл' : SN[status]}</span></div>
        ${t?.pending ? `<div class="why">Война с хода ${t.pending.effectiveTurn}</div>` : ''}
        ${incoming ? `<div class="row-between"><span>Предлагает: ${SN[t!.proposal!.status]}</span><span><button class="btn sm" data-ddec="${p.id}">Отклонить</button><button class="btn sm gold" data-dacc="${p.id}">Принять</button></span></div>` : ''}
        ${outgoing ? `<div class="muted">Ждёт ответа: ${SN[t!.proposal!.status]}</div>` : ''}
        ${p.eliminated ? '' : `<div class="btn-row wrap">${status === 'war' ? `<button class="btn sm" data-dprop="${p.id}" data-st="truce">Перемирие</button>` : ''}${status !== 'alliance' && st.view.mode.alliances ? `<button class="btn sm" data-dprop="${p.id}" data-st="alliance">Союз</button>` : ''}${status !== 'war' && !t?.pending ? `<button class="btn sm danger-text" data-dbrk="${p.id}">Разорвать</button>` : ''}</div>`}</div>`;
    }).join('');
  } else if (panel === 'results') {
    const finished = st.match.phase === 'finished';
    const last = finished ? st.match.turn - 0 : st.view.turn - 1;
    const maxTurn = Math.max(1, finished ? (summary?.turns ?? st.view.turn - 1) : st.view.turn - 1);
    replayTurn = Math.min(Math.max(1, replayTurn), maxTurn);
    void last;
    title = finished ? 'Итоги партии' : 'Повтор ходов';
    const reasonText: Record<string, string> = { elimination: 'остался один', capitals: 'захват столиц', influence_turn_limit: 'очки влияния к лимиту ходов', last_standing: 'остался один' };
    body = `${finished && summary ? `<div class="block"><div class="row-between"><b>${summary.winners.includes(me.id) ? 'Победа' : summary.winners.length ? 'Поражение' : 'Ничья'}</b><span class="muted">${summary.turns} ход. · ${esc(reasonText[summary.reason ?? ''] ?? summary.reason ?? '')}</span></div></div>
      ${summary.players.map(p => `<div class="item"><div class="grow"><b><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</b>${summary!.winners.includes(p.id) ? ' <span class="tag ok">победа</span>' : p.surrendered ? ' <span class="tag">сдался</span>' : ''}
        <div class="muted">Городов ${p.cities} · отрядов ${p.units} · захвачено ${p.captured} · потерь ${p.lost} · технологий ${p.techs}${p.score !== null && st.view.mode.victory === 'influence' ? ` · влияние ${p.score}` : ''}</div></div>
        ${p.rating?.rated ? `<span class="tag ${p.rating.after >= p.rating.before ? 'ok' : 'war'}">${p.rating.after} (${p.rating.after >= p.rating.before ? '+' : ''}${p.rating.after - p.rating.before})</span>` : ''}</div>`).join('')}` : ''}
      <h4>Повтор хода</h4>
      <div class="row-between"><button class="btn sm" id="rpPrev" ${replayTurn <= 1 ? 'disabled' : ''} aria-label="Предыдущий ход">${icon('back')}</button><b>Ход ${replayTurn} из ${maxTurn}</b><button class="btn sm" id="rpNext" ${replayTurn >= maxTurn ? 'disabled' : ''} aria-label="Следующий ход">${icon('back', 'flip')}</button></div>
      <button class="btn gold wide" id="rpPlay">Показать ход ${replayTurn}</button>`;
  } else if (panel === 'log') {
    title = 'Журнал';
    body = `<div class="log">${logLines.slice(-120).reverse().map(esc).join('<br>') || 'Пусто'}</div>`;
  }
  el.dataset.kind = panel;
  el.innerHTML = `<header class="drawer-head"><h2>${esc(title)}</h2><button class="icon-btn" id="pClose" aria-label="Закрыть">${icon('close')}</button></header><div class="drawer-body">${body}</div>`;
  el.querySelector('.drawer-body')!.scrollTop = keepScroll;
  paintPortraits(el);
  document.getElementById('pClose')!.onclick = closePanel;
  const all = <T extends HTMLElement>(sel: string) => el.querySelectorAll<T>(sel);
  all<HTMLButtonElement>('[data-t]').forEach(bt => (bt.onclick = () => {
    const ord = st.orders.find(o => o.subject === 'research');
    const queue: string[] = ord ? (ord.order as any).queue : me.researchQueue;
    void submit(client.research([...queue, bt.dataset.t!]));
  }));
  const rc = document.getElementById('rClear');
  if (rc) rc.onclick = () => submit(client.research([]));
  all<HTMLButtonElement>('[data-u]').forEach(bt => (bt.onclick = () => submit(client.recruit(bt.dataset.c!, bt.dataset.u!))));
  all<HTMLButtonElement>('[data-b]').forEach(bt => (bt.onclick = () => submit(client.construct(bt.dataset.c!, bt.dataset.b!))));
  all<HTMLButtonElement>('[data-spec]').forEach(bt => (bt.onclick = () => submit(client.specialize(bt.dataset.c!, bt.dataset.spec!))));
  all<HTMLButtonElement>('[data-cancel]').forEach(bt => (bt.onclick = () => client.cancel(bt.dataset.cancel!)));
  all<HTMLButtonElement>('[data-map-city]').forEach(bt => (bt.onclick = () => showOnMap('city', bt.dataset.mapCity!)));
  all<HTMLButtonElement>('[data-map-unit]').forEach(bt => (bt.onclick = () => showOnMap('unit', bt.dataset.mapUnit!)));
  all<HTMLButtonElement>('[data-go]').forEach(bt => (bt.onclick = () => {
    panel = null;
    openPanel(bt.dataset.go as PanelKind);
  }));
  all<HTMLButtonElement>('[data-cab]').forEach(bt => (bt.onclick = async () => {
    if (bt.dataset.cab === 'scout_pulse') {
      pulseMode = true;
      closePanel();
      toast('Выберите клетку на карте');
      return;
    }
    await submit(client.commanderAbility(bt.dataset.cab!));
  }));
  all<HTMLButtonElement>('[data-dir]').forEach(bt => (bt.onclick = () => submit(client.commanderDirection(bt.dataset.dir!))));
  all<HTMLButtonElement>('[data-dprop]').forEach(bt => (bt.onclick = () => submit(client.diplomacy(bt.dataset.dprop!, 'propose', bt.dataset.st as 'truce'))));
  all<HTMLButtonElement>('[data-dacc]').forEach(bt => (bt.onclick = () => submit(client.diplomacy(bt.dataset.dacc!, 'accept'))));
  all<HTMLButtonElement>('[data-ddec]').forEach(bt => (bt.onclick = () => submit(client.diplomacy(bt.dataset.ddec!, 'decline'))));
  all<HTMLButtonElement>('[data-dbrk]').forEach(bt => (bt.onclick = async () => (await confirmDialog('Разорвать договор?', `Война начнётся через ${BALANCE.diplomacy.breakWarningTurns} хода`, 'Разорвать')) && submit(client.diplomacy(bt.dataset.dbrk!, 'break'))));
  const rpp = document.getElementById('rpPrev');
  if (rpp) rpp.onclick = () => ((replayTurn--), renderPanel());
  const rpn = document.getElementById('rpNext');
  if (rpn) rpn.onclick = () => ((replayTurn++), renderPanel());
  const rpl = document.getElementById('rpPlay');
  if (rpl) rpl.onclick = async () => {
    const r = await client.replay(st.match.id, replayTurn).catch(e => (toast(errText(e)), null));
    if (!r) return;
    closePanel();
    startReplay(r.turn, r.events, r.before, r.after);
  };
  const ms = document.getElementById('mSupply');
  if (ms) ms.onclick = () => ((supplyLayer = !supplyLayer), renderPanel());
  const mr = document.getElementById('mRooms');
  if (mr) mr.onclick = () => lobby();
  const sr = document.getElementById('mSurrender');
  if (sr) sr.onclick = () => surrenderFlow(st.match.id, async () => {
    closePanel();
    await client.refresh().catch(() => null);
    renderAll();
  });
}

async function submit(p: Promise<any>) {
  try {
    const r = await p;
    if (r && r.ok === false) toast(REASONS[r.reason] ?? r.reason);
  } catch (e) {
    toast(errText(e));
  }
}

// ---------- карта ----------
function visibleChunkList(): [number, number][] {
  const st = client.state!;
  const cs = st.view.map.chunkSize;
  const { x0, x1, y0, y1 } = visibleBox();
  const out: [number, number][] = [];
  for (let cy = Math.floor(y0 / cs); cy <= Math.floor(y1 / cs); cy++) for (let cx = Math.floor(x0 / cs); cx <= Math.floor(x1 / cs); cx++) out.push([cx, cy]);
  return out;
}
let chunkLoading = false;
async function loadVisibleChunks() {
  if (chunkLoading) return;
  chunkLoading = true;
  try {
    await client.loadChunks(visibleChunkList());
  } finally {
    chunkLoading = false;
  }
}


function localMap(): MapData {
  const st = client.state!;
  const { width, height } = st.view.map;
  const terrain = new Uint8Array(width * height).fill(Terrain.DeepWater);
  const features = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = client.tile(x, y);
    if (t && t.terrain !== 255) {
      terrain[y * width + x] = t.terrain;
      features[y * width + x] = t.features;
    }
  }
  return { width, height, chunkSize: st.view.map.chunkSize, seed: '', generatorVersion: '', terrain, features };
}

function displayUnits(now: number): { units: (ViewUnit & { dx?: number; dy?: number; ghost?: boolean })[]; floats: { x: number; y: number; text: string; p: number }[] } {
  const st = client.state!;
  if (!player || !playback || player.done) {
    if (player?.done && playback) {
      markPlayed(playback.after.match.id, playback.after.view.turn - 1);
      player = null;
      playback = null;
      renderHud();
    }
    return { units: st.view.units, floats: [] };
  }
  const f = player.frame(now);
  const units = new Map(playback.before.view.units.map(u => [u.id, { ...u } as ViewUnit & { dx?: number; dy?: number }]));
  const apply = (s: PlaybackStep) => {
    const e = s.event;
    if (e.t === 'move') {
      const u = units.get(e.unitId) ?? (playback!.after.view.units.find(x => x.id === e.unitId) ? { ...playback!.after.view.units.find(x => x.id === e.unitId)! } : undefined);
      if (u) units.set(e.unitId, { ...u, x: e.to.x, y: e.to.y });
    } else if (e.t === 'unit_destroyed') units.delete(e.unitId);
    else if (e.t === 'unit_recruited') {
      const nu = playback!.after.view.units.find(x => x.id === e.unitId);
      if (nu) units.set(nu.id, { ...nu });
    } else if (s.kind === 'impact' && e.t === 'attack') {
      const u = units.get(e.targetId);
      if (u) u.hp -= e.damage;
    }
  };
  for (const s of f.finished) apply(s);
  const floats: { x: number; y: number; text: string; p: number }[] = [];
  for (const { step, p } of f.active) {
    const e = step.event;
    if (e.t === 'move' && step.kind === 'move') {
      const u = units.get(e.unitId) ?? playback.after.view.units.find(x => x.id === e.unitId);
      if (u) units.set(e.unitId, { ...u, x: e.from.x + (e.to.x - e.from.x) * p, y: e.from.y + (e.to.y - e.from.y) * p });
    } else if (step.kind === 'attack' || step.kind === 'counter') {
      if (e.t === 'attack') {
        const u = units.get(e.attackerId);
        const k = Math.sin(p * Math.PI) * 0.25;
        if (u) units.set(u.id, { ...u, dx: (e.to.x - e.from.x) * k, dy: (e.to.y - e.from.y) * k });
      }
    } else if (step.kind === 'impact' && e.t === 'attack') floats.push({ x: e.to.x, y: e.to.y, text: `−${e.damage}`, p });
    else if (step.kind === 'capture' && e.t === 'city_captured') floats.push({ x: e.at.x, y: e.at.y, text: 'Захвачен!', p });
    else if (step.kind === 'contest' && e.t === 'city_contested') floats.push({ x: e.at.x, y: e.at.y, text: 'Оспаривается', p });
    else if (step.kind === 'blocked' && e.t === 'move_blocked') floats.push({ x: e.at.x, y: e.at.y, text: '✋', p });
  }
  return { units: [...units.values()], floats };
}

// ---------- 2.5D: изометрическая проекция ----------
// Ромб клетки: ширина cam.size, высота cam.size/2. Высота рельефа поднимает верхнюю грань.
const ELEV: Record<number, number> = { 0: -0.12, 1: -0.06, 2: 0, 3: 0.04, 4: 0.32, 5: 0.6, 255: 0 };
const elevPx = () => cam.size * 0.42;
function tileElev(x: number, y: number): number {
  const t = client.tile(Math.round(x), Math.round(y));
  return t ? ELEV[t.terrain] ?? 0 : 0;
}
function project(x: number, y: number, z: number) {
  const S = cam.size;
  return { sx: innerWidth / 2 + (x - y - (cam.x - cam.y)) * S / 2, sy: innerHeight / 2 + (x + y - (cam.x + cam.y)) * S / 4 - z * elevPx() };
}
/** Центр верхней грани клетки (дробные координаты — для движения в анимации). */
const tileToScreen = (x: number, y: number) => project(x, y, tileElev(x, y));
function groundAt(sx: number, sy: number) {
  const S = cam.size;
  const a = (sx - innerWidth / 2) / (S / 2), b = (sy - innerHeight / 2) / (S / 4);
  return { x: (a + b) / 2 + cam.x, y: (b - a) / 2 + cam.y };
}
/** Клетка под пальцем с учётом высоты: выбирается самая передняя, чья верхняя грань содержит точку. */
const screenToTile = (sx: number, sy: number) => {
  const g = groundAt(sx, sy);
  const S = cam.size;
  let best: { x: number; y: number } | null = null;
  for (let y = Math.round(g.y) - 1; y <= Math.round(g.y) + 3; y++) for (let x = Math.round(g.x) - 1; x <= Math.round(g.x) + 3; x++) {
    const p = tileToScreen(x, y);
    if (Math.abs(sx - p.sx) / (S / 2) + Math.abs(sy - p.sy) / (S / 4) > 1) continue;
    if (!best || x + y > best.x + best.y) best = { x, y };
  }
  return best ?? { x: Math.round(g.x), y: Math.round(g.y) };
};
/** Касание: сначала фигуры отрядов (они выше своей клетки), затем клетка под пальцем. */
function pickTile(sx: number, sy: number) {
  const st = client.state!;
  const S = cam.size;
  const hit = st.view.units
    .filter(u => !u.carriedBy)
    .filter(u => {
      const p = tileToScreen(u.x, u.y);
      return Math.abs(sx - p.sx) <= S * 0.28 && sy <= p.sy + S * 0.12 && sy >= p.sy - S * 0.85;
    })
    .sort((a, b) => b.x + b.y - (a.x + a.y))[0];
  return hit ? { x: hit.x, y: hit.y } : screenToTile(sx, sy);
}
/** Прямоугольник клеток, покрывающий экран (с запасом на высоту). */
function visibleBox() {
  const st = client.state!;
  const pad = 2;
  const corners = [groundAt(0, -cam.size), groundAt(innerWidth, -cam.size), groundAt(0, innerHeight + cam.size), groundAt(innerWidth, innerHeight + cam.size)];
  return {
    x0: Math.max(0, Math.floor(Math.min(...corners.map(c => c.x))) - pad), x1: Math.min(st.view.map.width - 1, Math.ceil(Math.max(...corners.map(c => c.x))) + pad),
    y0: Math.max(0, Math.floor(Math.min(...corners.map(c => c.y))) - pad), y1: Math.min(st.view.map.height - 1, Math.ceil(Math.max(...corners.map(c => c.y))) + pad),
  };
}
/** Сдвиг камеры по движению пальца на экране. */
function panBy(cx: number, cy: number, dxPx: number, dyPx: number) {
  const S = cam.size;
  const a = dxPx / (S / 2), b = dyPx / (S / 4);
  cam.x = cx - (a + b) / 2;
  cam.y = cy - (b - a) / 2;
}

const RGB: Record<number, [number, number, number]> = { 0: [38, 92, 140], 1: [62, 128, 168], 2: [132, 172, 96], 3: [78, 128, 70], 4: [168, 150, 98], 5: [128, 128, 136], 255: [16, 19, 23] };
const shade = (c: [number, number, number], k: number) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
const jitter = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;

function diamond(sx: number, sy: number, S: number, shrink = 1) {
  ctx.beginPath();
  ctx.moveTo(sx, sy - S / 4 * shrink);
  ctx.lineTo(sx + S / 2 * shrink, sy);
  ctx.lineTo(sx, sy + S / 4 * shrink);
  ctx.lineTo(sx - S / 2 * shrink, sy);
  ctx.closePath();
}

function drawTile(x: number, y: number, t: ReturnType<typeof client.tile>, overlay: string | null) {
  const S = cam.size;
  const terr = t?.terrain ?? 255;
  const z = ELEV[terr] ?? 0;
  const { sx, sy } = project(x, y, z);
  if (sx < -S || sx > innerWidth + S || sy < -S * 2 || sy > innerHeight + S * 2) return;
  if (terr === 255) return; // неразведанное — пустота
  const base = RGB[terr] ?? RGB[255];
  const k = 0.93 + jitter(x, y) * 0.12;
  // Боковые грани: от верха до уровня глубокой воды.
  const depth = (z - ELEV[0]) * elevPx() + (terr === 255 ? 0 : S * 0.06);
  if (S >= 18 && depth > 1) {
    ctx.fillStyle = shade(base, 0.62 * k);
    ctx.beginPath();
    ctx.moveTo(sx - S / 2, sy); ctx.lineTo(sx, sy + S / 4); ctx.lineTo(sx, sy + S / 4 + depth); ctx.lineTo(sx - S / 2, sy + depth); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(base, 0.48 * k);
    ctx.beginPath();
    ctx.moveTo(sx + S / 2, sy); ctx.lineTo(sx, sy + S / 4); ctx.lineTo(sx, sy + S / 4 + depth); ctx.lineTo(sx + S / 2, sy + depth); ctx.closePath(); ctx.fill();
  }
  diamond(sx, sy, S, 1.01);
  ctx.fillStyle = shade(base, k);
  ctx.fill();
  if (terr <= 1 && S >= 24) {
    // блики воды
    ctx.strokeStyle = '#ffffff22';
    ctx.lineWidth = 1;
    const o = (jitter(y, x) - 0.5) * S * 0.3;
    ctx.beginPath(); ctx.moveTo(sx - S * 0.18 + o, sy); ctx.lineTo(sx + S * 0.05 + o, sy); ctx.stroke();
  }
  if (!t || terr === 255) return;
  // Дороги — к соседям с дорогой.
  if (t.features & 1 && S >= 16) {
    ctx.strokeStyle = '#c9b48a';
    ctx.lineWidth = Math.max(2, S * 0.07);
    ctx.lineCap = 'round';
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const n = client.tile(x + dx, y + dy);
      if (!n || !(n.features & 3)) continue;
      const p = project(x + dx * 0.5, y + dy * 0.5, z);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
    }
  }
  if (overlay) {
    diamond(sx, sy, S, 0.92);
    ctx.fillStyle = overlay;
    ctx.fill();
  }
  if (!t.visible) {
    diamond(sx, sy, S, 1.01);
    ctx.fillStyle = '#0b0f1488';
    ctx.fill();
  }
  if (S >= 22) {
    ctx.strokeStyle = '#00000018';
    ctx.lineWidth = 1;
    diamond(sx, sy, S);
    ctx.stroke();
  }
}

/** Объекты на клетке: лес, горы, мосты, укрепления, руины, ресурсы — рисуются в порядке глубины. */
function drawTileProps(x: number, y: number, t: NonNullable<ReturnType<typeof client.tile>>) {
  const S = cam.size;
  const { sx, sy } = tileToScreen(x, y);
  const fade = t.visible ? 1 : 0.55;
  ctx.save();
  ctx.globalAlpha = fade;
  if (t.features & 2) {
    if (!drawLiveArtIso(ctx, 'bridge', sx, sy + S * 0.18, S)) { ctx.fillStyle = '#8a6a3e'; ctx.fillRect(sx - S * 0.3, sy - S * 0.06, S * 0.6, S * 0.12); }
  } else if (t.terrain === 3) {
    if (!drawLiveArtIso(ctx, 'tree', sx, sy + S * 0.1, S, 1, 0.85 + jitter(x, y) * 0.2)) {
      for (const [ox, oy] of [[-0.14, 0.02], [0.12, -0.02], [0, 0.08]]) {
        const bx = sx + ox * S, by = sy + oy * S;
        ctx.fillStyle = '#2e5e34';
        ctx.beginPath(); ctx.moveTo(bx, by - S * 0.36); ctx.lineTo(bx + S * 0.09, by); ctx.lineTo(bx - S * 0.09, by); ctx.closePath(); ctx.fill();
      }
    }
  } else if (t.terrain === 5) {
    if (!drawLiveArtIso(ctx, 'mountain', sx, sy + S * 0.16, S)) {
      ctx.fillStyle = '#9a9aa4';
      ctx.beginPath(); ctx.moveTo(sx, sy - S * 0.55); ctx.lineTo(sx + S * 0.32, sy + S * 0.1); ctx.lineTo(sx - S * 0.32, sy + S * 0.1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#eee';
      ctx.beginPath(); ctx.moveTo(sx, sy - S * 0.55); ctx.lineTo(sx + S * 0.09, sy - S * 0.37); ctx.lineTo(sx - S * 0.09, sy - S * 0.37); ctx.closePath(); ctx.fill();
    }
  }
  if (t.features & 128 && S >= 14) {
    // укрепление: частокол по краю ромба
    ctx.strokeStyle = '#6b4a2b';
    ctx.lineWidth = Math.max(2, S * 0.05);
    diamond(sx, sy - S * 0.04, S, 0.78);
    ctx.stroke();
  }
  if (S >= 18) {
    const mark = (color: string, ox: number) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx + ox * S, sy + S * 0.08, Math.max(2, S * 0.05), 0, Math.PI * 2); ctx.fill();
    };
    if (t.features & 4) {
      const looted = client.state!.view.lootedRuins.includes(y * client.state!.view.map.width + x);
      ctx.fillStyle = looted ? '#77777799' : '#d8d2c4';
      for (const [ox, h] of [[-0.12, 0.16], [0.02, 0.24], [0.14, 0.12]]) ctx.fillRect(sx + ox * S, sy - h * S, S * 0.06, h * S);
    }
    if (t.features & 8) {
      ctx.fillStyle = '#ffd76a';
      ctx.font = `${Math.round(S * 0.3)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('✦', sx, sy - S * 0.08);
    }
    if (t.features & 16) mark('#8b5a2b', -0.2);
    if (t.features & 32) mark('#cfd3d8', 0.2);
    if (t.features & 64) mark('#9be7ff', 0);
  }
  ctx.restore();
}

function frame(now: number) {
  const st = client.state;
  if (!st) return requestAnimationFrame(frame);
  const W = innerWidth, H = innerHeight, S = cam.size;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0e1620');
  sky.addColorStop(1, '#0a0d11');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const { x0, x1, y0, y1 } = visibleBox();
  const cs = st.view.map.chunkSize;
  const moveSet = new Map((actionMode === 'attack' ? moveTiles.filter(m => m.embark || m.disembark) : moveTiles).map(m => [m.y * st.view.map.width + m.x, m]));
  const W0 = st.view.map.width;
  const targetTiles = new Map<number, boolean>();
  for (const id of targetIds) {
    const e = st.view.units.find(u => u.id === id);
    if (e) targetTiles.set(e.y * W0 + e.x, attackPlan?.targetId === id);
  }
  const selUnit = selected ? st.view.units.find(u => u.id === selected) : null;
  const selCity = selectedCity ? st.view.cities.find(c => c.id === selectedCity) : null;
  const selTile = selUnit ? selUnit.y * W0 + selUnit.x : selCity ? selCity.y * W0 + selCity.x : tileInfo ? tileInfo.y * W0 + tileInfo.x : -1;

  // Объекты по диагоналям глубины (x+y): рисуются после клеток своей диагонали.
  const layers = new Map<number, (() => void)[]>();
  const put = (x: number, y: number, fn: () => void) => {
    const d = Math.floor(x + y + 0.5);
    (layers.get(d) ?? layers.set(d, []).get(d)!).push(fn);
  };
  for (const c of st.view.cities) put(c.x, c.y, () => drawCity(c));
  for (const o of st.view.structures) put(o.x, o.y, () => drawObelisk(o));
  for (const o of st.view.mode.objectives) put(o.x, o.y, () => {
    const { sx, sy } = tileToScreen(o.x, o.y);
    ctx.fillStyle = st.view.players.find(p => p.id === o.holder)?.color ?? '#ffd76a';
    ctx.beginPath();
    ctx.moveTo(sx, sy - S * 0.85); ctx.lineTo(sx + S * 0.1, sy - S * 0.72); ctx.lineTo(sx, sy - S * 0.59); ctx.lineTo(sx - S * 0.1, sy - S * 0.72);
    ctx.fill();
  });
  for (const su of st.view.staleUnits) put(su.x, su.y, () => {
    const { sx, sy } = tileToScreen(su.x, su.y);
    ctx.globalAlpha = 0.35;
    drawUnit(sx, sy, su.type, st.view.players.find(p => p.id === su.owner)?.color ?? '#999', su.hp, false);
    ctx.globalAlpha = 1;
  });
  const { units, floats } = displayUnits(now);
  for (const u of units) {
    if (u.carriedBy) continue; // груз рисуется числом на транспорте
    const ux = u.x + (u.dx ?? 0), uy = u.y + (u.dy ?? 0);
    put(ux, uy, () => {
      const { sx, sy } = tileToScreen(ux, uy);
      drawUnit(sx, sy, u.type, st.view.players.find(p => p.id === u.owner)?.color ?? '#999', u.hp, u.id === selected, u.statuses.some(s => s.id === 'fortified'), u.maxHp);
      if (u.cargo) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`⛵+${u.cargo}`, sx, sy + S * 0.3);
      }
    });
  }

  for (let d = x0 + y0; d <= x1 + y1; d++) {
    const xa = Math.max(x0, d - y1), xb = Math.min(x1, d - y0);
    for (let x = xa; x <= xb; x++) {
      const y = d - x;
      const t = client.tile(x, y);
      let overlay: string | null = null;
      const m = moveSet.get(y * st.view.map.width + x);
      if (m) overlay = m.embark || m.disembark ? '#6fc3ff77' : '#f2c14e70';
      else if (supplyLayer && t && (client.chunk(Math.floor(x / cs), Math.floor(y / cs))?.supply ?? [])[(y % cs) * cs + (x % cs)]) overlay = '#5fbf7a44';
      drawTile(x, y, t, overlay);
      const ti = y * W0 + x;
      if (ti === selTile || targetTiles.has(ti)) {
        const p = tileToScreen(x, y);
        const isTarget = targetTiles.has(ti);
        ctx.lineWidth = isTarget && targetTiles.get(ti) ? 4 : 3;
        ctx.strokeStyle = isTarget ? '#e5483e' : '#f6d36b';
        if (isTarget) {
          diamond(p.sx, p.sy, cam.size, 0.92);
          ctx.fillStyle = targetTiles.get(ti) ? '#e5483e55' : '#e5483e26';
          ctx.fill();
        }
        diamond(p.sx, p.sy, cam.size, 0.96);
        ctx.stroke();
      }
    }
    for (let x = xa; x <= xb; x++) {
      const t = client.tile(x, d - x);
      if (t && t.terrain !== 255) drawTileProps(x, d - x, t);
    }
    for (const fn of layers.get(d) ?? []) fn();
  }

  // Обучение: пульсирующее кольцо вокруг цели шага.
  const tt = tutTarget();
  if (tt) {
    const p = tileToScreen(tt.x, tt.y);
    const k = reducedMotion ? 0.5 : (Math.sin(now / 260) + 1) / 2;
    ctx.strokeStyle = `rgba(244, 182, 63, ${0.55 + k * 0.45})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, S * (0.42 + k * 0.08), S * (0.21 + k * 0.04), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Приказы и метки — поверх сцены.
  for (const o of st.orders) {
    const ord = o.order;
    if (ord.kind !== 'unit') continue;
    const u = st.view.units.find(x => x.id === ord.unitId);
    if (!u || (!ord.path.length && ord.mode !== 'attack')) continue;
    ctx.strokeStyle = ord.mode === 'attack' ? '#e0614f' : '#f2c14e';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let p = tileToScreen(u.x, u.y);
    ctx.moveTo(p.sx, p.sy);
    for (const s of ord.path) {
      p = tileToScreen(s.x, s.y);
      ctx.lineTo(p.sx, p.sy);
    }
    if (ord.mode === 'attack' && ord.targetUnitId) {
      const t = st.view.units.find(x => x.id === ord.targetUnitId);
      if (t) {
        const tp = tileToScreen(t.x, t.y);
        ctx.lineTo(tp.sx, tp.sy - S * 0.3);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const mk of markers) {
    const { sx, sy } = tileToScreen(mk.x, mk.y);
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('⚑ ' + mk.label, sx, sy - S * 0.9);
  }
  for (const f of floats) {
    const { sx, sy } = tileToScreen(f.x, f.y);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000a';
    ctx.lineWidth = 3;
    ctx.font = 'bold 15px system-ui';
    ctx.textAlign = 'center';
    ctx.globalAlpha = 1 - f.p * 0.5;
    ctx.strokeText(f.text, sx, sy - S * 0.9 - f.p * 16);
    ctx.fillText(f.text, sx, sy - S * 0.9 - f.p * 16);
    ctx.globalAlpha = 1;
  }
  positionCtx();
  if (now - lastChunkCheck > 600) {
    lastChunkCheck = now;
    void loadVisibleChunks();
  }
  requestAnimationFrame(frame);
}
let lastChunkCheck = 0;

function drawCity(c: StateResponse['view']['cities'][number]) {
  const st = client.state!;
  const S = cam.size;
  const { sx, sy } = tileToScreen(c.x, c.y);
  const color = st.view.players.find(p => p.id === c.owner)?.color ?? '#bbb';
  // Площадка владельца
  diamond(sx, sy, S, 0.95);
  ctx.fillStyle = color + '55';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  const scale = 0.75 + Math.min(c.level, 5) * 0.08;
  if (!drawLiveArtIso(ctx, 'castle', sx, sy + S * 0.2, S, c.visibleNow ? 1 : 0.5, scale)) {
    ctx.fillStyle = '#d8cfb8';
    ctx.fillRect(sx - S * 0.22, sy - S * 0.42, S * 0.44, S * 0.42);
    ctx.fillStyle = color;
    ctx.fillRect(sx - S * 0.26, sy - S * 0.5, S * 0.52, S * 0.1);
  }
  if (c.contestedBy) {
    ctx.strokeStyle = '#e0614f';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    diamond(sx, sy, S, 1.1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (S > 20) {
    const label = c.name + (c.isCapital ? ' ★' : '') + ` ${c.level}`;
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = '#000a';
    ctx.fillRect(sx - w / 2, sy + S * 0.2, w, 16);
    ctx.fillStyle = c.visibleNow ? '#fff' : '#fff8';
    ctx.fillText(label, sx, sy + S * 0.2 + 12);
  }
}

function drawObelisk(o: StateResponse['view']['structures'][number]) {
  const st = client.state!;
  const S = cam.size;
  const { sx, sy } = tileToScreen(o.x, o.y);
  const color = st.view.players.find(p => p.id === o.owner)?.color ?? '#ccc';
  if (o.owner === st.view.me.id) {
    const r = BALANCE.obelisks.fieldRadius + 0.5;
    const pts = [[-r, -r], [r, -r], [r, r], [-r, r]].map(([dx, dy]) => project(o.x + dx, o.y + dy, 0));
    ctx.strokeStyle = o.linked ? '#b48cffaa' : '#55555599';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.fillStyle = '#3b3550';
  ctx.beginPath();
  ctx.moveTo(sx - S * 0.08, sy); ctx.lineTo(sx - S * 0.05, sy - S * 0.6); ctx.lineTo(sx, sy - S * 0.7); ctx.lineTo(sx + S * 0.05, sy - S * 0.6); ctx.lineTo(sx + S * 0.08, sy); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(sx - S * 0.02, sy - S * 0.5, S * 0.04, S * 0.3);
}

function drawUnit(sx: number, sy: number, type: string, color: string, hp: number, sel: boolean, fort = false, maxHp = 0) {
  const S = cam.size;
  // Тень и кольцо владельца на земле.
  ctx.fillStyle = '#0006';
  ctx.beginPath(); ctx.ellipse(sx, sy + S * 0.02, S * 0.26, S * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = sel ? '#f2c14e' : color;
  ctx.lineWidth = sel ? 4 : 3;
  ctx.beginPath(); ctx.ellipse(sx, sy + S * 0.02, S * 0.3, S * 0.14, 0, 0, Math.PI * 2); ctx.stroke();
  let top = sy - S * 0.85;
  if (!drawLiveArtIso(ctx, type, sx, sy + S * 0.04, S)) {
    // Условная фигура: столб с щитом в цвете владельца.
    const naval = BALANCE.units[type]?.class === 'naval';
    if (naval) {
      ctx.fillStyle = '#6b4a2b';
      ctx.beginPath(); ctx.moveTo(sx - S * 0.3, sy - S * 0.08); ctx.lineTo(sx + S * 0.3, sy - S * 0.08); ctx.lineTo(sx + S * 0.2, sy + S * 0.06); ctx.lineTo(sx - S * 0.2, sy + S * 0.06); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#eee';
      ctx.beginPath(); ctx.moveTo(sx, sy - S * 0.6); ctx.lineTo(sx + S * 0.2, sy - S * 0.12); ctx.lineTo(sx, sy - S * 0.12); ctx.closePath(); ctx.fill();
      top = sy - S * 0.65;
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.ellipse(sx, sy - S * 0.28, S * 0.17, S * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8d6b8';
      ctx.beginPath(); ctx.arc(sx, sy - S * 0.6, S * 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(S * 0.2)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(UNIT_LETTER[type] ?? '?', sx, sy - S * 0.26);
      ctx.textBaseline = 'alphabetic';
      top = sy - S * 0.72;
    }
  }
  if (S < 18) return;
  // Полоса здоровья над фигурой.
  const w = S * 0.5, frac = maxHp ? Math.max(0, Math.min(1, hp / maxHp)) : 1;
  ctx.fillStyle = '#000b';
  ctx.fillRect(sx - w / 2 - 1, top - 7, w + 2, 6);
  ctx.fillStyle = frac > 0.6 ? '#5fbf7a' : frac > 0.3 ? '#f2c14e' : '#e0614f';
  ctx.fillRect(sx - w / 2, top - 6, w * frac, 4);
  ctx.fillStyle = color;
  ctx.fillRect(sx - w / 2 - 6, top - 8, 5, 8);
  if (S > 30) {
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(String(hp), sx + w / 2 + 3, top - 1);
  }
  if (fort) {
    ctx.font = `${Math.round(S * 0.22)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('🛡', sx - S * 0.3, sy - S * 0.1);
  }
}

// ---------- ввод ----------
function bindInput() {
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  let pinch: { d: number; size: number } | null = null;
  let press: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;
  const cancelPress = () => {
    if (press) clearTimeout(press);
    press = null;
  };
  canvas.onpointerdown = e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    longPressed = false;
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
      // Удержание — сведения о клетке и метка.
      press = setTimeout(() => {
        if (!drag || drag.moved) return;
        longPressed = true;
        const t = screenToTile(drag.x, drag.y);
        selected = null;
        selectedCity = null;
        attackPlan = null;
        moveTiles = [];
        targetIds = new Set();
        tileInfo = t;
        navigator.vibrate?.(10);
        renderAll();
      }, 520);
    }
    if (pointers.size === 2) {
      cancelPress();
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), size: cam.size };
      drag = null;
    }
  };
  canvas.onpointermove = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cam.size = Math.max(16, Math.min(160, pinch.size * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      // Перетаскивание карты не выбирает клетку и не отдаёт приказ.
      if (Math.abs(dx) + Math.abs(dy) > 8) {
        drag.moved = true;
        cancelPress();
      }
      if (drag.moved) panBy(drag.cx, drag.cy, dx, dy);
    }
  };
  canvas.onpointerup = e => {
    pointers.delete(e.pointerId);
    cancelPress();
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && !longPressed) void tap(pickTile(e.clientX, e.clientY));
    void loadVisibleChunks();
    drag = null;
  };
  canvas.onpointercancel = e => {
    pointers.delete(e.pointerId);
    cancelPress();
    drag = null;
    pinch = null;
  };
  canvas.onwheel = e => {
    e.preventDefault();
    cam.size = Math.max(16, Math.min(160, cam.size * (e.deltaY > 0 ? 0.9 : 1.1)));
    void loadVisibleChunks();
  };
}

/** Цели атаки: видимые чужие отряды в дальности с текущей клетки или с клеток, доступных в этот ход. */
function computeTargets(u: ViewUnit) {
  const st = client.state!;
  const rule = BALANCE.units[u.type];
  const from = [{ x: u.x, y: u.y }, ...(rule.abilities.includes('no_attack_after_move') ? [] : moveTiles.filter(m => !m.embark))];
  const out = new Set<string>();
  if (u.carriedBy) return out;
  for (const e of st.view.units) {
    if (e.owner === st.view.me.id || e.carriedBy) continue;
    const treaty = st.view.diplomacy.find(t => (t.a === e.owner && t.b === st.view.me.id) || (t.b === e.owner && t.a === st.view.me.id));
    if (treaty && treaty.status !== 'war') continue;
    if (from.some(f => dist(f, e) <= rule.range && !(f.x === e.x && f.y === e.y))) out.add(e.id);
  }
  return out;
}

async function select(id: string | null, center = false) {
  selected = id;
  selectedCity = null;
  tileInfo = null;
  attackPlan = null;
  actionMode = 'move';
  moveTiles = [];
  targetIds = new Set();
  const st = client.state!;
  const u = id ? st.view.units.find(x => x.id === id) : null;
  if (u && center) cam = { ...cam, x: u.x, y: u.y };
  renderAll();
  if (u && u.owner === st.view.me.id && st.match.phase === 'planning' && !myMatchState().out) {
    moveTiles = await client.previewMoves(u.id).catch(() => []);
    if (selected !== id) return;
    targetIds = computeTargets(u);
    renderAll();
  }
}

async function planAttack(sel: ViewUnit, target: ViewUnit) {
  const st = client.state!;
  const rule = BALANCE.units[sel.type];
  let path: Coord[] = [];
  if (dist(sel, target) > rule.range) {
    const map = localMap();
    const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
    const best = moveTiles.filter(m => !m.embark && !m.disembark && dist(m, target) <= rule.range && !(m.x === target.x && m.y === target.y)).sort((a, b) => a.cost - b.cost)[0];
    const p = best && findPath(BALANCE, map, sel, best, { budget: rule.move, blocked });
    if (!p) return toast('Цель недостижима в этот ход');
    path = p;
  }
  // Прогноз — только из правил сервера; без выдуманных чисел.
  const pv = await client.previewAttack(sel.id, target.id, path).catch(() => null);
  if (!pv) return toast('Нет связи');
  if (!pv.ok) return toast(REASONS[pv.reason ?? ''] ?? pv.reason ?? '');
  attackPlan = { unitId: sel.id, targetId: target.id, path, damage: pv.damage!, counter: pv.counter!, counterPossible: !!pv.counterPossible, modifiers: pv.modifiers ?? [], warning: pv.warning };
  renderAll();
}

async function tap(t: Coord) {
  const st = client.state!;
  if (panel) closePanel();
  if (player && !player.done) return;
  if (pulseMode) {
    pulseMode = false;
    return submit(client.commanderAbility('scout_pulse', t));
  }
  const planning = st.match.phase === 'planning' && !myMatchState().out;
  const here = st.view.units.find(u => u.x === t.x && u.y === t.y && !u.carriedBy);
  const sel = selected ? st.view.units.find(u => u.id === selected && u.owner === st.view.me.id) : null;
  tileInfo = null;
  if (sel && planning) {
    const opt = moveTiles.find(m => m.x === t.x && m.y === t.y);
    if (opt?.disembark) return submit(client.disembark(sel.id, t));
    if (opt?.embark) {
      const map = localMap();
      const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
      const near = moveTiles.filter(m => !m.embark && dist(m, t) === 1).sort((a, b) => a.cost - b.cost)[0];
      const pre = dist(sel, t) === 1 ? [] : near && findPath(BALANCE, map, sel, near, { budget: BALANCE.units[sel.type].move, blocked });
      if (!pre) return toast('Транспорт недостижим в этот ход');
      return submit(client.embark(sel.id, [...pre, t]));
    }
    if (here && here.owner !== st.view.me.id) {
      if (targetIds.has(here.id)) return planAttack(sel, here);
      return select(here.id);
    }
    if (here && here.id === sel.id && here.cargo) {
      const cargo = st.view.units.find(u => u.carriedBy === here.id);
      if (cargo) return select(cargo.id);
    }
    if (here && here.owner === st.view.me.id) return select(here.id);
    if (attackPlan) {
      attackPlan = null;
      return renderAll();
    }
    if (opt && actionMode !== 'attack') {
      const map = localMap();
      const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
      const p = findPath(BALANCE, map, sel, t, { budget: BALANCE.units[sel.type].move, blocked });
      if (p) await submit(client.move(sel.id, p));
      return;
    }
    const tt = client.tile(t.x, t.y);
    if (!here && tt && tt.terrain !== 255 && !(t.x === sel.x && t.y === sel.y) && actionMode === 'move') {
      const map = localMap();
      const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
      const p = findPath(BALANCE, map, sel, t, { blocked });
      if (p && p.length <= BALANCE.routes.maxLength && (await confirmDialog(`Маршрут · ${p.length} клеток`, 'Отряд пойдёт несколько ходов и остановится, если рядом появится противник', 'Проложить', 'Отмена', false))) {
        await submit(client.longRoute(sel.id, p, true));
        return;
      }
    }
  }
  if (here) return select(here.id);
  const city = st.view.cities.find(c => c.x === t.x && c.y === t.y);
  if (city) {
    selected = null;
    moveTiles = [];
    targetIds = new Set();
    attackPlan = null;
    selectedCity = city.id;
    return renderAll();
  }
  // Пустая область снимает выделение.
  await select(null);
}

// ---------- воспроизведение результатов ----------
function startPlayback(turn: number, events: StoredEvent[], before: StateResponse | null, after: StateResponse) {
  logEvents(events, turn);
  void drawMinimap();
  selected = null;
  selectedCity = null;
  attackPlan = null;
  targetIds = new Set();
  moveTiles = [];
  void loadVisibleChunks();
  if (!before) return markPlayed(after.match.id, turn);
  playback = { before, after, events };
  player = new TimelinePlayer(buildTimeline(events, after.view.me.id, { reducedMotion }));
  const focus = player.timeline.steps.find(s => s.important && s.focus);
  if (focus?.focus) cam = { ...cam, x: focus.focus.x, y: focus.focus.y };
  renderHud();
}

/** Повтор прошлого хода: та же шкала анимаций, без записи в журнал. */
function startReplay(turn: number, events: StoredEvent[], before: StateResponse, after: StateResponse) {
  selected = null;
  selectedCity = null;
  attackPlan = null;
  targetIds = new Set();
  moveTiles = [];
  playback = { before, after, events };
  player = new TimelinePlayer(buildTimeline(events, after.view.me.id, { reducedMotion }));
  const focus = player.timeline.steps.find(s => s.important && s.focus);
  if (focus?.focus) cam = { ...cam, x: focus.focus.x, y: focus.focus.y };
  toast(`Повтор хода ${turn}`);
  renderAll();
}

function logEvents(events: StoredEvent[], turn?: number) {
  const st = client.state!;
  const name = (pid: string | null) => (pid ? st.view.players.find(p => p.id === pid)?.name ?? 'нейтрал' : 'нейтрал');
  for (const { event: e } of events) {
    const line =
      e.t === 'attack' ? `${e.kind === 'counter' ? 'Контратака' : 'Атака'}: ${BALANCE.units[e.attackerType].name} → ${BALANCE.units[e.targetType].name}, урон ${e.damage}` :
      e.t === 'unit_destroyed' ? `Уничтожен: ${BALANCE.units[e.unitType].name} (${name(e.owner)})` :
      e.t === 'city_captured' ? `Город захвачен: ${name(e.to)}` :
      e.t === 'city_contested' ? `Город оспаривается: ${name(e.by)}` :
      e.t === 'unit_recruited' ? `Нанят: ${BALANCE.units[e.unitType].name}` :
      e.t === 'research_completed' ? `Изучено: ${BALANCE.techs[e.techId].name}` :
      e.t === 'move_blocked' ? `Движение остановлено (${e.reason})` :
      e.t === 'attack_failed' ? `Атака не состоялась (${e.reason})` :
      e.t === 'order_rejected' ? `Приказ отклонён (${REASONS[e.reason] ?? e.reason})` :
      e.t === 'road_built' ? `Построена дорога (${e.at.x},${e.at.y})` :
      e.t === 'fort_built' ? `Построено укрепление (${e.at.x},${e.at.y})` :
      e.t === 'forest_planted' ? `Высажен лес (${e.at.x},${e.at.y})` :
      e.t === 'zoc_stop' ? 'Отряд остановлен зоной контроля противника' :
      e.t === 'suppressed' ? 'Отряд подавлен' :
      e.t === 'knockback' ? 'Отталкивание' :
      e.t === 'promotion_available' ? 'Новый ранг: выберите улучшение' :
      e.t === 'building_completed' ? `Построено: ${BALANCE.buildings[e.building].name}` :
      e.t === 'city_grew' ? `Город вырос до уровня ${e.level}` :
      e.t === 'supply_warning' ? (e.level === 'low' ? 'Отряд вне снабжения' : 'Отряд без снабжения: штраф') :
      e.t === 'commander_ability' ? `Командир: ${BALANCE.commander.abilities[e.ability].name}` :
      e.t === 'commander_fallen' ? `Командир пал, вернётся с хода ${e.respawnTurn}` :
      e.t === 'commander_respawned' ? 'Командир вернулся' :
      e.t === 'diplomacy_proposed' ? `${name(e.from)} предлагает ${name(e.to)}: ${BALANCE.diplomacy.statuses[e.status].name}` :
      e.t === 'diplomacy_changed' ? `${name(e.a)} и ${name(e.b)}: ${BALANCE.diplomacy.statuses[e.status].name}` :
      e.t === 'diplomacy_declined' ? `${name(e.from)} отклонил предложение` :
      e.t === 'diplomacy_break_announced' ? `${name(e.from)} разрывает договор с ${name(e.to)}: война с хода ${e.effectiveTurn}` :
      e.t === 'influence' ? `Влияние +${e.gained} (всего ${e.total})` :
      e.t === 'objective_held' ? `Цель ${e.objectiveId}: ${e.holder ? name(e.holder) : 'никто'}` :
      e.t === 'match_finished' ? `Партия окончена: ${e.winners.map(w => name(w)).join(', ') || 'без победителя'}` :
      e.t === 'route_paused' ? `Маршрут остановлен (${e.reason === 'threat' ? 'угроза рядом' : e.reason === 'blocked' ? 'путь перекрыт' : 'путь недоступен'})` :
      e.t === 'route_completed' ? 'Маршрут завершён' :
      e.t === 'build_failed' ? `Строительство сорвано (${e.reason})` :
      e.t === 'embarked' ? 'Отряд погрузился на транспорт' :
      e.t === 'disembarked' ? `Высадка (${e.to.x},${e.to.y})` :
      e.t === 'scorched' ? `Выжжена земля (${e.at.x},${e.at.y})${e.foodLost ? `, город потерял ${e.foodLost} еды` : ''}` :
      e.t === 'obelisk_built' ? `Поставлен обелиск (${e.at.x},${e.at.y})` :
      e.t === 'structure_destroyed' ? `Разрушен обелиск ${name(e.owner)} (${e.at.x},${e.at.y})` :
      e.t === 'ruins_looted' ? `Руины: +${e.amount} ${({ gold: 'золота', knowledge: 'знаний', xp: 'опыта', wood: 'древесины', crystal: 'кристаллов' } as Record<string, string>)[e.reward] ?? e.reward}` :
      e.t === 'world_event' ? `${e.phase === 'start' ? 'Событие' : 'Закончилось'}: ${BALANCE.worldEvents.list[e.eventId]?.name ?? e.eventId}${e.phase === 'start' ? ` (до хода ${e.endTurn})` : ''}` :
      e.t === 'momentum' ? 'Натиск: +1 к движению на следующий ход' :
      e.t === 'plunder' ? `Добыча: +${e.gold} золота` :
      e.t === 'income' ? `Доход +${e.gold}, содержание −${e.upkeep}${e.deficit ? ' — ДЕФИЦИТ' : ''}` : null;
    if (line) logLines.push(`[${turn ?? '?'}] ${line}`);
  }
}

boot();
