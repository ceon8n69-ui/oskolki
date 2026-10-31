-- Лавка за Telegram Stars: только косметика, на баланс не влияет.
CREATE TABLE IF NOT EXISTS purchases (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id),
  item               TEXT NOT NULL,
  stars              INT NOT NULL,
  charge_id          TEXT NOT NULL UNIQUE,          -- telegram_payment_charge_id: повторное уведомление не выдаёт товар дважды
  payload            TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_items (
  user_id     BIGINT NOT NULL REFERENCES users(id),
  item        TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_color TEXT;
