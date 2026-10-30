-- Этап 4: режим партии (условия победы, цели влияния, очки), дипломатия, метки, замещение ботами.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS mode JSONB;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS result JSONB;

ALTER TABLE diplomacy ADD COLUMN IF NOT EXISTS pending JSONB;
ALTER TABLE diplomacy ADD COLUMN IF NOT EXISTS proposal JSONB;

ALTER TABLE players ADD COLUMN IF NOT EXISTS missed_turns INT NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS replaced_by_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS markers (
  id          BIGSERIAL PRIMARY KEY,
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,
  x           INT NOT NULL,
  y           INT NOT NULL,
  label       TEXT NOT NULL,
  shared      BOOLEAN NOT NULL DEFAULT TRUE,
  created_turn INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS markers_match_idx ON markers (match_id);
