import { loadLiveArt, drawLiveArtIso } from './live-art.ts';
// Клиент: 2.5D-изометрия на Canvas 2D (рельеф с высотой, спрайты из web/art), без расчёта правил — только данные сервера.
import { BALANCE } from '../../src/shared/balance.ts';
import type { StateResponse, ViewUnit } from '../../src/shared/protocol.ts';
import type { Coord, MapData, StoredEvent } from '../../src/shared/types.ts';
import { Terrain } from '../../src/shared/types.ts';
import { dist } from '../../src/engine/grid.ts';
import { findPath } from '../../src/engine/path.ts';
import { ApiError, OskolkiClient, TimelinePlayer, buildTimeline, lastPlayedTurn, markPlayed } from '../../src/client-sdk/index.ts';
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
    if (!(e.target as HTMLElement).closest?.('.sheet, .screen, .bottom')) e.preventDefault();
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
  app.innerHTML = `<div class="screen"><h2>Осколки королевств</h2>
    <p class="muted">Вне Telegram доступен только тестовый вход (сервер с DEV_AUTH=1).</p>
    ${err ? `<p style="color:var(--bad)">${esc(err)}</p>` : ''}
    <div class="row"><input id="nm" placeholder="Имя" value="Игрок"><button class="primary" id="go">Войти</button></div></div>`;
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

async function lobby() {
  client.close();
  const matches = await client.listMatches().catch(() => []);
  app.innerHTML = `<div class="screen"><h2>Осколки королевств</h2>
    <div class="row">Победа: <select id="vic">${Object.entries(BALANCE.victoryModes).map(([id, v]) => `<option value="${id}">${esc(v.name)}</option>`).join('')}<option value="" selected>по пресету</option></select>
      Лимит ходов: <input id="tl" type="number" min="5" max="1000" placeholder="по пресету" style="width:110px"></div>
    <div class="row">Народ: <select id="fac">${Object.entries(BALANCE.factions).map(([id, f]) => `<option value="${id}">${esc(f.name)}</option>`).join('')}</select></div>
    <div class="row"><button class="primary" data-p="quick">Быстрая партия (90 с)</button><button data-p="vsbot">Против бота</button><button data-p="async">Асинхронная (6 ч)</button><button data-p="campaign">Кампания 256×256</button><button data-p="conquest">Завоевание 128×128</button><button data-p="islands">Архипелаг (флот)</button></div>
    <div class="row"><input id="code" placeholder="Код приглашения"><button id="join">Вступить</button></div>
    <h3>Мои партии</h3>
    ${matches.map(m => `<div class="card" data-m="${m.id}"><b>${esc(m.preset)}</b> · ${m.phase === 'lobby' ? `ожидание ${m.players.length}/${m.maxPlayers}` : m.phase === 'finished' ? 'завершена' : `ход ${m.turn}`}<br><span class="muted">${m.players.map(p => esc(p.name)).join(', ')}</span></div>`).join('') || '<p class="muted">Пока нет партий</p>'}
  </div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-p]').forEach(b => (b.onclick = async () => {
    const vic = (document.getElementById('vic') as HTMLSelectElement).value;
    const tl = (document.getElementById('tl') as HTMLInputElement).value;
    try {
      const m = await client.createMatch(b.dataset.p as 'quick', (document.getElementById('fac') as HTMLSelectElement).value, { ...(vic ? { victory: vic } : {}), ...(tl ? { turnLimit: Number(tl) } : {}) });
      openMatch(m.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.code : String(e));
    }
    return;
  }));
  document.getElementById('join')!.onclick = async () => {
    try {
      const m = await client.joinMatch((document.getElementById('code') as HTMLInputElement).value.trim(), (document.getElementById('fac') as HTMLSelectElement).value);
      openMatch(m.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.code : String(e));
    }
  };
  app.querySelectorAll<HTMLElement>('[data-m]').forEach(el => (el.onclick = () => openMatch(el.dataset.m!)));
}

async function openMatch(id: string) {
  const info = await client.matchDetails(id);
  if (info.phase === 'lobby') {
    app.innerHTML = `<div class="screen"><h2>Ожидание игроков ${info.players.length}/${info.maxPlayers}</h2>
      <p>Пригласите соперника ссылкой:</p><div class="card" style="word-break:break-all">${esc(info.inviteLink)}</div>
      <p class="muted">Код: ${esc(info.inviteCode)}</p>
      <div class="card">${info.players.map(p => `${esc(p.name)} — ${esc(BALANCE.factions[p.faction]?.name ?? p.faction)}`).join('<br>')}</div>
      <div class="muted">Режим: ${esc(BALANCE.victoryModes[info.victory as 'influence']?.name ?? '—')}${info.turnLimit ? `, лимит ${info.turnLimit} ходов` : ''}${info.alliances ? ', союзы разрешены' : ''}</div>
      <div class="row"><button id="addBot">Добавить бота</button></div>
      <div class="row">Мой народ: <select id="fac2">${Object.entries(BALANCE.factions).map(([fid, f]) => `<option value="${fid}">${esc(f.name)}</option>`).join('')}</select><button id="facSet">Сменить</button></div>
      <div class="row"><button id="share">Поделиться</button><button id="startNow" class="primary">Начать сейчас</button><button id="refresh">Обновить</button><button id="back">Назад</button></div>
      <p class="muted">Начать может создатель партии, когда игроков минимум двое.</p></div>`;
    document.getElementById('share')!.onclick = () => (tg?.openTelegramLink ? tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(info.inviteLink)}`) : navigator.clipboard?.writeText(info.inviteLink).then(() => toast('Ссылка скопирована')));
    document.getElementById('refresh')!.onclick = () => openMatch(id);
    document.getElementById('addBot')!.onclick = async () => {
      try {
        await client.addBots(id, 1);
        openMatch(id);
      } catch (e) {
        toast(e instanceof ApiError ? e.code : String(e));
      }
    };
    document.getElementById('facSet')!.onclick = async () => {
      try {
        await client.setFaction(id, (document.getElementById('fac2') as HTMLSelectElement).value);
        openMatch(id);
      } catch (e) {
        toast(e instanceof ApiError ? e.code : String(e));
      }
    };
    document.getElementById('startNow')!.onclick = async () => {
      try {
        toast('Генерация мира…');
        await client.startMatch(id);
        openMatch(id);
      } catch (e) {
        toast(e instanceof ApiError ? e.code : String(e));
      }
    };
    document.getElementById('back')!.onclick = () => lobby();
    const unsub = client.on('match', m => m.phase !== 'lobby' && (unsub(), openMatch(id)));
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
let moveTiles: { x: number; y: number; cost: number; embark?: boolean; disembark?: boolean }[] = [];
let sheet: 'none' | 'city' | 'research' | 'log' | 'commander' | 'diplomacy' = 'none';
let markerMode = false;
let markers: { id: number; playerId: string; x: number; y: number; label: string; shared: boolean }[] = [];
let bashMode = false;
let pulseMode = false;
let supplyLayer = false;
let player: TimelinePlayer | null = null;
let playback: { before: StateResponse; after: StateResponse; events: StoredEvent[] } | null = null;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let logLines: string[] = [];

