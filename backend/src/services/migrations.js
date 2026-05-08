import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { pool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function getMigrationFiles() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async filename => ({
      version: filename.replace(/\.sql$/, ''),
      sql: await readFile(join(MIGRATIONS_DIR, filename), 'utf8'),
    }))
  );
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize concurrent migration runs (e.g. Docker restart with multiple replicas).
    await client.query('SELECT pg_advisory_xact_lock(7418291834)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set(rows.map(r => r.version));

    const migrations = await getMigrationFiles();

    let ran = 0;
    for (const { version, sql } of migrations) {
      if (applied.has(version)) continue;
      console.log(`Migrations: applying ${version}`);
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );
      ran++;
    }

    await client.query('COMMIT');
    if (ran > 0) console.log(`Migrations: ${ran} migration(s) applied`);
    else console.log('Migrations: schema up to date');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
