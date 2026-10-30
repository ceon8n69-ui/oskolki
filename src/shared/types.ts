// Общие типы игрового состояния и протокола.
// Этот модуль не импортирует ничего, кроме других модулей src/shared.

export type PlayerId = string;
export type UnitId = string;
export type CityId = string;

export interface Coord {
  x: number;
  y: number;
}

// Типы местности. Числовые коды хранятся в чанках (bytea), поэтому их нельзя переставлять.
export const Terrain = {
  DeepWater: 0,
  ShallowWater: 1,
  Plains: 2,
  Forest: 3,
  Hills: 4,
  Mountain: 5,
} as const;
export type TerrainCode = (typeof Terrain)[keyof typeof Terrain];
export const TERRAIN_NAMES: Record<TerrainCode, string> = {
  0: 'deep_water',
  1: 'shallow_water',
  2: 'plains',
  3: 'forest',
  4: 'hills',
  5: 'mountain',
};

// Особенности клетки (битовая маска, хранится рядом с местностью).
export const Feature = {
  None: 0,
  Road: 1 << 0,
  Bridge: 1 << 1,
  Ruins: 1 << 2,
  Shrine: 1 << 3,
  ResourceWood: 1 << 4,
  ResourceIron: 1 << 5,
  ResourceCrystal: 1 << 6,
  Fort: 1 << 7,
} as const;

export interface MapData {
  width: number;
  height: number;
  chunkSize: number;
  seed: string;
  generatorVersion: string;
  terrain: Uint8Array; // width*height
  features: Uint8Array; // width*height, маска Feature
}

export type OrderMode = 'move' | 'attack' | 'hold' | 'build';

/** Долгий маршрут: продолжается в следующих ходах без новых приказов. */
export interface UnitRoute {
  path: Coord[]; // оставшиеся шаги
  stopOnThreat: boolean;
  orderedTurn: number;
}

export interface UnitState {
  id: UnitId;
  owner: PlayerId;
  type: string;
  x: number;
  y: number;
  hp: number;
  xp: number;
  rank: number; // 0 новобранец, 1 ветеран, 2 элита
  statuses: StatusEffect[];
  countersUsed: number;
  createdTurn: number;
  route?: UnitRoute | null;
  maxHp: number; // с учётом народа и ранга
  perks: string[]; // улучшения, выбранные при повышении ранга
  pendingPerks: number; // сколько улучшений ждут выбора
  supplyOut: number; // ходов подряд вне зоны снабжения
}

export interface StatusEffect {
  id: string; // fortified, contested_hold, ...
  source: string;
  expiresTurn: number | null; // null — до снятия
}

export interface CityState {
  id: CityId;
  name: string;
  owner: PlayerId | null; // null — нейтральный
  x: number; // точка захвата (городской центр)
  y: number;
  level: number;
  isCapital: boolean;
  contestedBy: PlayerId | null;
  contestedSinceTurn: number | null;
  productionStock: number;
  queue: ProductionItem[];
  buildings: string[];
  food: number;
  specialization: string | null;
}

export interface ProductionItem {
  kind: 'unit' | 'building';
  unitType: string; // для building — идентификатор постройки
  progress: number;
  paid: boolean; // золото и материалы списаны один раз при постановке
  orderId: string;
}

export interface MaterialStock {
  wood: number;
  iron: number;
  crystal: number;
}

export interface CommanderState {
  unitId: UnitId | null;
  points: number;
  cooldowns: Record<string, number>; // способность → ход, с которого доступна
  directions: Record<string, number>; // направление → уровень
  pendingChoices: number;
  respawnTurn: number | null;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  faction: string;
  color: string;
  gold: number;
  knowledge: number;
  researched: string[];
  researchQueue: string[];
  researchProgress: number;
  isBot: boolean;
  eliminated: boolean;
  materials: MaterialStock;
  commander: CommanderState;
}

export interface GameState {
  matchId: string;
  turn: number;
  balanceVersion: string;
  rulesVersion: string;
  map: MapData;
  players: PlayerState[];
  units: UnitState[];
  cities: CityState[];
  explored: Record<PlayerId, Uint8Array>; // байт-на-клетку: 1 = исследована
  intel: Record<PlayerId, PlayerIntel>; // последние известные сведения о чужих объектах
  nextIds: { unit: number };
  diplomacy: Treaty[]; // пары, отличные от состояния по умолчанию, или с предложениями
  mode: MatchMode;
}

export type TreatyStatus = 'war' | 'truce' | 'alliance';

/** Отношения пары игроков (a < b). */
export interface Treaty {
  a: PlayerId;
  b: PlayerId;
  status: TreatyStatus;
  since: number;
  /** Объявленный разрыв или изменение, вступающее в силу с указанного хода. */
  pending: { status: TreatyStatus; effectiveTurn: number; by: PlayerId } | null;
  /** Предложение одной стороны, ждущее ответа. */
  proposal: { from: PlayerId; status: TreatyStatus; turn: number } | null;
}