async function gameScreen() {
  app.innerHTML = `<canvas id="map"></canvas>
    <div class="top" id="top"></div>
    <canvas id="mini" width="120" height="120" style="position:fixed;right:8px;top:52px;z-index:2;border:1px solid #fff4;border-radius:6px;background:#000a;width:120px;height:120px"></canvas>
    <div class="bottom">
      <button id="bResearch">Исследования</button><button id="bCities">Города</button><button id="bArmy">Армия</button><button id="bCmd">Командир</button><button id="bDip">Дипломатия</button><button id="bMark">Метка</button><button id="bSupply">Снабжение</button><button id="bLog">Журнал</button>
      <span class="spacer"></span><button class="primary" id="bReady">Готов</button>
    </div><div id="sheet"></div>`;
  canvas = document.getElementById('map') as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;
  resize();
  onresize = resize;
  const st = client.state!;
  const cap = st.view.cities.find(c => c.owner === st.view.me.id && c.isCapital) ?? st.view.units.find(u => u.owner === st.view.me.id);
  if (cap) cam = { ...cam, x: cap.x, y: cap.y };
  await loadVisibleChunks();
  bindInput();
  void drawMinimap();
  const mini = document.getElementById('mini') as HTMLCanvasElement;
  mini.onclick = e => {
    const r = mini.getBoundingClientRect();
    const v = client.state!.view.map;
    cam = { ...cam, x: ((e.clientX - r.left) / r.width) * v.width, y: ((e.clientY - r.top) / r.height) * v.height };
    void loadVisibleChunks();
  };
  document.getElementById('bReady')!.onclick = async () => {
    const me = client.state!.match.players.find(p => p.id === client.state!.view.me.id)!;
    const r = await client.setReady(!me.ready);
    if (!r.ok) toast(REASONS[r.reason ?? ''] ?? r.reason ?? 'Ошибка');
  };
  document.getElementById('bResearch')!.onclick = () => toggleSheet('research');
  document.getElementById('bCities')!.onclick = () => toggleSheet('city');
  document.getElementById('bLog')!.onclick = () => toggleSheet('log');
  document.getElementById('bCmd')!.onclick = () => toggleSheet('commander');
  document.getElementById('bDip')!.onclick = () => toggleSheet('diplomacy');
  document.getElementById('bMark')!.onclick = () => {
    markerMode = true;
    toast('Нажмите клетку, чтобы поставить метку');
  };
  markers = await client.markers().catch(() => []);
  document.getElementById('bSupply')!.onclick = () => {
    supplyLayer = !supplyLayer;
    toast(supplyLayer ? 'Слой снабжения: зелёным — своя зона' : 'Слой снабжения выключен');
  };
  document.getElementById('bArmy')!.onclick = () => {
    const st = client.state!;
    const idle = st.view.units.filter(u => u.owner === st.view.me.id && !st.orders.some(o => o.subject === `unit:${u.id}`));
    const list = idle.length ? idle : st.view.units.filter(u => u.owner === st.view.me.id);
    const next = list[(list.findIndex(u => u.id === selected) + 1) % list.length];
    if (next) select(next.id, true);
    if (!idle.length) toast('У всех отрядов есть приказы');
  };
  client.on('state', () => renderHud());
  client.on('match', () => renderHud());
  client.on('turnResolved', ({ turn, events, before, after }) => startPlayback(turn, events, before, after));
  // Восстановление после сворачивания: если результат прошлого хода ещё не показан — предложить показ.
  if (st.view.turn > 1 && lastPlayedTurn(st.match.id) < st.view.turn - 1) {
    const ev = await client.events(st.view.turn - 1);
    logEvents(ev);
    markPlayed(st.match.id, st.view.turn - 1);
  }
  renderHud();
  requestAnimationFrame(frame);
  // Раз в секунду обновляется только таймер в верхней панели — открытая панель не перерисовывается.
  setInterval(() => renderHud(false), 1000);
}

