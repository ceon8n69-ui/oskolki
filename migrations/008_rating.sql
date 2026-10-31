-- Рейтинг и итоги партий. Итог записывается один раз на пользователя и партию (повторный расчёт не меняет рейтинг).
CREATE TABLE IF NOT EXISTS ratings (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id),
  rating      INT NOT NULL DEFAULT 1000,
  games       INT NOT NULL DEFAULT 0,
  wins        INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ratings_top_idx ON ratings (rating DESC);

CREATE TABLE IF NOT EXISTS match_results (
  match_id       UUID NOT NULL REFERENCES matches(id),
  user_id        BIGINT NOT NULL REFERENCES users(id),
  player_id      TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'draw')),
  surrendered    BOOLEAN NOT NULL DEFAULT FALSE,
  rated          BOOLEAN NOT NULL,
  rating_before  INT NOT NULL,
  rating_after   INT NOT NULL,
  finished_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS match_results_user_idx ON match_results (user_id, finished_at DESC);
