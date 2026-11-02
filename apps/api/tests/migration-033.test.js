// Migration 033 on data as it was before it: apps that were switched on keep the shared schedule's frequency, hour and weekday; apps that were not are off.
// Runs in a scratch database (created and dropped here), applying the migrations one by one up to 032, then 033 on its own.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgConfig } from '../src/db/pool.js';
import { testPool, closeDb } from './helpers.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const NAME = 'shipdok_mig033_test';
let scratch;

async function migrateTo(client, upTo) {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const f of (await readdir(DIR)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort()) {
    if (f > upTo) break;
    await client.query(await readFile(join(DIR, f), 'utf8'));
  }
}
const addApp = async (n, enabled, keep = null) => (await scratch.query(
  `INSERT INTO apps (name, slug, repo, container_port, host_port, volume_backup_enabled ${keep ? ', volume_backup_keep' : ''}) VALUES ($1, $1, 'o/r', 3000, $2, $3 ${keep ? ', $4' : ''}) RETURNING id`,
  [`app-${n}`, 21000 + n, enabled, ...(keep ? [keep] : [])])).rows[0].id;
const rowOf = async (id) => (await scratch.query('SELECT volume_backup_frequency AS f, volume_backup_hour AS h, volume_backup_weekday AS w, volume_backup_keep AS k FROM apps WHERE id = $1', [id])).rows[0];
const apply033 = async () => scratch.query(await readFile(join(DIR, '033_volume_backup_schedule.sql'), 'utf8'));

beforeEach(async () => {
  await testPool.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await testPool.query(`CREATE DATABASE ${NAME}`);
  scratch = new pg.Client({ ...pgConfig(), database: NAME });
  await scratch.connect();
  await migrateTo(scratch, '032_volume_restores.sql');
});
afterEach(async () => { await scratch.end(); await testPool.query(`DROP DATABASE IF EXISTS ${NAME}`); });
afterAll(closeDb);

describe('migration 033', () => {
  test('an app that was switched on keeps the shared schedule (weekly, Wednesday 14:00); one that was not is off, with the same hour and day ready', async () => {
    await scratch.query(`INSERT INTO settings (key, value) VALUES ('backup_schedule', '{"frequency":"weekly","hour":14,"weekday":3,"keep":7}')`);
    const on = await addApp(1, true); const off = await addApp(2, false);
    await apply033();
    expect(await rowOf(on)).toMatchObject({ f: 'weekly', h: 14, w: 3 });
    expect(await rowOf(off)).toMatchObject({ f: 'off', h: 14, w: 3 });
  });
  test('with no shared schedule saved, an app that was on is daily at 03:00 UTC (the default it was using)', async () => {
    const on = await addApp(1, true);
    await apply033();
    expect(await rowOf(on)).toMatchObject({ f: 'daily', h: 3, w: 1 });
  });
  test('an app that was on while the shared schedule was off stays off (nothing was being made)', async () => {
    await scratch.query(`INSERT INTO settings (key, value) VALUES ('backup_schedule', '{"frequency":"off","hour":5,"weekday":2,"keep":7}')`);
    const on = await addApp(1, true);
    await apply033();
    expect(await rowOf(on)).toMatchObject({ f: 'off', h: 5, w: 2 });
  });
  test('nonsense in the saved schedule falls back to the defaults instead of failing', async () => {
    await scratch.query(`INSERT INTO settings (key, value) VALUES ('backup_schedule', '{"frequency":"hourly","hour":99,"weekday":"x"}')`);
    const on = await addApp(1, true);
    await apply033();
    expect(await rowOf(on)).toMatchObject({ f: 'daily', h: 3, w: 1 });
  });
  test('the number to keep: an app that saved one keeps it, and the default for new apps is now 2', async () => {
    const saved = await addApp(1, false, 5);
    await apply033();
    expect((await rowOf(saved)).k).toBe(5);
    const fresh = (await scratch.query(`INSERT INTO apps (name, slug, repo, container_port, host_port) VALUES ('fresh', 'fresh', 'o/r', 3000, 21999) RETURNING id`)).rows[0].id;
    expect(await rowOf(fresh)).toMatchObject({ k: 2, f: 'off', h: 3, w: 1 });
  });
  test('the old switch is gone, and the new columns refuse bad values', async () => {
    await apply033();
    await expect(scratch.query('SELECT volume_backup_enabled FROM apps')).rejects.toThrow(/does not exist/);
    const id = (await scratch.query(`INSERT INTO apps (name, slug, repo, container_port, host_port) VALUES ('x', 'x', 'o/r', 3000, 21998) RETURNING id`)).rows[0].id;
    for (const [col, v] of [['volume_backup_frequency', "'hourly'"], ['volume_backup_hour', '24'], ['volume_backup_weekday', '7']]) {
      await expect(scratch.query(`UPDATE apps SET ${col} = ${v} WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    }
  });
});
