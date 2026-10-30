// Отладочный клиент этапа 1. Вид сверху, условные цвета — только для проверки правил, сети и шкалы событий.
// Финальная изометрическая графика заменяет функции draw*/screenToTile, используя тот же OskolkiClient.
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
};
const TERRAIN_COLORS: Record<number, string> = { 0: '#1f4e79', 1: '#2f6f9f', 2: '#8fb36b', 3: '#3f7a46', 4: '#a99a63', 5: '#7d7f86', 255: '#0d1013' };
const UNIT_LETTER: Record<string, string> = { scout: 'Р', infantry: 'П', spearman: 'К', archer: 'Л', shieldbearer: 'Щ', cavalry: 'В', siege: 'О', engineer: 'И', legionary: 'Лг', standard: 'Зн', ranger: 'Сл', warden: 'Ст', ironclad: 'Лт', bombard: 'Б', corsair: 'Кр', tidecaller: 'З', commander: '★' };
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
  tg?.ready?.();
  tg?.expand?.();
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
    <div class="row"><button class="primary" data-p="quick">Быстрая партия (90 с)</button><button data-p="vsbot">Против бота</button><button data-p="async">Асинхронная (6 ч)</button><button data-p="campaign">Кампания 256×256</button></div>
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

let cam = { x: 16, y: 16, size: 28 };
let selected: string | null = null;
let moveTiles: { x: number; y: number; cost: number }[] = [];
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
  setInterval(renderHud, 1000);
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

