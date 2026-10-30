-- Управление комнатами: удаление комнаты ожидания (мягкое — история не удаляется), сдача, личный архив.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id);
ALTER TABLE players ADD COLUMN IF NOT EXISTS surrendered_turn INT;

-- Личный архив: партия скрыта только для этого пользователя; результаты и история остаются.
CREATE TABLE IF NOT EXISTS match_hidden (
  user_id    BIGINT NOT NULL REFERENCES users(id),
  match_id   UUID NOT NULL REFERENCES matches(id),
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, match_id)
);
