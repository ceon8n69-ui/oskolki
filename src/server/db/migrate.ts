// Применяет migrations/*.sql по порядку; учёт в schema_migrations.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.ts';
import { createPool } from './pool.ts';

const DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

export async function migrate(db: Db, log: (m: string) => void = console.log): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  // Один мигратор одновременно (несколько инстансов при деплое).
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    const files = (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort();
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(DIR + f, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migration applied: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool(process.env.DATABASE_URL ?? 'postgres://oskolki:oskolki@localhost:5432/oskolki');
  await migrate(db);
  await db.end();
}
