import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { loadEnvFile, getDb } from './sqlitePlugin.js';
import {
  getMigrationStatus,
  runMigrations,
  rollbackMigration,
} from './migrations.js';

loadEnvFile();

const DB_PATH = path.resolve(
  process.cwd(),
  process.env.DB_PATH || 'cloudexam.sqlite'
);

const command = (process.argv[2] || 'status').toLowerCase();
const arg = process.argv[3];

function printStatus(status) {
  console.log(`\nSQLite Database: ${DB_PATH}`);
  console.log(
    `Schema Version : v${status.currentVersion} (latest: v${status.latestVersion})\n`
  );
  console.log('Migrations:');
  for (const m of status.migrations) {
    const badge = m.applied ? '[APPLIED]' : '[PENDING]';
    const time = m.appliedAt ? ` (${m.appliedAt})` : '';
    console.log(`  ${badge} v${m.version} - ${m.name}${time}`);
  }
  console.log('');
}

const db = new DatabaseSync(DB_PATH);

if (command === 'status') {
  printStatus(getMigrationStatus(db));
} else if (command === 'up' || command === 'migrate') {
  const target = arg ? Number(arg) : null;
  const res = runMigrations(db, target);
  if (res.applied.length === 0) {
    console.log('No pending migrations to apply.');
  } else {
    for (const m of res.applied) {
      console.log(`Applied migration v${m.version}: ${m.name}`);
    }
  }
  // Also run initial seed via getDb() if we are at >= v1
  if (res.currentVersion >= 1) {
    getDb();
  }
  printStatus(res);
} else if (command === 'down' || command === 'rollback') {
  const steps = arg ? Number(arg) : 1;
  const res = rollbackMigration(db, steps);
  for (const m of res.rolledBack) {
    console.log(`Rolled back migration v${m.version}: ${m.name}`);
  }
  printStatus(res);
} else {
  console.log('Usage:');
  console.log('  npm run migrate          # Apply all pending migrations (up)');
  console.log('  npm run migrate:status   # Check current schema version');
  console.log('  npm run migrate:down     # Rollback last migration');
}
