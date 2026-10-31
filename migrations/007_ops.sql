-- Эксплуатация: получатели оповещений администратору и признак корректной остановки сервера.
CREATE TABLE IF NOT EXISTS alert_subscribers (
  chat_id     BIGINT PRIMARY KEY,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS server_state (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  clean_shutdown BOOLEAN NOT NULL DEFAULT TRUE,
  started_at     TIMESTAMPTZ,
  deployment     TEXT
);
INSERT INTO server_state (id) VALUES (1) ON CONFLICT DO NOTHING;
