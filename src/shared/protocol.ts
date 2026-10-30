// Протокол клиент ↔ сервер. Клиентский рендерер работает только с этими типами.
import type { CityId, MatchMode, Order, PlayerId, PlayerState, ProductionItem, StatusEffect, StoredEvent, Treaty, UnitId, UnitRoute } from './types.ts';

export const PROTOCOL_VERSION = 1;

export interface ViewUnit {
  id: UnitId;
  owner: PlayerId;
  type: string;
  x: number;
  y: number;
  hp: number;
  rank: number;
  statuses: StatusEffect[];
  maxHp: number;
  xp?: number; // только свои
  route?: UnitRoute | null; // только свои: долгий маршрут
  perks?: string[]; // только свои
  pendingPerks?: number; // только свои: ждёт выбора улучшения
  supplyOut?: number; // только свои
  carriedBy?: UnitId; // только свои: отряд на борту транспорта (координаты = транспорт)
  cargo?: number; // транспорт: число отрядов на борту (видно всем, кто видит транспорт)
  stale: false;
}

export interface ViewStructure {
  id: string;
  kind: 'obelisk';
  owner: PlayerId;
  x: number;
  y: number;
  linked: boolean | null; // свои — подключён ли к сети; чужие — null (неизвестно)
}

export interface ViewWorldEvent {
  id: string;
  name: string;
  description: string;
  startTurn: number;
  endTurn: number;
}

export interface StaleUnit {
  id: UnitId;
  owner: PlayerId;
  type: string;
  x: number;
  y: number;
  hp: number;
  seenTurn: number;
  stale: true; // последнее известное положение, устарело
}

export interface ViewCity {
  id: CityId;
  name: string;
  x: number;
  y: number;
  owner: PlayerId | null;
  level: number;
  isCapital: boolean;
  contestedBy: PlayerId | null;
  contestedSinceTurn: number | null;
  queue: ProductionItem[];
  visibleNow: boolean;
  seenTurn: number | null;
  buildings: string[]; // свои — все; чужие — только видимые снаружи (стены)
  food: number | null; // только свои
  specialization: string | null;
}

export interface PublicPlayer {
  id: PlayerId;
  name: string;
  faction: string;
  color: string;
  eliminated: boolean;
  isBot: boolean;
}

export interface PlayerView {
  matchId: string;
  turn: number;
  balanceVersion: string;
  rulesVersion: string;
  map: { width: number; height: number; chunkSize: number };
  me: PlayerState;
  income: {
    gold: number; upkeep: number; knowledge: number; production: Record<string, number>;
    materials: { wood: number; iron: number; crystal: number };
    cities: Record<string, { gold: number; production: number; knowledge: number; food: number; wood: number; iron: number; crystal: number }>;
  };
  players: PublicPlayer[];
  units: ViewUnit[];
  staleUnits: StaleUnit[];
  cities: ViewCity[];
  diplomacy: Treaty[];
  mode: MatchMode;
  structures: ViewStructure[];
  worldEvents: ViewWorldEvent[];
  /** Индексы клеток с разграбленными руинами среди исследованных игроком. */
  lootedRuins: number[];
}

export interface ChunkView {
  cx: number;
  cy: number;
  size: number;
  terrain: number[]; // 255 — неизвестно
  features: number[];
  visible: number[]; // 1 — видно сейчас
  supply: number[]; // 1 — своя зона снабжения (слой логистики)
}

export type MatchPhase = 'lobby' | 'planning' | 'resolving' | 'finished';

export interface MatchInfo {
  id: string;
  preset: string;
  phase: MatchPhase;
  turn: number;
  deadline: string | null; // ISO
  maxPlayers: number;
  players: { id: PlayerId; name: string; ready: boolean; isBot: boolean; faction: string; color: string; replacedByBot?: boolean }[];
  winner: PlayerId | null;
  winners?: PlayerId[];
  inviteCode: string;
  victory?: string;
  turnLimit?: number | null;
  alliances?: boolean;
}

/** Ответ GET /api/matches/:id/state — всё, что нужно клиенту для отрисовки хода. */
export interface StateResponse {
  match: MatchInfo;
  view: PlayerView;
  orders: OrderRecord[];
  reserved: Reserved;
}

export interface OrderRecord {
  id: string;
  subject: string;
  version: number;
  order: Order;
}

export interface SubmitOrderRequest {
  turn: number;
  order: Order;
  idempotencyKey: string;
  /** Версия, от которой клиент делает изменение (оптимистическая блокировка). */
  baseVersion?: number;
}

export interface SubmitOrderResponse {
  ok: boolean;
  order?: OrderRecord;
  reason?: string;
  reserved?: Reserved;
}

export interface Reserved {
  gold: number;
  wood: number;
  iron: number;
  crystal: number;
}

export interface TurnEventsResponse {
  turn: number;
  events: StoredEvent[];
}

export interface AttackPreview {
  ok: boolean;
  reason?: string;
  damage?: number;
  counter?: number;
  counterPossible?: boolean;
  modifiers?: { id: string; value: number; side: 'attack' | 'defense' }[];
  warning: string; // одновременные приказы могут изменить результат
}

// ---------- WebSocket ----------
export type ServerMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'match'; match: MatchInfo }
  | { type: 'turn_resolved'; matchId: string; turn: number } // клиент запрашивает /state и /events
  | { type: 'ready_changed'; matchId: string; playerId: PlayerId; ready: boolean }
  | { type: 'error'; message: string };

export type ClientMessage = { type: 'subscribe'; matchId: string } | { type: 'ping' };
