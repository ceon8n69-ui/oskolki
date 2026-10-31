-- Новые народы, рост: приглашения друзей, сезоны рейтинга.
INSERT INTO factions (id, name) VALUES
  ('steppe', 'Степные ханства'),
  ('north', 'Северные ярлы')
ON CONFLICT DO NOTHING;

-- Приглашение друзей: кто пригласил; награда выдаётся один раз, когда приглашённый доиграл первую партию.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users (referred_by) WHERE referred_by IS NOT NULL;

-- Уведомления, пропущенные намеренно (игрок в игре, частота), не считаются отправленными для ограничения частоты.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT FALSE;

-- Сезоны рейтинга: по календарному месяцу (UTC). При закрытии — места и награды, затем мягкий сброс рейтинга.
CREATE TABLE IF NOT EXISTS seasons (
  id         INT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  closed_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS season_results (
  season_id INT NOT NULL REFERENCES seasons(id),
  user_id   BIGINT NOT NULL REFERENCES users(id),
  place     INT NOT NULL,
  rating    INT NOT NULL,
  games     INT NOT NULL,
  wins      INT NOT NULL,
  rewards   TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (season_id, user_id)
);
