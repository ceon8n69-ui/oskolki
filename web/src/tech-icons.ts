// Иконки технологий: SVG-глифы (запасной вариант) и необязательный атлас web/art/tech-icons.png.
// Атлас: сетка TECH_ATLAS_COLS × N клеток по TECH_ATLAS_CELL px, порядок клеток — TECH_ICON_ORDER
// (порядок технологий в config/balance.json). Нет файла или клетки — рисуется глиф.
import { BALANCE } from '../../src/shared/balance.ts';

export const TECH_ATLAS_COLS = 8;
export const TECH_ATLAS_CELL = 128;
export const TECH_ICON_ORDER = Object.keys(BALANCE.techs);

const G: Record<string, string> = {
  wheat: '<path d="M12 21V8"/><path d="M12 8c-2-1-3-3-3-5 2 1 3 3 3 5zM12 8c2-1 3-3 3-5-2 1-3 3-3 5zM12 13c-2.5-.5-4-2.5-4.5-4.5 2.5.5 4 2.5 4.5 4.5zM12 13c2.5-.5 4-2.5 4.5-4.5-2.5.5-4 2.5-4.5 4.5zM12 18c-2.5-.5-4-2.5-4.5-4.5 2.5.5 4 2.5 4.5 4.5zM12 18c2.5-.5 4-2.5 4.5-4.5-2.5.5-4 2.5-4.5 4.5z"/>',
  axe: '<path d="M5 20 15 10"/><path d="M13 5c3 0 6 3 6 6l-3 1-4-4z"/>',
  pick: '<path d="M4 20 14 10"/><path d="M8 5c4-2 8-1 11 2-3 0-6 1-8 3M19 7c1 3 1 6-1 9"/>',
  scales: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-2.5 6h5zM19 7l-2.5 6h5z"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.9 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5"/>',
  drop: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/><path d="M9 14a3 3 0 0 0 3 3"/>',
  bank: '<path d="M3 9 12 4l9 5zM5 9v8M9.5 9v8M14.5 9v8M19 9v8M3 20h18"/>',
  bricks: '<path d="M3 6h18v12H3zM3 10h18M3 14h18M9 6v4M15 6v4M6 10v4M12 10v4M18 10v4M9 14v4M15 14v4"/>',
  spear: '<path d="M5 19 17 7"/><path d="M15 4h5v5l-3-2z"/><path d="M7 15l2 2"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="M12 7v10M8 11h8"/>',
  bow: '<path d="M6 3c7 2 11 8 9 18"/><path d="M6 3l9 18"/><path d="M4 13h12M14 11l2 2-2 2"/>',
  arrows: '<path d="M4 20 18 6M9 20 20 9"/><path d="M14 6h4v4M17 9h3v3"/>',
  boot: '<path d="M8 3h5v9l6 3v4H5v-4l3-2z"/><path d="M5 17h14"/>',
  hammer: '<path d="M6 20l8-8"/><path d="M12 6l5-3 4 4-3 5-2-2-2 2-4-4 2-2z"/>',
  horse: '<path d="M6 20c0-4 1-7 3-9l-3-2 2-4 4 3c3 0 6 2 7 5l-2 1-2-1v7"/><path d="M10 14l-2 6"/>',
  catapult: '<path d="M3 18h16M6 18l3-6 8-7"/><circle cx="17.5" cy="4.5" r="1.8"/><circle cx="6" cy="19" r="1.6"/><circle cx="16" cy="19" r="1.6"/>',
  wheel: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v6M12 14v6M4 12h6M14 12h6M6.5 6.5l4 4M13.5 13.5l4 4M17.5 6.5l-4 4M10.5 13.5l-4 4"/>',
  bomb: '<circle cx="11" cy="14" r="6"/><path d="M15 9l2-2M17 7l1-3M17 7l3 1"/>',
  drum: '<ellipse cx="12" cy="9" rx="7" ry="3"/><path d="M5 9v7c0 1.7 3 3 7 3s7-1.3 7-3V9M8 11.5l8 6M16 11.5l-8 6"/>',
  chess: '<path d="M8 20h8M9 20l1-7h4l1 7M10 13l-1-3h6l-1 3M12 10V7M10.5 5.5h3M12 4v3"/>',
  ship: '<path d="M3 15h18l-3 5H6z"/><path d="M12 15V3l6 9h-6M12 6 7 12h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="6"/>',
  road: '<path d="M8 21 10 3M16 21 14 3M12 5v2M12 10v3M12 16v3"/>',
  cart: '<path d="M2 7h3l2 9h11l2-7H6"/><circle cx="9" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>',
  cross: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M8 11h8M4 13c0 4 4 8 8 8s8-4 8-8"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  book: '<path d="M4 5c3-1 6-1 8 1v14c-2-2-5-2-8-1zM20 5c-3-1-6-1-8 1v14c2-2 5-2 8-1z"/>',
  tower: '<path d="M8 21V9H6V4h3v2h2V4h2v2h2V4h3v5h-2v12z"/><path d="M11 21v-4h2v4M11 12h2"/>',
  urn: '<path d="M9 3h6M10 3v3c-3 1-5 4-5 8 0 4 3 7 7 7s7-3 7-7c0-4-2-7-5-8V3"/><path d="M7 13h10"/>',
  banner: '<path d="M6 21V3M6 4h12l-3 4 3 4H6"/>',
  legion: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="M8.5 9h7M9.5 12h5M10.5 15h3"/>',
  columns: '<path d="M3 7l9-4 9 4zM5 7v11M10 7v11M14 7v11M19 7v11M3 20h18"/>',
  aqueduct: '<path d="M2 7h20M4 7v12M10 7v12M16 7v12M22 7v12"/><path d="M4 13c0-2 1-3 3-3s3 1 3 3M10 13c0-2 1-3 3-3s3 1 3 3M16 13c0-2 1-3 3-3s3 1 3 3"/>',
  tree: '<path d="M12 21v-5"/><path d="M12 3 6 11h3l-4 5h14l-4-5h3z"/>',
  sprout: '<path d="M12 21v-8"/><path d="M12 13c-4 0-6-2-6-6 4 0 6 2 6 6zM12 11c0-4 2-6 6-6 0 4-2 6-6 6z"/>',
  eye: '<path d="M2 12c3-5 6.5-7 10-7s7 2 10 7c-3 5-6.5 7-10 7S5 17 2 12z"/><circle cx="12" cy="12" r="3"/>',
  herb: '<path d="M12 21V9"/><path d="M12 9c-3 0-5-2-5-5 3 0 5 2 5 5zM12 13c3 0 5-2 5-5-3 0-5 2-5 5zM12 17c-3 0-5-2-5-5 3 0 5 2 5 5z"/>',
  helm: '<path d="M5 15c0-5 3-9 7-9s7 4 7 9v3H5z"/><path d="M12 6v12M8 12h3"/>',
  cannon: '<path d="M3 13l12-5 2 4-12 5z"/><circle cx="8" cy="18" r="2.5"/><path d="M17 10l3-1"/>',
  tunnel: '<path d="M3 20h18M5 20v-7a7 7 0 0 1 14 0v7"/><path d="M9 20v-6a3 3 0 0 1 6 0v6"/>',
  fort: '<path d="M3 20V9l3 2 3-2 3 2 3-2 3 2 3-2v11z"/><path d="M10 20v-4h4v4"/>',
  gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 16M15 4l-3 16"/>',
  clan: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16M7 7l10 10M17 7 7 17"/>',
  wave: '<path d="M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 10c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  trident: '<path d="M12 21V5M7 4v4a5 5 0 0 0 10 0V4M12 3v2"/>',
  harbor: '<path d="M4 20h16M6 20V10h5v10M11 13h7v7"/><path d="M8.5 7V4"/>',
  reef: '<path d="M3 20h18M6 20c0-4 1-7 3-9M9 20c0-5 2-9 5-11M14 20c0-3 1-6 4-8"/>',
  flame: '<path d="M12 21c-4 0-7-3-7-7 0-4 4-6 4-10 2 2 3 3 3 5 1-1 2-2 2-4 3 3 5 6 5 9 0 4-3 7-7 7z"/>',
  raider: '<path d="M4 20c1-5 3-8 6-10l-2-3 3-2 3 3c3 1 5 3 6 6"/><path d="M15 8l5-5M18 3h2v2"/>',
  coins: '<ellipse cx="9" cy="8" rx="5" ry="2.5"/><path d="M4 8v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V8"/><ellipse cx="15" cy="15" rx="5" ry="2.5"/><path d="M10 15v3c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-3"/>',
  horde: '<path d="M3 20l3-7 3 3 3-8 3 8 3-3 3 7z"/>',
  ember: '<circle cx="12" cy="15" r="5"/><path d="M12 10c0-3 2-4 2-7M9 11c-1-2 0-4-1-6M15 11c1-2 1-3 3-4"/>',
  rune: '<path d="M7 3v18M7 8l8-5M7 13l8 5M15 3v18"/>',
  golem: '<path d="M8 3h8v5H8zM6 8h12v8H6zM8 16v5M16 16v5M4 10h2M18 10h2"/><path d="M10 5h.01M14 5h.01"/>',
  tuning: '<circle cx="12" cy="12" r="2"/><path d="M8 8a5.5 5.5 0 0 0 0 8M16 8a5.5 5.5 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  obelisk: '<path d="M10 3h4l2 16H8zM6 21h12M12 3v2"/>',
  scroll: '<path d="M7 4h11a2 2 0 0 1 0 4H9v10a2 2 0 0 1-4 0V6a2 2 0 0 1 2-2z"/><path d="M11 12h5M11 15h5"/>',
  seal: '<circle cx="12" cy="10" r="6"/><path d="M9 15l-2 6 5-2 5 2-2-6M10 10h4"/>',
  stirrup: '<path d="M8 3h8M12 3v4M7 20c0-7 2-13 5-13s5 6 5 13zM6 20h12"/>',
  yurt: '<path d="M3 19c0-5 4-9 9-11 5 2 9 6 9 11z"/><path d="M10 19v-4h4v4M7 13h10"/>',
  horsebow: '<path d="M4 20c1-4 3-7 6-8l-2-3 3-2 2 3"/><path d="M14 3c5 2 7 7 5 13M14 3l5 13"/>',
  post: '<path d="M4 20 10 4h4l6 16"/><path d="M7 12h10M12 4v3"/>',
  khan: '<path d="M4 18 6 8l4 4 2-7 2 7 4-4 2 10z"/><path d="M4 21h16"/>',
  tribute: '<path d="M4 10h16v10H4zM7 10V7a5 5 0 0 1 10 0v3"/><path d="M12 14v2"/>',
  berserk: '<path d="M5 20 15 10"/><path d="M14 4c4 0 6 3 6 6l-3 1-4-4zM5 9l4 4M3 11l2-2"/>',
  mead: '<path d="M6 6h10v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM16 9h2a2 2 0 0 1 0 6h-2"/><path d="M6 10h10"/>',
  saga: '<path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 15h8M8 18h5"/>',
  longship: '<path d="M2 14c3 3 17 3 20 0l-2 4H4z"/><path d="M12 14V4l6 7h-6"/><path d="M2 14c0-2 1-4 3-4"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.5 4.5 2.5 2 2.5-2M9.5 19.5l2.5-2 2.5 2"/>',
};

