-- Этап 5: состояние мира (обелиски, разграбленные руины, мировые события) и перевозка отрядов на транспорте.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS world JSONB;
ALTER TABLE units ADD COLUMN IF NOT EXISTS carried_by TEXT;
-- Груз стоит на клетке транспорта: уникальность клетки — только для отрядов на карте.
DROP INDEX IF EXISTS units_tile_idx;
CREATE UNIQUE INDEX IF NOT EXISTS units_tile_on_map_idx ON units (match_id, x, y) WHERE carried_by IS NULL;

INSERT INTO factions (id, name) VALUES
  ('ash', 'Пепельные орды'),
  ('ruins', 'Хранители руин')
ON CONFLICT DO NOTHING;