async function drawMinimap() {
  const mini = document.getElementById('mini') as HTMLCanvasElement | null;
  if (!mini) return;
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
  c.clearRect(0, 0, 120, 120);
  c.drawImage(off, 0, 0, 120, 120);
  const sx = 120 / mm.width, sy = 120 / mm.height;
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

function renderHud(withSheet = true) {
  const st = client.state;
  if (!st) return;
  const me = st.match.players.find(p => p.id === st.view.me.id);
  const left = st.match.deadline ? Math.max(0, Math.round((Date.parse(st.match.deadline) - Date.now()) / 1000)) : null;
  const time = left === null ? '—' : left > 3600 ? `${Math.floor(left / 3600)} ч ${Math.floor((left % 3600) / 60)} мин` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const readyCount = st.match.players.filter(p => p.ready || p.isBot).length;
  document.getElementById('top')!.innerHTML = `
    <span class="pill">◉ ${st.view.me.gold}${st.reserved.gold ? ` (−${st.reserved.gold})` : ''}</span>
    <span class="pill">🌲${st.view.me.materials.wood} ⛏${st.view.me.materials.iron} ◆${st.view.me.materials.crystal}</span>
    <span class="pill">★ ${st.view.me.commander.points}</span>
    <span class="pill">+${st.view.income.gold - st.view.income.upkeep}/ход</span>
    <span class="pill">✦ ${st.view.me.researchProgress}</span>
    <span class="pill">Ход ${st.view.turn}</span><span class="pill">⏱ ${time}</span>
    <span class="pill ${me?.ready ? 'ready' : ''}">Готовы ${readyCount}/${st.match.players.length}</span>
    ${st.view.mode.victory === 'influence' ? `<span class="pill">◈ ${st.view.mode.scores[st.view.me.id] ?? 0}</span>` : ''}
    ${st.view.mode.turnLimit ? `<span class="pill">до ${st.view.mode.turnLimit}</span>` : ''}
    ${st.view.worldEvents.map(e => `<span class="pill" title="${esc(e.description)}">☼ ${esc(e.name)} до ${e.endTurn}</span>`).join('')}
    ${st.match.phase === 'finished' ? `<span class="pill">${(st.match.winners ?? [st.match.winner]).includes(st.view.me.id) ? 'Победа!' : 'Партия завершена'}</span>` : ''}
    ${player && !player.done ? `<span class="spacer"></span><button id="sp">×${player.speed === 1 ? 2 : 1}</button><button id="sk">Пропустить</button>` : ''}`;
  const rb = document.getElementById('bReady') as HTMLButtonElement;
  rb.textContent = me?.ready ? 'Отменить готовность' : 'Готов';
  rb.className = me?.ready ? '' : 'primary';
  const sp = document.getElementById('sp');
  if (sp) sp.onclick = () => (player!.setSpeed(player!.speed === 1 ? 2 : 1), renderHud());
  const sk = document.getElementById('sk');
  if (sk) sk.onclick = () => player!.skip();
  const mini = document.getElementById('mini');
  if (mini) mini.style.top = `${(document.getElementById('top')?.offsetHeight ?? 44) + 6}px`;
  document.documentElement.style.setProperty('--bottom-h', `${document.querySelector<HTMLElement>('.bottom')?.offsetHeight ?? 58}px`);
  if (withSheet) renderSheet();
}

function toggleSheet(s: typeof sheet) {
  sheet = sheet === s ? 'none' : s;
  renderSheet();
}

/** Перерисовка панели с сохранением прокрутки. */
function renderSheet() {
  const el = document.getElementById('sheet')!;
  const kind = `${sheet}|${selected ?? ''}`;
  const top = el.dataset.kind === kind ? el.querySelector('.sheet')?.scrollTop ?? 0 : 0;
  renderSheetContent();
  el.dataset.kind = kind;
  const box = el.querySelector('.sheet');
  if (box) box.scrollTop = top;
}

function renderSheetContent() {
  const el = document.getElementById('sheet')!;
  const st = client.state!;
  const me = st.view.me;
  const u = selected ? st.view.units.find(x => x.id === selected) : null;
  const locked = (req: string | null) => !!req && !me.researched.includes(req);
  if (sheet === 'none' && u) {
    const rule = BALANCE.units[u.type];
    const ord = st.orders.find(o => o.subject === `unit:${u.id}`);
    const mineU = u.owner === st.view.me.id;
    const owner = st.view.players.find(p => p.id === u.owner);
    const effects = u.statuses.map(s => BALANCE.effects[s.id]?.name ?? s.id).join(', ');
    const perkOrder = st.orders.find(o => o.subject === `promote:${u.id}`);
    el.innerHTML = `<div class="sheet"><h3>${esc(rule.name)} ${mineU ? '' : `· ${esc(owner?.name ?? 'нейтрал')} (${esc(BALANCE.factions[owner?.faction ?? '']?.name ?? '')})`}</h3>
      <div>❤ ${u.hp}/${u.maxHp} · ⚔ ${rule.attack} · ⛨ ${rule.defense} · ➜ ${rule.move} · ◎ ${rule.range} · иниц. ${rule.initiative} · ранг ${u.rank}${effects ? ' · ' + esc(effects) : ''}</div>
      <div class="muted">${rule.abilities.map(a => BALANCE.effects[a]?.name ?? a).join(', ')}${u.perks?.length ? ' · улучшения: ' + u.perks.map(p => BALANCE.perks[p].name).join(', ') : ''}</div>
      ${mineU ? `<div class="muted">Приказ: ${ord ? describeOrder(ord.order) : 'нет (стоит на месте)'}</div>
      ${u.route?.path?.length ? `<div class="muted">Долгий маршрут: осталось ${u.route.path.length} шаг.${u.route.stopOnThreat ? ', остановка при угрозе' : ''}</div>` : ''}
      ${u.pendingPerks && !perkOrder ? `<div class="row">Новый ранг — выберите улучшение: ${Object.entries(BALANCE.perks).filter(([id]) => !u.perks?.includes(id)).map(([id, p]) => `<button data-perk="${id}" title="${esc(p.description)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="row"><button id="uHold">Укрепиться</button>
        <button data-build="road">Дорога</button><button data-build="fort">Форт</button><button data-build="forest">Посадить лес</button>
        ${BALANCE.factions[me.faction]?.traits.scorch ? '<button data-build="scorch">Выжечь</button>' : ''}
        ${BALANCE.factions[me.faction]?.traits.buildObelisk || rule.abilities.includes('build_obelisk') ? `<button data-build="obelisk">Обелиск ${BALANCE.obelisks.goldCost}◉</button>` : ''}
        ${u.carriedBy ? '<span class="muted">На борту: подсвечены клетки высадки</span>' : ''}${u.cargo ? `<span class="muted">На борту: ${u.cargo}</span>` : ''}
        ${rule.abilities.includes('knockback') ? `<button id="uBash" class="${bashMode ? 'primary' : ''}">Удар щитом: ${bashMode ? 'вкл' : 'выкл'}</button>` : ''}
        ${ord ? '<button id="uCancel">Отменить приказ</button>' : ''}</div>
      <div class="muted">Подсвеченная клетка — движение в этот ход; дальняя исследованная клетка — маршрут; противник — атака.</div>` : ''}</div>`;
    if (mineU) {
      document.getElementById('uHold')!.onclick = () => submit(client.hold(u.id));
      el.querySelectorAll<HTMLButtonElement>('[data-build]').forEach(bt => (bt.onclick = () => submit(client.build(u.id, bt.dataset.build as 'road'))));
      el.querySelectorAll<HTMLButtonElement>('[data-perk]').forEach(bt => (bt.onclick = () => submit(client.promote(u.id, bt.dataset.perk!))));
      const bash = document.getElementById('uBash');
      if (bash) bash.onclick = () => ((bashMode = !bashMode), renderSheet());
      const c = document.getElementById('uCancel');
      if (c) c.onclick = () => client.cancel(`unit:${u.id}`);
    }
  } else if (sheet === 'city') {
    const cities = st.view.cities.filter(c => c.owner === st.view.me.id);
    el.innerHTML = `<div class="sheet"><h3>Города</h3>${cities.map(c => {
      const ord = st.orders.find(o => o.subject === `recruit:${c.id}`);
      const cons = st.orders.find(o => o.subject === `construct:${c.id}`);
      const ci = st.view.income.cities[c.id];
      const itemName = (q: { kind: string; unitType: string }) => (q.kind === 'building' ? BALANCE.buildings[q.unitType].name : BALANCE.units[q.unitType].name);
      const itemCost = (q: { kind: string; unitType: string }) => (q.kind === 'building' ? BALANCE.buildings[q.unitType].cost.production : BALANCE.units[q.unitType].cost.production);
      const need = BALANCE.cities.growthThresholds[c.level + 1];
      const costStr = (cst: Record<string, number | undefined>) => ['gold', 'wood', 'iron', 'crystal'].filter(k => cst[k]).map(k => `${cst[k]}${{ gold: '◉', wood: '🌲', iron: '⛏', crystal: '◆' }[k]}`).join(' ');
      return `<div class="card"><b>${esc(c.name)}</b> ур. ${c.level}${c.specialization ? ` · ${esc(BALANCE.specializations[c.specialization].name)}` : ''}${c.contestedBy ? ' · <b style="color:var(--bad)">оспаривается</b>' : ''}
        <div class="muted">+${ci?.gold ?? 0}◉ +${ci?.production ?? 0}⚒ +${ci?.knowledge ?? 0}✦ · еда ${c.food ?? 0}/${need ?? '—'} · материалы +${ci?.wood ?? 0}🌲 +${ci?.iron ?? 0}⛏ +${ci?.crystal ?? 0}◆</div>
        <div class="muted">Постройки: ${c.buildings.map(x => BALANCE.buildings[x].name).join(', ') || 'нет'}</div>
        <div class="muted">Очередь: ${c.queue.map(q => `${itemName(q)} ${q.progress}/${itemCost(q)}`).join(', ') || 'пусто'}${ord ? ` · заказано: ${BALANCE.units[(ord.order as any).unitType].name}` : ''}${cons ? ` · строится: ${BALANCE.buildings[(cons.order as any).building].name}` : ''}</div>
        <div class="row">${Object.entries(BALANCE.units).filter(([, r]) => r.recruitable !== false && (!r.faction || r.faction === me.faction)).map(([id, r]) => `<button data-c="${c.id}" data-u="${id}" ${locked(r.requires) ? 'disabled' : ''}>${esc(r.name)} ${costStr(r.cost as any)}</button>`).join('')}
        ${ord ? `<button data-cancel="recruit:${c.id}">Отменить найм</button>` : ''}</div>
        <div class="row">${Object.entries(BALANCE.buildings).filter(([id]) => !c.buildings.includes(id)).map(([id, x]) => `<button data-c="${c.id}" data-b="${id}" ${locked(x.requires) ? 'disabled' : ''}>${esc(x.name)} ${x.cost.production}⚒ ${costStr(x.cost as any)}</button>`).join('')}
        ${cons ? `<button data-cancel="construct:${c.id}">Отменить стройку</button>` : ''}</div>
        ${!c.specialization && c.level >= BALANCE.cities.specializeMinLevel ? `<div class="row">Специализация: ${Object.entries(BALANCE.specializations).map(([id, x]) => `<button data-c="${c.id}" data-spec="${id}">${esc(x.name)}</button>`).join('')}</div>` : ''}</div>`;
    }).join('') || '<p class="muted">Нет городов</p>'}</div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-u]').forEach(bt => (bt.onclick = () => submit(client.recruit(bt.dataset.c!, bt.dataset.u!))));
    el.querySelectorAll<HTMLButtonElement>('[data-b]').forEach(bt => (bt.onclick = () => submit(client.construct(bt.dataset.c!, bt.dataset.b!))));
    el.querySelectorAll<HTMLButtonElement>('[data-spec]').forEach(bt => (bt.onclick = () => submit(client.specialize(bt.dataset.c!, bt.dataset.spec!))));
    el.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach(bt => (bt.onclick = () => client.cancel(bt.dataset.cancel!)));
  } else if (sheet === 'research') {
    const ord = st.orders.find(o => o.subject === 'research');
    const queue: string[] = ord ? (ord.order as any).queue : me.researchQueue;
    const branches: Record<string, string> = { economy: 'Хозяйство', military: 'Военное дело', movement: 'Передвижение и снабжение', knowledge: 'Разведка и знания', legacy: 'Наследие народа' };
    const techs = Object.entries(BALANCE.techs).filter(([, t]) => !t.faction || t.faction === me.faction);
    el.innerHTML = `<div class="sheet"><h3>Исследования · прогресс ${me.researchProgress} · +${st.view.income.knowledge}/ход</h3>
      <div class="muted">Очередь: ${queue.map(t => BALANCE.techs[t].name).join(' → ') || 'пусто'}</div>
      ${Object.entries(branches).map(([br, title]) => `<h3>${title}</h3>` + techs.filter(([, t]) => t.branch === br).map(([id, t]) => {
        const done = me.researched.includes(id);
        const missing = t.requires.filter(r => !me.researched.includes(r) && !queue.includes(r));
        const excluded = (t.excludes ?? []).filter(x => me.researched.includes(x) || queue.includes(x));
        const opens = [...t.unlocksUnits.map(u => BALANCE.units[u].name), ...t.unlocksBuildings.map(x => BALANCE.buildings[x].name)];
        return `<div class="card"><b>${esc(t.name)}</b> · ${t.cost} ✦ ${done ? '✓' : ''}
          <div class="muted">${opens.length ? 'Открывает: ' + opens.join(', ') + '. ' : ''}${Object.keys(t.modifiers).length ? 'Эффект: ' + esc(JSON.stringify(t.modifiers)) : ''}
          ${missing.length ? `<br>Требуется: ${missing.map(r => BALANCE.techs[r].name).join(', ')}` : ''}${excluded.length ? `<br>Недоступно: выбрано «${excluded.map(x => BALANCE.techs[x].name).join(', ')}»` : ''}${t.excludes?.length && !excluded.length ? `<br>Взаимоисключает: ${t.excludes.map(x => BALANCE.techs[x].name).join(', ')}` : ''}</div>
          ${!done && !queue.includes(id) && !missing.length && !excluded.length ? `<button data-t="${id}">В очередь</button>` : ''}</div>`;
      }).join('')).join('')}
      ${queue.length ? '<button id="rClear">Очистить очередь</button>' : ''}</div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-t]').forEach(bt => (bt.onclick = () => submit(client.research([...queue, bt.dataset.t!]))));
    const c = document.getElementById('rClear');
    if (c) c.onclick = () => submit(client.research([]));
  } else if (sheet === 'commander') {
    const cs = me.commander;
    const fac = BALANCE.factions[me.faction];
    const cmd = st.view.units.find(x => x.id === cs.unitId);
    el.innerHTML = `<div class="sheet"><h3>${esc(fac.commander.name)} · ${esc(fac.name)}</h3>
      <div class="muted">${esc(fac.mechanic)}<br>Слабость: ${esc(fac.weakness)}</div>
      <div>Очки командования: ${cs.points}/${BALANCE.commander.maxPoints}${cmd ? ` · ❤ ${cmd.hp}/${cmd.maxHp}` : ` · пал, вернётся с хода ${cs.respawnTurn} (${BALANCE.commander.respawnGold}◉)`}</div>
      <div class="row">${fac.commander.abilities.map(a => {
        const ab = BALANCE.commander.abilities[a];
        const cd = (cs.cooldowns[a] ?? 0) > st.view.turn;
        return `<button data-ab="${a}" ${!cmd || cd || cs.points < ab.cost ? 'disabled' : ''} title="${esc(ab.description)}">${esc(ab.name)} · ${ab.cost} очк.${cd ? ` (до хода ${cs.cooldowns[a]})` : ''}</button>`;
      }).join('')}</div>
      <div>Направления: ${Object.entries(BALANCE.commander.directions).map(([d, x]) => `${esc(x.name)} ${cs.directions[d] ?? 0}`).join(' · ')}</div>
      ${cs.pendingChoices > 0 ? `<div class="row">Выберите направление: ${Object.entries(BALANCE.commander.directions).map(([d, x]) => `<button data-dir="${d}" title="${esc(x.description)}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      ${cmd ? '<button id="cmdFocus">К командиру</button>' : ''}</div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-ab]').forEach(bt => (bt.onclick = async () => {
      if (bt.dataset.ab === 'scout_pulse') {
        pulseMode = true;
        toast('Нажмите клетку для разведывательного импульса');
        sheet = 'none';
        renderSheet();
        return;
      }
      await submit(client.commanderAbility(bt.dataset.ab!));
    }));
    el.querySelectorAll<HTMLButtonElement>('[data-dir]').forEach(bt => (bt.onclick = () => submit(client.commanderDirection(bt.dataset.dir!))));
    const f = document.getElementById('cmdFocus');
    if (f && cmd) f.onclick = () => select(cmd.id, true);
  } else if (sheet === 'diplomacy') {
    const mode = st.view.mode;
    const statusOf = (pid: string) => st.view.diplomacy.find(t => (t.a === pid && t.b === me.id) || (t.b === pid && t.a === me.id));
    const SN: Record<string, string> = { war: 'Война', truce: 'Перемирие', alliance: 'Союз' };
    el.innerHTML = `<div class="sheet"><h3>Дипломатия · ${esc(BALANCE.victoryModes[mode.victory].name)}${mode.turnLimit ? ` · ход ${st.view.turn}/${mode.turnLimit}` : ''}</h3>
      <div class="muted">${esc(BALANCE.victoryModes[mode.victory].description)}</div>
      ${mode.victory === 'influence' ? `<div>Очки: ${st.view.players.map(p => `${esc(p.name)} ${mode.scores[p.id] ?? 0}`).join(' · ')}</div><div class="muted">Целей: ${mode.objectives.length} (на карте — ромбы)</div>` : ''}
      ${st.view.players.filter(p => p.id !== me.id).map(p => {
        const t = statusOf(p.id);
        const status = t?.status ?? BALANCE.diplomacy.default;
        const incoming = t?.proposal && t.proposal.from === p.id;
        const outgoing = t?.proposal && t.proposal.from === me.id;
        return `<div class="card"><b>${esc(p.name)}</b> (${esc(BALANCE.factions[p.faction]?.name ?? '')})${p.eliminated ? ' — выбыл' : ''} · <b>${SN[status]}</b>
          ${t?.pending ? `<div class="muted">Разрыв: война с хода ${t.pending.effectiveTurn}</div>` : ''}
          ${incoming ? `<div>Предлагает: ${SN[t!.proposal!.status]} <button data-dacc="${p.id}">Принять</button><button data-ddec="${p.id}">Отклонить</button></div>` : ''}
          ${outgoing ? `<div class="muted">Ваше предложение: ${SN[t!.proposal!.status]} — ждёт ответа</div>` : ''}
          <div class="row">${status === 'war' ? `<button data-dprop="${p.id}" data-st="truce">Предложить перемирие</button>` : ''}${status !== 'alliance' && mode.alliances ? `<button data-dprop="${p.id}" data-st="alliance">Предложить союз</button>` : ''}${status !== 'war' && !t?.pending ? `<button data-dbrk="${p.id}">Разорвать (через ${BALANCE.diplomacy.breakWarningTurns} х.)</button>` : ''}</div></div>`;
      }).join('')}
      <div class="muted">${Object.values(BALANCE.diplomacy.statuses).map(x => `${x.name}: ${x.description}`).join('<br>')}</div></div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-dprop]').forEach(bt => (bt.onclick = () => submit(client.diplomacy(bt.dataset.dprop!, 'propose', bt.dataset.st as 'truce'))));
    el.querySelectorAll<HTMLButtonElement>('[data-dacc]').forEach(bt => (bt.onclick = () => submit(client.diplomacy(bt.dataset.dacc!, 'accept'))));
    el.querySelectorAll<HTMLButtonElement>('[data-ddec]').forEach(bt => (bt.onclick = () => submit(client.diplomacy(bt.dataset.ddec!, 'decline'))));
    el.querySelectorAll<HTMLButtonElement>('[data-dbrk]').forEach(bt => (bt.onclick = () => confirm('Разорвать договор? Война начнётся после периода предупреждения.') && submit(client.diplomacy(bt.dataset.dbrk!, 'break'))));
  } else if (sheet === 'log') {
    el.innerHTML = `<div class="sheet"><h3>Журнал событий</h3><div class="log">${logLines.slice(-80).reverse().map(esc).join('<br>') || 'Пусто'}</div></div>`;
  } else el.innerHTML = '';
}

function describeOrder(o: any): string {
  if (o.mode === 'hold') return 'удержание (укрепление)';
  if (o.mode === 'build') return o.build === 'fort' ? 'строительство укрепления' : o.build === 'forest' ? 'посадка леса' : 'строительство дороги';
  if (o.ability === 'knockback') return 'удар щитом';
  if (o.longRoute) return `маршрут (${o.path.length} шаг.)`;
  if (o.mode === 'move') return `движение (${o.path.length} шаг.)`;
  return `атака${o.path.length ? ` после ${o.path.length} шаг.` : ''}`;
}

async function submit(p: Promise<any>) {
  try {
    const r = await p;
    if (r && r.ok === false) toast(REASONS[r.reason] ?? r.reason);
  } catch (e) {
    toast(e instanceof ApiError ? (REASONS[e.code] ?? e.code) : 'Нет связи');
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
  const moveSet = new Map(moveTiles.map(m => [m.y * st.view.map.width + m.x, m]));

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
      if (m) overlay = m.embark || m.disembark ? '#6fc3ff66' : '#f2c14e55';
      else if (supplyLayer && t && (client.chunk(Math.floor(x / cs), Math.floor(y / cs))?.supply ?? [])[(y % cs) * cs + (x % cs)]) overlay = '#5fbf7a44';
      drawTile(x, y, t, overlay);
    }
    for (let x = xa; x <= xb; x++) {
      const t = client.tile(x, d - x);
      if (t && t.terrain !== 255) drawTileProps(x, d - x, t);
    }
    for (const fn of layers.get(d) ?? []) fn();
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
  canvas.onpointerdown = e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    if (pointers.size === 2) {
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
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      panBy(drag.cx, drag.cy, dx, dy);
    }
  };
  canvas.onpointerup = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved) void tap(pickTile(e.clientX, e.clientY));
    void loadVisibleChunks();
    drag = null;
  };
  canvas.onpointercancel = e => {
    pointers.delete(e.pointerId);
    drag = null;
    pinch = null;
  };
  canvas.onwheel = e => {
    e.preventDefault();
    cam.size = Math.max(16, Math.min(160, cam.size * (e.deltaY > 0 ? 0.9 : 1.1)));
    void loadVisibleChunks();
  };
}