const BY_TECH: Record<string, string> = {
  agriculture: 'wheat', forestry: 'axe', mining: 'pick', trade: 'scales', currency: 'coin', irrigation: 'drop', banking: 'bank', masonry: 'bricks',
  spearcraft: 'spear', shields: 'shield', archery: 'bow', longbows: 'arrows', skirmishers: 'boot', smithing: 'hammer', horsemanship: 'horse',
  siegecraft: 'catapult', mobile_siege: 'wheel', heavy_siege: 'bomb', drill: 'drum', tactics_doctrine: 'chess', naval_warfare: 'ship',
  engineering: 'gear', roadbuilding: 'road', logistics: 'cart', field_medicine: 'cross', navigation: 'anchor',
  cartography: 'compass', academia: 'book', watchtowers: 'tower', archaeology: 'urn',
  union_legion: 'legion', union_banners: 'banner', union_highways: 'road', union_phalanx: 'shield', union_aqueducts: 'aqueduct', union_senate: 'columns',
  forest_rangers: 'bow', forest_wardens: 'tree', forest_growth: 'sprout', forest_ambush: 'eye', forest_herbalism: 'herb', forest_bows: 'arrows',
  mountain_iron: 'helm', mountain_bombard: 'cannon', mountain_tunnels: 'tunnel', mountain_bastion: 'fort', mountain_gems: 'gem', mountain_clans: 'clan',
  tide_corsairs: 'trident', tide_callers: 'wave', tide_currents: 'wave', tide_harbors: 'harbor', tide_fleet: 'ship', tide_reefs: 'reef',
  ash_raiders: 'raider', ash_fire: 'flame', ash_pillage: 'coins', ash_warbands: 'horde', ash_cinders: 'ember', ash_onslaught: 'horde',
  ruins_runes: 'rune', ruins_golems: 'golem', ruins_attunement: 'tuning', ruins_conduits: 'obelisk', ruins_archive: 'scroll', ruins_wards: 'seal',
  steppe_saddles: 'stirrup', steppe_yurts: 'yurt', steppe_horse_archers: 'horsebow', steppe_relay: 'post', steppe_khan_guard: 'khan', steppe_tribute: 'tribute',
  north_berserkers: 'berserk', north_huscarls: 'shield', north_mead: 'mead', north_sagas: 'saga', north_longships: 'longship', north_frost: 'snow',
};