export interface Objective {
  id: string;
  kind: 'shrine' | 'city';
  x: number;
  y: number;
  cityId: string | null;
  points: number;
  holder: PlayerId | null;
}

/** Режим партии: условия победы выбираются до старта и не меняются. */
export interface MatchMode {
  victory: 'influence' | 'capitals' | 'elimination';
  turnLimit: number | null;
  alliances: boolean;
  objectives: Objective[];
  scores: Record<PlayerId, number>;
  finished: { winners: PlayerId[]; reason: string; turn: number } | null;
}

export const NEUTRAL: PlayerId = 'neutral';

export interface SeenUnit {
  id: UnitId;
  owner: PlayerId;
  type: string;
  x: number;
  y: number;
  hp: number;
  seenTurn: number;
}

export interface SeenCity {
  owner: PlayerId | null;
  level: number;
  contestedBy: PlayerId | null;
  seenTurn: number;
}

export interface PlayerIntel {
  units: Record<UnitId, SeenUnit>;
  cities: Record<CityId, SeenCity>;
}

// ---------- Приказы ----------

export interface UnitOrder {
  kind: 'unit';
  unitId: UnitId;
  mode: OrderMode;
  path: Coord[]; // шаги без стартовой клетки; для hold пусто
  targetUnitId?: UnitId; // для attack
  targetTile?: Coord; // для attack — клетка, по которой отдан приказ (для журнала)
  /** move: путь может быть длиннее бюджета хода — остаток продолжается в следующих ходах. */
  longRoute?: boolean;
  /** Для долгого маршрута: остановиться, если рядом замечен противник (по умолчанию true). */
  stopOnThreat?: boolean;
  /** build: что строить на текущей клетке. */
  build?: BuildKind;
  /** attack: особый приём (например, отталкивание щитом). */
  ability?: 'knockback';
}

export type BuildKind = 'road' | 'fort' | 'forest';

/** Постройка в городе. */
export interface ConstructOrder {
  kind: 'construct';
  cityId: CityId;
  building: string;
}

export interface SpecializeOrder {
  kind: 'specialize';
  cityId: CityId;
  specialization: string;
}

/** Выбор улучшения при повышении ранга. */
export interface PromoteOrder {
  kind: 'promote';
  unitId: UnitId;
  perk: string;
}

export interface CommanderOrder {
  kind: 'commander';
  action: 'ability' | 'direction';
  ability?: string;
  target?: Coord;
  direction?: string;
}

export interface RecruitOrder {
  kind: 'recruit';
  cityId: CityId;
  unitType: string;
}

export interface ResearchOrder {
  kind: 'research';
  queue: string[]; // полная желаемая очередь
}

/** Дипломатия: предложить / принять / отклонить договор или объявить разрыв. */
export interface DiplomacyOrder {
  kind: 'diplomacy';
  action: 'propose' | 'accept' | 'decline' | 'break';
  target: PlayerId;
  status?: TreatyStatus; // для propose
}

export type Order = UnitOrder | RecruitOrder | ResearchOrder | ConstructOrder | SpecializeOrder | PromoteOrder | CommanderOrder | DiplomacyOrder;

export interface SubmittedOrder {
  id: string;
  playerId: PlayerId;
  order: Order;
}

/** Ключ «предмета» приказа: на один предмет у игрока активен один приказ. */
export function orderSubjectKey(o: Order): string {
  switch (o.kind) {
    case 'unit':
      return `unit:${o.unitId}`;
    case 'recruit':
      return `recruit:${o.cityId}`;
    case 'research':
      return 'research';
    case 'construct':
      return `construct:${o.cityId}`;
    case 'specialize':
      return `specialize:${o.cityId}`;
    case 'promote':
      return `promote:${o.unitId}`;
    case 'commander':
      return o.action === 'ability' ? 'commander:ability' : 'commander:direction';
    case 'diplomacy':
      return `diplomacy:${o.target}`;
  }
}

// ---------- События хода ----------

