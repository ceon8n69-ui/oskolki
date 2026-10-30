-- Осколки королевств: начальная схема.
-- Источник истины — нормализованные таблицы (players, units, cities, research, visibility, chunks).
-- turns.snapshot хранит состояние на начало хода для восстановления и воспроизведения расчёта.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT UNIQUE,
  username      TEXT,
  first_name    TEXT,
  chat_id       BIGINT,
  notify        JSONB NOT NULL DEFAULT '{"turn": true, "deadline": true, "attack": true, "end": true}',
  is_dev        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id                 UUID PRIMARY KEY,
  preset             TEXT NOT NULL,
  phase              TEXT NOT NULL CHECK (phase IN ('lobby', 'planning', 'resolving', 'finished')),
  turn               INT NOT NULL DEFAULT 0,
  seed               TEXT NOT NULL,
  generator_version  TEXT,
  balance_version    TEXT NOT NULL,
  rules_version      TEXT NOT NULL,
  map_width          INT NOT NULL,
  map_height         INT NOT NULL,
  chunk_size         INT NOT NULL,
  planning_seconds   INT NOT NULL,
  deadline           TIMESTAMPTZ,
  max_players        INT NOT NULL,
  invite_code        TEXT NOT NULL UNIQUE,
  created_by         BIGINT REFERENCES users(id),
  winner             TEXT,
  gen_report         JSONB,
  next_unit_id       INT NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_due_idx ON matches (phase, deadline);

CREATE TABLE IF NOT EXISTS factions (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL
);
INSERT INTO factions (id, name) VALUES ('union', 'Союз городов') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS players (
  match_id           UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  user_id            BIGINT REFERENCES users(id),
  name               TEXT NOT NULL,
  faction            TEXT NOT NULL REFERENCES factions(id),
  color              TEXT NOT NULL,
  is_bot             BOOLEAN NOT NULL DEFAULT FALSE,
  ready              BOOLEAN NOT NULL DEFAULT FALSE,
  eliminated         BOOLEAN NOT NULL DEFAULT FALSE,
  gold               INT NOT NULL DEFAULT 0,
  knowledge          INT NOT NULL DEFAULT 0,
  research_queue     TEXT[] NOT NULL DEFAULT '{}',
  research_progress  INT NOT NULL DEFAULT 0,
  seat               INT NOT NULL,
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS players_user_idx ON players (match_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chunks (
  match_id  UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  cx        INT NOT NULL,
  cy        INT NOT NULL,
  terrain   BYTEA NOT NULL,
  features  BYTEA NOT NULL,
  PRIMARY KEY (match_id, cx, cy)
);

CREATE TABLE IF NOT EXISTS tiles (
  -- Изменения отдельных клеток поверх сгенерированных чанков (дороги, выжженная земля и т. п.).
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  x          INT NOT NULL,
  y          INT NOT NULL,
  terrain    SMALLINT,
  features   SMALLINT,
  changed_turn INT NOT NULL,
  PRIMARY KEY (match_id, x, y)
);

CREATE TABLE IF NOT EXISTS cities (
  match_id              UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  id                    TEXT NOT NULL,
  name                  TEXT NOT NULL,
  owner                 TEXT,
  x                     INT NOT NULL,
  y                     INT NOT NULL,
  level                 INT NOT NULL,
  is_capital            BOOLEAN NOT NULL DEFAULT FALSE,
  contested_by          TEXT,
  contested_since_turn  INT,
  production_stock      INT NOT NULL DEFAULT 0,
  queue                 JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (match_id, id)
);

CREATE TABLE IF NOT EXISTS buildings (
  -- Этап 3: постройки городов. Таблица заведена заранее, чтобы не ломать схему.
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  city_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  level      INT NOT NULL DEFAULT 1,
  built_turn INT NOT NULL,
  PRIMARY KEY (match_id, city_id, kind)
);

CREATE TABLE IF NOT EXISTS units (
  match_id      UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  owner         TEXT NOT NULL,
  type          TEXT NOT NULL,
  x             INT NOT NULL,
  y             INT NOT NULL,
  hp            INT NOT NULL,
  xp            INT NOT NULL DEFAULT 0,
  rank          INT NOT NULL DEFAULT 0,
  statuses      JSONB NOT NULL DEFAULT '[]',
  created_turn  INT NOT NULL,
  PRIMARY KEY (match_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS units_tile_idx ON units (match_id, x, y);

CREATE TABLE IF NOT EXISTS research (
  match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL,
  tech_id         TEXT NOT NULL,
  completed_turn  INT NOT NULL,
  PRIMARY KEY (match_id, player_id, tech_id)
);

CREATE TABLE IF NOT EXISTS visibility (
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id  TEXT NOT NULL,
  explored   BYTEA NOT NULL,
  intel      JSONB NOT NULL DEFAULT '{"units": {}, "cities": {}}',
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id           UUID PRIMARY KEY,
  match_id     UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  number       INT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('planning', 'resolved')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  snapshot     JSONB NOT NULL,          -- состояние на начало хода (без статичной карты)
  result_hash  TEXT,                    -- хэш состояния после расчёта (проверка воспроизводимости)
  resolve_ms   INT,
  UNIQUE (match_id, number)
);

CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY,
  match_id         UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  turn             INT NOT NULL,
  player_id        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  version          INT NOT NULL,
  payload          JSONB NOT NULL,
  idempotency_key  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'cancelled', 'consumed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, player_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_active_subject_idx ON orders (match_id, turn, player_id, subject) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS orders_turn_idx ON orders (match_id, turn, status);

CREATE TABLE IF NOT EXISTS turn_events (
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  turn        INT NOT NULL,
  seq         INT NOT NULL,
  phase       TEXT NOT NULL,
  visible_to  TEXT[] NOT NULL,
  event       JSONB NOT NULL,
  PRIMARY KEY (match_id, turn, seq)
);
CREATE INDEX IF NOT EXISTS turn_events_visible_idx ON turn_events USING GIN (visible_to);

CREATE TABLE IF NOT EXISTS diplomacy (
  -- Этап 4.
  match_id     UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  a            TEXT NOT NULL,
  b            TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('war', 'truce', 'alliance')),
  since_turn   INT NOT NULL,
  ends_turn    INT,
  PRIMARY KEY (match_id, a, b)
);

CREATE TABLE IF NOT EXISTS operation_log (
  id          BIGSERIAL PRIMARY KEY,
  match_id    UUID,
  actor       TEXT NOT NULL,
  op          TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operation_log_match_idx ON operation_log (match_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id    UUID,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  attempts    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_pending_idx ON notifications (sent_at, created_at) WHERE sent_at IS NULL;
