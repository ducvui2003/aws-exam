import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadEnvConfig() {
  const envPath = path.resolve(process.cwd(), '.env');
  const config = { ...process.env };
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        config[key] = val;
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
  return config;
}

export const loadEnvFile = loadEnvConfig;

const initialEnv = loadEnvConfig();
const DB_PATH = path.resolve(process.cwd(), initialEnv.DB_PATH || './cloudexam.sqlite');
const BACKUP_DIR = path.resolve(process.cwd(), initialEnv.BACKUP_DIR || './backup');

let dbInstance = null;
const activeAdminTokens = new Set();

function importJsonExamIntoDb(db, examId, json, defaultTitle) {
  const questions = json.attemptAnswers || [];
  const stats = json.statistics || {};

  db.prepare(
    `INSERT INTO exams (
      id, exam_name, course_name, slug, total_questions,
      orig_correct_count, orig_incorrect_count, orig_skipped_count, orig_flagged_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      exam_name = excluded.exam_name,
      course_name = excluded.course_name,
      slug = excluded.slug,
      total_questions = excluded.total_questions,
      orig_correct_count = excluded.orig_correct_count,
      orig_incorrect_count = excluded.orig_incorrect_count,
      orig_skipped_count = excluded.orig_skipped_count,
      orig_flagged_count = excluded.orig_flagged_count`
  ).run(
    examId,
    json.examName || defaultTitle || examId,
    json.courseName || 'Practice Exams | AWS Certified Solutions Architect Associate',
    json.slug || 'practice-exams-aws-certified-solutions-architect-associate',
    questions.length,
    stats.correctCount ?? 0,
    stats.incorrectCount ?? 0,
    stats.skippedCount ?? 0,
    stats.flaggedCount ?? 0,
    new Date().toISOString()
  );

  const insertQ = db.prepare(
    `INSERT INTO questions (
      exam_id, question_id, attempt_answer_id, pos,
      question_text, explanation, answers_json, correct_answer_json,
      orig_selected_answers_json, orig_is_correct, orig_is_flagged, answers_pos
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exam_id, question_id) DO UPDATE SET
      attempt_answer_id = excluded.attempt_answer_id,
      pos = excluded.pos,
      question_text = excluded.question_text,
      explanation = excluded.explanation,
      answers_json = excluded.answers_json,
      correct_answer_json = excluded.correct_answer_json,
      orig_selected_answers_json = excluded.orig_selected_answers_json,
      orig_is_correct = excluded.orig_is_correct,
      orig_is_flagged = excluded.orig_is_flagged,
      answers_pos = excluded.answers_pos`
  );

  db.exec('BEGIN');
  try {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      insertQ.run(
        examId,
        q.questionId ?? i + 1,
        q.attemptAnswerId ?? null,
        q.pos ?? i,
        q.questionText || '',
        q.explanation || '',
        JSON.stringify(q.answers || []),
        JSON.stringify(q.correctAnswer || []),
        JSON.stringify(q.selectedAnswers || []),
        q.isCorrect ? 1 : 0,
        q.isFlagged ? 1 : 0,
        q.answersPos || '[]'
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function seedDatabaseFromBackupFolder(db, force = false) {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM exams').get();
  if (!force && countRow && countRow.cnt >= 6) {
    return { importedExams: 0, totalQuestions: 0 };
  }

  let importedExams = 0;
  let totalQuestions = 0;

  for (let i = 1; i <= 6; i++) {
    const examId = `test-${i}`;
    const fileName = `test-${i}.json`;
    const backupFile = path.join(BACKUP_DIR, fileName);
    const rootFile = path.resolve(process.cwd(), fileName);
    const sourcePath = fs.existsSync(backupFile)
      ? backupFile
      : fs.existsSync(rootFile)
      ? rootFile
      : null;

    if (sourcePath) {
      const raw = fs.readFileSync(sourcePath, 'utf8');
      const json = JSON.parse(raw);
      importJsonExamIntoDb(db, examId, json, `Practice Test 0${i}`);
      importedExams++;
      totalQuestions += (json.attemptAnswers || []).length;
    }
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  return { importedExams, totalQuestions };
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec(`
      PRAGMA journal_mode = WAL;

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
        session_json TEXT NOT NULL DEFAULT '{}',
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
    `);

    try {
      dbInstance.exec(
        "ALTER TABLE exam_progress ADD COLUMN session_json TEXT NOT NULL DEFAULT '{}';"
      );
    } catch {
      // Column already exists
    }
    seedDatabaseFromBackupFolder(dbInstance, false);
  }
  return dbInstance;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function isAuthenticatedAdmin(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token && activeAdminTokens.has(token);
}

export function createSqliteApiMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      return next();
    }

    try {
      const db = getDb();

      // 1. PUBLIC: GET /api/exams -> returns all exams + questions from SQLite tables
      if (req.method === 'GET' && url.pathname === '/api/exams') {
        const examRows = db.prepare('SELECT * FROM exams ORDER BY id ASC').all();
        const questionStmt = db.prepare(
          'SELECT * FROM questions WHERE exam_id = ? ORDER BY pos ASC, id ASC'
        );

        const catalog = {};
        for (const ex of examRows) {
          const qRows = questionStmt.all(ex.id);
          const attemptAnswers = qRows.map((q) => ({
            attemptAnswerId: q.attempt_answer_id,
            questionId: q.question_id,
            questionText: q.question_text,
            explanation: q.explanation,
            answers: JSON.parse(q.answers_json || '[]'),
            correctAnswer: JSON.parse(q.correct_answer_json || '[]'),
            selectedAnswers: JSON.parse(q.orig_selected_answers_json || '[]'),
            isCorrect: !!q.orig_is_correct,
            isFlagged: !!q.orig_is_flagged,
            answersPos: q.answers_pos,
            pos: q.pos,
          }));

          catalog[ex.id] = {
            id: ex.id,
            title: ex.exam_name,
            examName: ex.exam_name,
            courseName: ex.course_name,
            totalQuestions: attemptAnswers.length,
            originalStats: {
              correctCount: ex.orig_correct_count,
              incorrectCount: ex.orig_incorrect_count,
              skippedCount: ex.orig_skipped_count,
              flaggedCount: ex.orig_flagged_count,
            },
            rawData: {
              examName: ex.exam_name,
              courseName: ex.course_name,
              slug: ex.slug,
              statistics: {
                correctCount: ex.orig_correct_count,
                incorrectCount: ex.orig_incorrect_count,
                skippedCount: ex.orig_skipped_count,
                flaggedCount: ex.orig_flagged_count,
              },
              attemptAnswers,
            },
          };
        }

        return sendJson(res, 200, { ok: true, catalog });
      }

      // 2. ADMIN AUTH: POST /api/admin/login (verifies against ADMIN_USERNAME & ADMIN_PASSWORD in .env)
      if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        const { username, password } = await readJsonBody(req);
        if (!username || !password) {
          return sendJson(res, 400, { ok: false, error: 'Username and password required' });
        }
        // Re-read .env dynamically so changes to .env take effect immediately
        const envConfig = loadEnvConfig();
        const expectedUser = (envConfig.ADMIN_USERNAME || 'admin').trim();
        const expectedPass = envConfig.ADMIN_PASSWORD || 'admin123';

        if (username.trim() !== expectedUser || password !== expectedPass) {
          return sendJson(res, 401, { ok: false, error: 'Invalid admin username or password' });
        }

        const token = crypto.randomBytes(24).toString('hex');
        activeAdminTokens.add(token);
        return sendJson(res, 200, {
          ok: true,
          token,
          username: expectedUser,
        });
      }

      // 3. ADMIN AUTH: POST /api/admin/logout
      if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
        const auth = req.headers['authorization'] || '';
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token) activeAdminTokens.delete(token);
        return sendJson(res, 200, { ok: true });
      }

      // 4. ADMIN: POST /api/admin/restore-backup -> re-import JSON files from backup folder into SQLite
      if (req.method === 'POST' && url.pathname === '/api/admin/restore-backup') {
        if (!isAuthenticatedAdmin(req)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        const result = seedDatabaseFromBackupFolder(db, true);
        return sendJson(res, 200, { ok: true, ...result });
      }

      // 5. ADMIN: POST /api/admin/import-exam -> import custom uploaded JSON into SQLite + backup folder
      if (req.method === 'POST' && url.pathname === '/api/admin/import-exam') {
        if (!isAuthenticatedAdmin(req)) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        }
        const { examId, json, title } = await readJsonBody(req);
        if (!examId || !json || !Array.isArray(json.attemptAnswers)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid exam JSON payload' });
        }
        importJsonExamIntoDb(db, examId, json, title);
        if (!fs.existsSync(BACKUP_DIR)) {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        fs.writeFileSync(
          path.join(BACKUP_DIR, `${examId}.json`),
          JSON.stringify(json, null, 2),
          'utf8'
        );
        return sendJson(res, 200, { ok: true });
      }

      // 6. GET /api/state -> returns progress, attempts, and SQLite statistics (without exposing file paths)
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const progressRows = db.prepare('SELECT * FROM exam_progress').all();
        const progress = {};
        for (const r of progressRows) {
          progress[r.exam_id] = {
            answers: JSON.parse(r.answers_json || '{}'),
            revealed: JSON.parse(r.revealed_json || '{}'),
            flagged: JSON.parse(r.flagged_json || '{}'),
            session: JSON.parse(r.session_json || 'null'),
          };
        }

        const attemptRows = db
          .prepare('SELECT * FROM exam_attempts ORDER BY rowid DESC')
          .all();
        const history = {};
        for (const r of attemptRows) {
          if (!history[r.exam_id]) history[r.exam_id] = [];
          history[r.exam_id].push({
            id: r.id,
            examId: r.exam_id,
            label: r.label,
            isOriginalJson: !!r.is_original_json,
            submittedAt: r.submitted_at,
            mode: r.mode,
            durationSeconds: r.duration_seconds,
            total: r.total,
            answered: r.answered,
            unanswered: r.unanswered,
            correct: r.correct,
            incorrect: r.incorrect,
            flaggedCount: r.flagged_count,
            pct: r.pct,
            scaledScore: r.scaled_score,
            passed: !!r.passed,
            answers: JSON.parse(r.answers_json || '{}'),
            flagged: JSON.parse(r.flagged_json || '{}'),
          });
        }

        const examsCount = db.prepare('SELECT COUNT(*) as cnt FROM exams').get()?.cnt || 0;
        const questionsCount =
          db.prepare('SELECT COUNT(*) as cnt FROM questions').get()?.cnt || 0;

        let backupCount = 0;
        try {
          if (fs.existsSync(BACKUP_DIR)) {
            backupCount = fs
              .readdirSync(BACKUP_DIR)
              .filter((f) => f.endsWith('.json')).length;
          }
        } catch {
          backupCount = 0;
        }

        return sendJson(res, 200, {
          ok: true,
          backupCount,
          examsCount,
          questionsCount,
          progressCount: progressRows.length,
          attemptsCount: attemptRows.length,
          progress,
          history,
        });
      }

      // 7. PUT /api/progress -> upsert exam_progress for an examId
      if (req.method === 'PUT' && url.pathname === '/api/progress') {
        const body = await readJsonBody(req);
        const { examId, state } = body;
        if (!examId) return sendJson(res, 400, { error: 'Missing examId' });

        if (!state) {
          db.prepare('DELETE FROM exam_progress WHERE exam_id = ?').run(examId);
        } else {
          db.prepare(
            `INSERT INTO exam_progress (exam_id, answers_json, revealed_json, flagged_json, session_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(exam_id) DO UPDATE SET
               answers_json = excluded.answers_json,
               revealed_json = excluded.revealed_json,
               flagged_json = excluded.flagged_json,
               session_json = excluded.session_json,
               updated_at = excluded.updated_at`
          ).run(
            examId,
            JSON.stringify(state.answers || {}),
            JSON.stringify(state.revealed || {}),
            JSON.stringify(state.flagged || {}),
            JSON.stringify(state.session || null),
            new Date().toISOString()
          );
        }
        return sendJson(res, 200, { ok: true });
      }

      // 8. POST /api/attempts -> insert a submitted attempt into SQLite
      if (req.method === 'POST' && url.pathname === '/api/attempts') {
        const body = await readJsonBody(req);
        const { examId, attempt } = body;
        if (!examId || !attempt || !attempt.id) {
          return sendJson(res, 400, { error: 'Missing examId or attempt' });
        }

        db.prepare(
          `INSERT OR REPLACE INTO exam_attempts (
            id, exam_id, label, is_original_json, submitted_at, mode,
            duration_seconds, total, answered, unanswered, correct, incorrect,
            flagged_count, pct, scaled_score, passed, answers_json, flagged_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          attempt.id,
          examId,
          attempt.label || null,
          attempt.isOriginalJson ? 1 : 0,
          attempt.submittedAt || null,
          attempt.mode || 'exam',
          attempt.durationSeconds ?? null,
          attempt.total ?? 65,
          attempt.answered ?? 0,
          attempt.unanswered ?? 0,
          attempt.correct ?? 0,
          attempt.incorrect ?? 0,
          attempt.flaggedCount ?? 0,
          attempt.pct ?? 0,
          attempt.scaledScore ?? 100,
          attempt.passed ? 1 : 0,
          JSON.stringify(attempt.answers || {}),
          JSON.stringify(attempt.flagged || {})
        );

        return sendJson(res, 200, { ok: true });
      }

      // 9. DELETE /api/attempts -> delete a single attempt by ID
      if (req.method === 'DELETE' && url.pathname === '/api/attempts') {
        const attemptId = url.searchParams.get('id');
        if (!attemptId) {
          return sendJson(res, 400, { error: 'Missing attempt id' });
        }
        db.prepare('DELETE FROM exam_attempts WHERE id = ?').run(attemptId);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('SQLite API Error:', err);
      return sendJson(res, 500, { error: err.message });
    }
  };
}

export function sqliteVitePlugin() {
  const middleware = createSqliteApiMiddleware();
  return {
    name: 'sqlite-api-plugin',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