async function select(id: string | null, center = false) {
  selected = id;
  moveTiles = [];
  sheet = 'none';
  const st = client.state!;
  const u = id ? st.view.units.find(x => x.id === id) : null;
  if (u && center) cam = { ...cam, x: u.x, y: u.y };
  if (u && u.owner === st.view.me.id && st.match.phase === 'planning') moveTiles = await client.previewMoves(u.id);
  renderSheet();
}

async function tap(t: Coord) {
  const st = client.state!;
  if (st.match.phase !== 'planning' || (player && !player.done)) return;
  if (markerMode) {
    markerMode = false;
    const label = prompt('Текст метки (видна союзникам):');
    if (label) markers = await client.addMarker(t.x, t.y, label, true).catch(() => markers);
    return;
  }
  if (pulseMode) {
    pulseMode = false;
    return submit(client.commanderAbility('scout_pulse', t));
  }
  const here = st.view.units.find(u => u.x === t.x && u.y === t.y && !u.carriedBy);
  const sel = selected ? st.view.units.find(u => u.id === selected && u.owner === st.view.me.id) : null;
  // Флот: высадка и погрузка по подсвеченным клеткам.
  const opt = sel && moveTiles.find(m => m.x === t.x && m.y === t.y);
  if (sel && opt?.disembark) return submit(client.disembark(sel.id, t));
  if (sel && opt?.embark) {
    const map = localMap();
    const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
    const near = moveTiles.filter(m => !m.embark && dist(m, t) === 1).sort((a, b) => a.cost - b.cost)[0];
    const pre = dist(sel, t) === 1 ? [] : near && findPath(BALANCE, map, sel, near, { budget: BALANCE.units[sel.type].move, blocked });
    if (!pre) return toast('Транспорт недостижим в этот ход');
    return submit(client.embark(sel.id, [...pre, t]));
  }
  // Свой транспорт с грузом: повторное касание выбирает груз.
  if (here && here.owner === st.view.me.id && here.id === selected && here.cargo) {
    const cargo = st.view.units.find(u => u.carriedBy === here.id);
    if (cargo) return select(cargo.id);
  }
  if (here && here.owner === st.view.me.id) return select(here.id);
  if (sel && here && here.owner !== st.view.me.id) {
    // Атака: с места, либо подойти в пределах бюджета движения.
    const rule = BALANCE.units[sel.type];
    let path: Coord[] = [];
    if (dist(sel, here) > rule.range) {
      const map = localMap();
      const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
      const best = moveTiles.filter(m => dist(m, here) <= rule.range).sort((a, b) => a.cost - b.cost)[0];
      const p = best && findPath(BALANCE, map, sel, best, { budget: rule.move, blocked });
      if (!p) return toast('Цель недостижима в этот ход');
      path = p;
    }
    const pv = await client.previewAttack(sel.id, here.id, path);
    if (!pv.ok) return toast(REASONS[pv.reason ?? ''] ?? pv.reason ?? '');
    const ok = confirm(`Атака: урон ${pv.damage}${pv.counterPossible ? `, ответный удар ${pv.counter}` : ', без ответа'}\nМодификаторы: ${(pv.modifiers ?? []).map(m => `${m.id} ×${m.value}`).join(', ') || 'нет'}\n\n${pv.warning}`);
    if (ok) await submit(bashMode && BALANCE.units[sel.type].abilities.includes('knockback') ? client.shieldBash(sel.id, here.id, path) : client.attack(sel.id, here.id, path));
    return;
  }
  if (sel && moveTiles.some(m => m.x === t.x && m.y === t.y)) {
    const map = localMap();
    const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
    const p = findPath(BALANCE, map, sel, t, { budget: BALANCE.units[sel.type].move, blocked });
    if (p) await submit(client.move(sel.id, p));
    return;
  }
  if (sel && !here) {
    const tt = client.tile(t.x, t.y);
    if (tt && tt.terrain !== 255) {
      const map = localMap();
      const blocked = new Set(st.view.units.filter(u => u.owner !== st.view.me.id).map(u => u.y * map.width + u.x));
      const p = findPath(BALANCE, map, sel, t, { blocked });
      if (p && p.length <= BALANCE.routes.maxLength) {
        if (confirm(`Маршрут на несколько ходов: ${p.length} шаг. Остановиться, если рядом появится противник?\nОК — да, Отмена — идти без остановки.`)) await submit(client.longRoute(sel.id, p, true));
        else await submit(client.longRoute(sel.id, p, false));
        return;
      }
    }
  }
  if (here) return select(here.id);
  const city = st.view.cities.find(c => c.x === t.x && c.y === t.y && c.owner === st.view.me.id);
  if (city) {
    sheet = 'city';
    return renderSheet();
  }
  select(null);
}

// ---------- воспроизведение результатов ----------
function startPlayback(turn: number, events: StoredEvent[], before: StateResponse | null, after: StateResponse) {
  logEvents(events, turn);
  void drawMinimap();
  selected = null;
  moveTiles = [];
  void loadVisibleChunks();
  if (!before) return markPlayed(after.match.id, turn);
  playback = { before, after, events };
  player = new TimelinePlayer(buildTimeline(events, after.view.me.id, { reducedMotion }));
  const focus = player.timeline.steps.find(s => s.important && s.focus);
  if (focus?.focus) cam = { ...cam, x: focus.focus.x, y: focus.focus.y };
  renderHud();
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