export type TurnEvent =
  | { t: 'order_rejected'; playerId: PlayerId; orderId: string; reason: string }
  | { t: 'fortify'; unitId: UnitId; at: Coord }
  | { t: 'move'; unitId: UnitId; owner: PlayerId; from: Coord; to: Coord; tick: number }
  | { t: 'move_blocked'; unitId: UnitId; owner: PlayerId; at: Coord; wanted: Coord; tick: number; reason: string }
  | { t: 'attack'; attackerId: UnitId; targetId: UnitId; from: Coord; to: Coord; damage: number; tier: number; kind: 'primary' | 'counter' | 'exchange'; attackerType: string; targetType: string }
  | { t: 'attack_failed'; attackerId: UnitId; owner: PlayerId; reason: string; at: Coord }
  | { t: 'unit_destroyed'; unitId: UnitId; owner: PlayerId; at: Coord; unitType: string }
  | { t: 'xp'; unitId: UnitId; amount: number; rankUp: boolean }
  | { t: 'city_contested'; cityId: CityId; by: PlayerId; owner: PlayerId | null; at: Coord }
  | { t: 'city_contest_cleared'; cityId: CityId; at: Coord }
  | { t: 'city_captured'; cityId: CityId; from: PlayerId | null; to: PlayerId; at: Coord }
  | { t: 'unit_recruited'; unitId: UnitId; owner: PlayerId; cityId: CityId; at: Coord; unitType: string }
  | { t: 'production_queued'; cityId: CityId; owner: PlayerId; unitType: string; goldSpent: number }
  | { t: 'production_blocked'; cityId: CityId; owner: PlayerId; reason: string }
  | { t: 'research_completed'; playerId: PlayerId; techId: string }
  | { t: 'income'; playerId: PlayerId; gold: number; upkeep: number; knowledge: number; deficit: boolean }
  | { t: 'player_eliminated'; playerId: PlayerId }
  | { t: 'route_continued'; unitId: UnitId; owner: PlayerId; remaining: number }
  | { t: 'route_paused'; unitId: UnitId; owner: PlayerId; at: Coord; reason: 'threat' | 'blocked' | 'invalid' }
  | { t: 'route_completed'; unitId: UnitId; owner: PlayerId; at: Coord }
  | { t: 'build_started'; unitId: UnitId; owner: PlayerId; at: Coord; build: BuildKind; goldSpent: number }
  | { t: 'road_built'; at: Coord; by: PlayerId }
  | { t: 'build_failed'; unitId: UnitId; owner: PlayerId; at: Coord; reason: string }
  | { t: 'fort_built'; at: Coord; by: PlayerId }
  | { t: 'forest_planted'; at: Coord; by: PlayerId }
  | { t: 'zoc_stop'; unitId: UnitId; owner: PlayerId; at: Coord; tick: number }
  | { t: 'suppressed'; unitId: UnitId; owner: PlayerId; at: Coord }
  | { t: 'knockback'; unitId: UnitId; owner: PlayerId; from: Coord; to: Coord }
  | { t: 'promotion_available'; unitId: UnitId; owner: PlayerId }
  | { t: 'perk_chosen'; unitId: UnitId; owner: PlayerId; perk: string }
  | { t: 'building_completed'; cityId: CityId; owner: PlayerId; building: string; at: Coord }
  | { t: 'construction_queued'; cityId: CityId; owner: PlayerId; building: string }
  | { t: 'city_grew'; cityId: CityId; owner: PlayerId; level: number; at: Coord }
  | { t: 'city_specialized'; cityId: CityId; owner: PlayerId; specialization: string; at: Coord }
  | { t: 'materials'; playerId: PlayerId; wood: number; iron: number; crystal: number }
  | { t: 'supply_warning'; unitId: UnitId; owner: PlayerId; at: Coord; level: 'low' | 'none' }
  | { t: 'supply_restored'; unitId: UnitId; owner: PlayerId; at: Coord }
  | { t: 'healed'; unitId: UnitId; owner: PlayerId; amount: number }
  | { t: 'commander_ability'; playerId: PlayerId; ability: string; at: Coord; target?: Coord; affected: UnitId[] }
  | { t: 'commander_direction'; playerId: PlayerId; direction: string; level: number }
  | { t: 'commander_fallen'; playerId: PlayerId; at: Coord; respawnTurn: number }
  | { t: 'commander_respawned'; playerId: PlayerId; unitId: UnitId; at: Coord }
  | { t: 'diplomacy_proposed'; from: PlayerId; to: PlayerId; status: TreatyStatus }
  | { t: 'diplomacy_declined'; from: PlayerId; to: PlayerId; status: TreatyStatus }
  | { t: 'diplomacy_break_announced'; from: PlayerId; to: PlayerId; status: TreatyStatus; effectiveTurn: number }
  | { t: 'diplomacy_changed'; a: PlayerId; b: PlayerId; status: TreatyStatus; previous: TreatyStatus }
  | { t: 'objective_held'; objectiveId: string; holder: PlayerId | null; previous: PlayerId | null; at: Coord }
  | { t: 'influence'; playerId: PlayerId; gained: number; total: number }
  | { t: 'match_finished'; winners: PlayerId[]; reason: string };

/** Событие с видимостью: список игроков, которым его можно показать. */
export interface StoredEvent {
  seq: number;
  phase: string;
  visibleTo: PlayerId[];
  event: TurnEvent;
}
