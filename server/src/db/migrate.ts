// Applies SQL migrations from ./drizzle, then inserts any missing default catalog models.
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { pathToFileURL } from 'node:url';
import { db, sql } from './index.js';
import { seedCatalog } from './seed.js';

export async function runMigrations() {
  await migrate(db, { migrationsFolder: 'drizzle' });
  await seedCatalog();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runMigrations()
    .then(() => console.log('migrations applied'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => sql.end());
}
