import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS = [
  {
    version: 1,
    name: 'v1_initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS admins (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        exam_name TEXT NOT NULL,
        course_name TEXT,
        slug TEXT,
        total_questions INTEGER NOT NULL DEFAULT 65,
        orig_correct_count INTEGER DEFAULT 0,
        orig_incorrect_count INTEGER DEFAULT 0,
        orig_skipped_count INTEGER DEFAULT 0,
        orig_flagged_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id TEXT NOT NULL,
        question_id INTEGER NOT NULL,
        attempt_answer_id INTEGER,
        pos INTEGER NOT NULL DEFAULT 0,
        question_text TEXT NOT NULL,
        explanation TEXT,
        answers_json TEXT NOT NULL DEFAULT '[]',
        correct_answer_json TEXT NOT NULL DEFAULT '[]',
        orig_selected_answers_json TEXT DEFAULT '[]',
        orig_is_correct INTEGER DEFAULT 0,
        orig_is_flagged INTEGER DEFAULT 0,
        answers_pos TEXT,
        UNIQUE(exam_id, question_id)
      );

      CREATE INDEX IF NOT EXISTS idx_questions_exam_id ON questions(exam_id, pos);

      CREATE TABLE IF NOT EXISTS exam_progress (
        exam_id TEXT PRIMARY KEY,
        answers_json TEXT NOT NULL DEFAULT '{}',
        revealed_json TEXT NOT NULL DEFAULT '{}',
        flagged_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exam_attempts (
        id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        label TEXT,
        is_original_json INTEGER NOT NULL DEFAULT 0,
        submitted_at TEXT,
        mode TEXT NOT NULL DEFAULT 'exam',
        duration_seconds INTEGER,
        total INTEGER NOT NULL DEFAULT 65,
        answered INTEGER NOT NULL DEFAULT 0,
        unanswered INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0,
        incorrect INTEGER NOT NULL DEFAULT 0,
        flagged_count INTEGER NOT NULL DEFAULT 0,
        pct INTEGER NOT NULL DEFAULT 0,
        scaled_score INTEGER NOT NULL DEFAULT 100,
        passed INTEGER NOT NULL DEFAULT 0,
        answers_json TEXT NOT NULL DEFAULT '{}',
        flagged_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_exam_id ON exam_attempts(exam_id);
    `,
    down: `
      DROP TABLE IF EXISTS exam_attempts;
      DROP TABLE IF EXISTS exam_progress;
      DROP TABLE IF EXISTS questions;
      DROP TABLE IF EXISTS exams;
      DROP TABLE IF EXISTS admins;
    `,
  },
];

export function ensureMigrationsTable(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function getMigrationStatus(db) {
  ensureMigrationsTable(db);
  const appliedRows = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all();
  const appliedMap = new Map(appliedRows.map((r) => [r.version, r]));

  const currentVersion =
    appliedRows.length > 0 ? appliedRows[appliedRows.length - 1].version : 0;

  const list = MIGRATIONS.map((m) => ({
    version: m.version,
    name: m.name,
    applied: appliedMap.has(m.version),
    appliedAt: appliedMap.get(m.version)?.applied_at || null,
  }));

  return {
    currentVersion,
    latestVersion: MIGRATIONS[MIGRATIONS.length - 1]?.version || 0,
    migrations: list,
  };
}

export function runMigrations(db, targetVersion = null) {
  ensureMigrationsTable(db);
  const status = getMigrationStatus(db);
  const appliedVersions = new Set(
    status.migrations.filter((m) => m.applied).map((m) => m.version)
  );

  const appliedNow = [];
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    if (targetVersion !== null && m.version > targetVersion) break;
    if (appliedVersions.has(m.version)) continue;

    db.exec('BEGIN');
    try {
      if (typeof m.up === 'function') {
        m.up(db);
      } else {
        db.exec(m.up);
      }
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(m.version, m.name, new Date().toISOString());
      db.exec(`PRAGMA user_version = ${m.version};`);
      db.exec('COMMIT');
      appliedNow.push({ version: m.version, name: m.name });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v${m.version} (${m.name}) failed: ${err.message}`);
    }
  }

  return {
    applied: appliedNow,
    ...getMigrationStatus(db),
  };
}

export function rollbackMigration(db, steps = 1) {
  ensureMigrationsTable(db);
  const appliedRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC')
    .all();

  const rolledBack = [];
  const toRollback = appliedRows.slice(0, steps);

  for (const row of toRollback) {
    const migration = MIGRATIONS.find((m) => m.version === row.version);
    if (!migration || !migration.down) {
      throw new Error(`Migration v${row.version} (${row.name}) has no down script.`);
    }

    db.exec('BEGIN');
    try {
      if (typeof migration.down === 'function') {
        migration.down(db);
      } else {
        db.exec(migration.down);
      }
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(row.version);
      const nextStatus = getMigrationStatus(db);
      db.exec(`PRAGMA user_version = ${nextStatus.currentVersion};`);
      db.exec('COMMIT');
      rolledBack.push({ version: row.version, name: row.name });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Rollback v${row.version} (${row.name}) failed: ${err.message}`);
    }
  }

  return {
    rolledBack,
    ...getMigrationStatus(db),
  };
}
