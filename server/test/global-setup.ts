// Recreates the test database schema from the committed migrations before the run.
import postgres from 'postgres';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/opstrellis_test';
  const admin = postgres(url.replace(/\/[^/]+$/, '/postgres'), { max: 1, onnotice: () => {} });
  const name = new URL(url).pathname.slice(1);
  const [exists] = await admin`select 1 from pg_database where datname = ${name}`;
  if (!exists) await admin.unsafe(`create database "${name}"`);
  await admin.end();

  const db = postgres(url, { max: 1, onnotice: () => {} });
  await db.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await db.end();

  process.env.DATABASE_URL = url;
  const { runMigrations } = await import('../src/db/migrate.js');
  const { sql } = await import('../src/db/index.js');
  await runMigrations();
  await sql.end();
}