/** Эмблемы народов (центр дерева, выбор народа). */
const FACTION_GLYPH: Record<string, string> = {
  union: 'columns', forest: 'tree', mountain: 'tunnel', tide: 'trident', ash: 'flame', ruins: 'obelisk', steppe: 'khan', north: 'longship',
};

/** Эмблемы народов: web/art/faction-emblems.png, одна строка, клетки по FACTION_ATLAS_CELL px в порядке FACTION_ORDER. */
export const FACTION_ATLAS_CELL = 256;
export const FACTION_ORDER = Object.keys(BALANCE.factions);

let atlas: HTMLImageElement | null = null;
let atlasRows = 0;
let emblems: HTMLImageElement | null = null;
async function loadImage(file: string): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.src = new URL('./art/' + file, location.href).href;
    await img.decode();
    return img;
  } catch {
    return null; // файла нет — рисуем глифы
  }
}
export async function loadTechAtlas(): Promise<void> {
  if (new URLSearchParams(location.search).get('graphics') === '0') return;
  [atlas, emblems] = await Promise.all([loadImage('tech-icons.png'), loadImage('faction-emblems.png')]);
  atlasRows = atlas ? Math.floor(atlas.naturalHeight / TECH_ATLAS_CELL) : 0;
}

export function glyph(key: string, cls = 'tg'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${G[key] ?? G.book}</svg>`;
}

/** Картинка технологии: клетка атласа, если он есть, иначе глиф. */
export function techIcon(id: string, cls = 'tg'): string {
  const i = TECH_ICON_ORDER.indexOf(id);
  if (atlas && i >= 0 && Math.floor(i / TECH_ATLAS_COLS) < atlasRows) {
    const col = i % TECH_ATLAS_COLS, row = Math.floor(i / TECH_ATLAS_COLS);
    return `<span class="${cls} ti-art" style="background-image:url(${atlas.src});background-size:${TECH_ATLAS_COLS * 100}% ${atlasRows * 100}%;background-position:${(col / (TECH_ATLAS_COLS - 1)) * 100}% ${atlasRows > 1 ? (row / (atlasRows - 1)) * 100 : 0}%"></span>`;
  }
  return glyph(BY_TECH[id] ?? 'book', cls);
}

export function factionIcon(faction: string, cls = 'tg'): string {
  const i = FACTION_ORDER.indexOf(faction);
  const n = emblems ? Math.floor(emblems.naturalWidth / FACTION_ATLAS_CELL) : 0;
  if (emblems && i >= 0 && i < n) {
    return `<span class="${cls} ti-art" style="background-image:url(${emblems.src});background-size:${n * 100}% 100%;background-position:${n > 1 ? (i / (n - 1)) * 100 : 0}% 0"></span>`;
  }
  return glyph(FACTION_GLYPH[faction] ?? 'banner', cls);
}