function renderHud() {
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
    ${st.match.phase === 'finished' ? `<span class="pill">${(st.match.winners ?? [st.match.winner]).includes(st.view.me.id) ? 'Победа!' : 'Партия завершена'}</span>` : ''}
    ${player && !player.done ? `<span class="spacer"></span><button id="sp">×${player.speed === 1 ? 2 : 1}</button><button id="sk">Пропустить</button>` : ''}`;
  const rb = document.getElementById('bReady') as HTMLButtonElement;
  rb.textContent = me?.ready ? 'Отменить готовность' : 'Готов';
  rb.className = me?.ready ? '' : 'primary';
  const sp = document.getElementById('sp');
  if (sp) sp.onclick = () => (player!.setSpeed(player!.speed === 1 ? 2 : 1), renderHud());
  const sk = document.getElementById('sk');
  if (sk) sk.onclick = () => player!.skip();
  renderSheet();
}

function toggleSheet(s: typeof sheet) {
  sheet = sheet === s ? 'none' : s;
  renderSheet();
}

function renderSheet() {
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
  const half = { x: innerWidth / cam.size / 2 + 2, y: innerHeight / cam.size / 2 + 2 };
  const out: [number, number][] = [];
  for (let cy = Math.max(0, Math.floor((cam.y - half.y) / cs)); cy <= Math.min(st.view.map.height / cs - 1, Math.floor((cam.y + half.y) / cs)); cy++)
    for (let cx = Math.max(0, Math.floor((cam.x - half.x) / cs)); cx <= Math.min(st.view.map.width / cs - 1, Math.floor((cam.x + half.x) / cs)); cx++) out.push([cx, cy]);
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

const tileToScreen = (x: number, y: number) => ({ sx: innerWidth / 2 + (x - cam.x) * cam.size, sy: innerHeight / 2 + (y - cam.y) * cam.size });
const screenToTile = (sx: number, sy: number) => ({ x: Math.floor(cam.x + (sx - innerWidth / 2) / cam.size + 0.5), y: Math.floor(cam.y + (sy - innerHeight / 2) / cam.size + 0.5) });

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

function frame(now: number) {
  const st = client.state;
  if (!st) return requestAnimationFrame(frame);
  const W = innerWidth, H = innerHeight, S = cam.size;
  ctx.fillStyle = '#0d1013';
  ctx.fillRect(0, 0, W, H);
  const x0 = Math.max(0, Math.floor(cam.x - W / S / 2) - 1), x1 = Math.min(st.view.map.width - 1, Math.ceil(cam.x + W / S / 2) + 1);
  const y0 = Math.max(0, Math.floor(cam.y - H / S / 2) - 1), y1 = Math.min(st.view.map.height - 1, Math.ceil(cam.y + H / S / 2) + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = client.tile(x, y);
    const { sx, sy } = tileToScreen(x, y);
    ctx.fillStyle = TERRAIN_COLORS[t?.terrain ?? 255];
    ctx.fillRect(sx - S / 2, sy - S / 2, S - 1, S - 1);
    if (supplyLayer && t && (client.chunk(Math.floor(x / st.view.map.chunkSize), Math.floor(y / st.view.map.chunkSize))?.supply ?? [])[(y % st.view.map.chunkSize) * st.view.map.chunkSize + (x % st.view.map.chunkSize)]) {
      ctx.fillStyle = '#5fbf7a55';
      ctx.fillRect(sx - S / 2, sy - S / 2, S - 1, S - 1);
    }
    if (t && t.features & 128 && S > 12) {
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - S / 3, sy - S / 3, (S * 2) / 3, (S * 2) / 3);
    }
    if (t && t.terrain !== 255 && !t.visible) {
      ctx.fillStyle = '#0008';
      ctx.fillRect(sx - S / 2, sy - S / 2, S - 1, S - 1);
    }
    if (t && t.features & 0b1111100 && S > 16) {
      ctx.fillStyle = '#fff8';
      ctx.fillRect(sx + S / 4, sy - S / 2 + 2, 4, 4);
    }
  }
  // доступное перемещение
  ctx.fillStyle = '#f2c14e44';
  for (const m of moveTiles) {
    const { sx, sy } = tileToScreen(m.x, m.y);
    ctx.fillRect(sx - S / 2, sy - S / 2, S - 1, S - 1);
  }
  // города
  for (const c of st.view.cities) {
    const { sx, sy } = tileToScreen(c.x, c.y);
    const color = st.view.players.find(p => p.id === c.owner)?.color ?? '#bbb';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(sx - S / 2 + 2, sy - S / 2 + 2, S - 5, S - 5);
    if (c.contestedBy) {
      ctx.strokeStyle = '#e0614f';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx - S / 2 + 5, sy - S / 2 + 5, S - 11, S - 11);
      ctx.setLineDash([]);
    }
    if (S > 20) {
      ctx.fillStyle = c.visibleNow ? '#fff' : '#fff8';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(c.name + (c.isCapital ? ' ★' : ''), sx, sy + S / 2 + 10);
    }
  }
  // приказы
  for (const o of st.orders) {
    const ord = o.order;
    if (ord.kind !== 'unit') continue;
    const u = st.view.units.find(x => x.id === ord.unitId);
    if (!u) continue;
    ctx.strokeStyle = ord.mode === 'attack' ? '#e0614f' : '#f2c14e';
    ctx.lineWidth = 2;
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
        ctx.lineTo(tp.sx, tp.sy);
      }
    }
    ctx.stroke();
  }
  // цели влияния и метки
  for (const o of st.view.mode.objectives) {
    const { sx, sy } = tileToScreen(o.x, o.y);
    ctx.fillStyle = st.view.players.find(p => p.id === o.holder)?.color ?? '#ffd76a';
    ctx.beginPath();
    ctx.moveTo(sx, sy - S * 0.45);
    ctx.lineTo(sx + S * 0.2, sy - S * 0.25);
    ctx.lineTo(sx, sy - S * 0.05);
    ctx.lineTo(sx - S * 0.2, sy - S * 0.25);
    ctx.fill();
  }
  for (const mk of markers) {
    const { sx, sy } = tileToScreen(mk.x, mk.y);
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('⚑ ' + mk.label, sx, sy - S * 0.55);
  }
  // устаревшие сведения
  for (const su of st.view.staleUnits) {
    const { sx, sy } = tileToScreen(su.x, su.y);
    ctx.globalAlpha = 0.35;
    drawUnit(sx, sy, su.type, st.view.players.find(p => p.id === su.owner)?.color ?? '#999', su.hp, false);
    ctx.globalAlpha = 1;
  }
  const { units, floats } = displayUnits(now);
  for (const u of units) {
    const { sx, sy } = tileToScreen(u.x + (u.dx ?? 0), u.y + (u.dy ?? 0));
    drawUnit(sx, sy, u.type, st.view.players.find(p => p.id === u.owner)?.color ?? '#999', u.hp, u.id === selected, u.statuses.some(s => s.id === 'fortified'));
  }
  for (const f of floats) {
    const { sx, sy } = tileToScreen(f.x, f.y);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'center';
    ctx.globalAlpha = 1 - f.p * 0.5;
    ctx.fillText(f.text, sx, sy - S / 2 - f.p * 14);
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
}

function drawUnit(sx: number, sy: number, type: string, color: string, hp: number, sel: boolean, fort = false) {
  const S = cam.size;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(sx, sy, S * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = sel ? 3 : 1;
  ctx.strokeStyle = sel ? '#f2c14e' : '#000';
  ctx.stroke();
  if (fort) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - S * 0.42, sy - S * 0.42, S * 0.84, S * 0.84);
  }
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(S * 0.36)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(UNIT_LETTER[type] ?? '?', sx, sy + 1);
  ctx.textBaseline = 'alphabetic';
  if (S > 18) {
    ctx.font = '9px system-ui';
    ctx.fillText(String(hp), sx + S * 0.34, sy - S * 0.3);
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
      cam.size = Math.max(8, Math.min(64, pinch.size * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      cam.x = drag.cx - dx / cam.size;
      cam.y = drag.cy - dy / cam.size;
    }
  };
  canvas.onpointerup = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved) void tap(screenToTile(e.clientX, e.clientY));
    if (drag?.moved) void loadVisibleChunks();
    drag = null;
  };
  canvas.onpointercancel = e => {
    pointers.delete(e.pointerId);
    drag = null;
    pinch = null;
  };
  canvas.onwheel = e => {
    e.preventDefault();
    cam.size = Math.max(8, Math.min(64, cam.size * (e.deltaY > 0 ? 0.9 : 1.1)));
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
  const here = st.view.units.find(u => u.x === t.x && u.y === t.y);
  const sel = selected ? st.view.units.find(u => u.id === selected && u.owner === st.view.me.id) : null;
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
      e.t === 'income' ? `Доход +${e.gold}, содержание −${e.upkeep}${e.deficit ? ' — ДЕФИЦИТ' : ''}` : null;
    if (line) logLines.push(`[${turn ?? '?'}] ${line}`);
  }
}

boot();
