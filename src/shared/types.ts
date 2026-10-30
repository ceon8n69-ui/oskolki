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
  Village: 1 << 7,
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

export type OrderMode = 'move' | 'attack' | 'hold';

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
}

export interface ProductionItem {
  kind: 'unit';
  unitType: string;
  progress: number;
  paid: boolean; // золото списано один раз при постановке
  orderId: string;
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

export type Order = UnitOrder | RecruitOrder | ResearchOrder;

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
  | { t: 'player_eliminated'; playerId: PlayerId };

/** Событие с видимостью: список игроков, которым его можно показать. */
export interface StoredEvent {
  seq: number;
  phase: string;
  visibleTo: PlayerId[];
  event: TurnEvent;
}
