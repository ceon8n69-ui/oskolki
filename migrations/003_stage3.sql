-- Этап 3: народы, материалы, командиры, прокачка, снабжение, постройки, рост городов.
ALTER TABLE units ADD COLUMN IF NOT EXISTS max_hp INT;
ALTER TABLE units ADD COLUMN IF NOT EXISTS perks TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE units ADD COLUMN IF NOT EXISTS pending_perks INT NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN IF NOT EXISTS supply_out INT NOT NULL DEFAULT 0;
UPDATE units SET max_hp = hp WHERE max_hp IS NULL;

ALTER TABLE cities ADD COLUMN IF NOT EXISTS buildings TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE cities ADD COLUMN IF NOT EXISTS food INT NOT NULL DEFAULT 0;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS specialization TEXT;

ALTER TABLE players ADD COLUMN IF NOT EXISTS materials JSONB NOT NULL DEFAULT '{"wood": 0, "iron": 0, "crystal": 0}';
ALTER TABLE players ADD COLUMN IF NOT EXISTS commander JSONB;

INSERT INTO factions (id, name) VALUES
  ('forest', 'Лесные хранители'), ('mountain', 'Горные кланы'), ('tide', 'Народ Приливов')
ON CONFLICT DO NOTHING;

-- Постройки городов хранятся в cities.buildings; таблица buildings из 001 остаётся журналом завершения.
