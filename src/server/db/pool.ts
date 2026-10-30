import pg from 'pg';

// BIGINT (telegram_id, id) приходит строкой — приводим к числу: значения Telegram ID < 2^53.
pg.types.setTypeParser(20, v => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
}

/** Транзакция с автоматическим ROLLBACK при исключении. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
