# AWS SAA-C03 CloudExam Platform

Interactive practice exam and review application for the **AWS Certified Solutions Architect - Associate (SAA-C03)** certification, backed by Node.js built-in SQLite (`node:sqlite`).

---

## Quick Start

### 1. Environment Configuration (`.env`)
Copy `.env.example` to `.env` and adjust as needed:

```dotenv
APP_NAME=aws-saa-cloudexam
PORT=5173
HOST=0.0.0.0
DB_PATH=./cloudexam.sqlite
BACKUP_DIR=./backup
NODE_ENV=production
```

### 2. Development
```bash
npm install
npm run dev
```

### 3. Production & PM2 Deployment
```bash
# Build frontend assets into dist/
npm run build

# Run migrations
npm run migrate

# Start with PM2
pm2 start ecosystem.config.cjs

# Reload after editing .env
pm2 restart ecosystem.config.cjs --update-env
```

---

## GitHub Actions CI/CD Deployment to VPS

This repository includes an automated CI/CD workflow in [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) that triggers on pushes to `main` / `master` (or manually via **Actions -> Run workflow**).

### What the Workflow Does
1. Installs dependencies and builds the React + Vite frontend (`dist/`) on the GitHub runner.
2. Connects to your VPS over SSH and syncs the built application via `rsync` (while preserving your live `*.sqlite*` database files and `.env` on the VPS).
3. Writes the `.env` file on the VPS from your `ENV_FILE` GitHub Secret.
4. Runs `npm run migrate` on the VPS to ensure the SQLite schema is up to date.
5. Starts or reloads the application using PM2 (`pm2 startOrReload ecosystem.config.cjs --update-env`).

### Required GitHub Secrets
Go to your GitHub repository -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**, and add the following secrets:

| Secret Name | Required | Example Value | Description |
| :--- | :---: | :--- | :--- |
| `VPS_HOST` | **Yes** | `103.x.x.x` or `vps.example.com` | IPv4 address or hostname of your VPS |
| `VPS_USER` | **Yes** | `root` or `ubuntu` | SSH username on your VPS |
| `VPS_SSH_KEY` | **Yes** | `-----BEGIN OPENSSH PRIVATE KEY-----...` | Full content of your SSH Private Key (the key used for `ssh ducvui2003`) |
| `ENV_FILE` | **Yes** | *(see template below)* | Full multi-line content of your `.env` file to deploy to the VPS |
| `VPS_PORT` | Optional | `22` | SSH port (defaults to `22` if omitted) |
| `VPS_DEPLOY_PATH` | Optional | `/var/www/cloudexam_saa` | Target directory on the VPS (defaults to `/var/www/cloudexam_saa`) |

#### Example `ENV_FILE` Secret Value:
```dotenv
APP_NAME=aws-saa-cloudexam
PORT=5173
HOST=0.0.0.0
DB_PATH=./cloudexam.sqlite
BACKUP_DIR=./backup
NODE_ENV=production
```

#### How to Get Your SSH Private Key for `VPS_SSH_KEY`:
On your local laptop, check your `.ssh/config` for `ducvui2003` or print your private key:
```powershell
# PowerShell
Get-Content ~/.ssh/id_rsa
# or if using ed25519:
Get-Content ~/.ssh/id_ed25519
```
Copy the entire output (including `-----BEGIN ... PRIVATE KEY-----` and `-----END ... PRIVATE KEY-----`) and paste it into the `VPS_SSH_KEY` secret.

### VPS Prerequisites
Ensure your VPS has **Node.js v22.5+** (required for built-in `node:sqlite`), `rsync`, and `pm2` installed:
```bash
# Check Node.js version on VPS (must be >= 22.5.0 for node:sqlite)
node -v

# Install PM2 globally if not installed
npm install -g pm2
```

---

## SQLite Database & Migration Rules (For Developers & AI Agents)

> **IMPORTANT RULE FOR AI AGENTS & DEVELOPERS:**
> Never modify existing migration versions (such as `version: 1`) or hardcode `CREATE TABLE` / `ALTER TABLE` statements directly inside `server/sqlitePlugin.js`. All database schema changes **must** be added as a new sequential migration in `server/migrations.js`.

### Architecture Overview
- **Database file**: Controlled by `DB_PATH` in `.env` (defaults to `./cloudexam.sqlite`).
- **Migration registry**: `server/migrations.js` exports the `MIGRATIONS` array.
- **Version tracking**: Tracked in the `schema_migrations` table (`version`, `name`, `applied_at`) and SQLite `PRAGMA user_version`.
- **Auto-migration**: `getDb()` in `server/sqlitePlugin.js` automatically runs `runMigrations()` on startup.

### Current Schema Versions
- **v1 (`v1_initial_schema`)**:
  - `admins`: Admin credentials (`username`, `password_hash`, `updated_at`)
  - `exams`: Exam metadata and original JSON statistics
  - `questions`: Questions, options (`answers_json`), explanations, and original attempt flags
  - `exam_progress`: In-progress answers, revealed state, and flagged questions per exam
  - `exam_attempts`: Submitted exam/practice attempt history and scores

### Step-by-Step Rule for Modifying the Schema
When you need to add a table, add/modify a column, or add an index:

1. **Do NOT edit existing migration entries** in `server/migrations.js` once they have been applied.
2. **Append a new migration object** to `MIGRATIONS` in `server/migrations.js` with `version: <last_version + 1>`:
   ```js
   {
     version: 2,
     name: 'v2_descriptive_migration_name',
     up: `
       ALTER TABLE exams ADD COLUMN category TEXT DEFAULT 'SAA-C03';
     `,
     down: `
       ALTER TABLE exams DROP COLUMN category;
     `,
   }
   ```
   *(Note: `up` and `down` can be either a SQL string or a function `(db) => { ... }` for complex data migrations).*
3. **Test and apply the migration** using the CLI commands:
   ```bash
   # Check current schema version and pending migrations
   npm run migrate:status

   # Apply pending migrations
   npm run migrate

   # Test rollback if needed
   npm run migrate:down
   ```
4. **Update API queries** in `server/sqlitePlugin.js` to read/write the new columns or tables after the migration is registered.
5. **Document the new version** under the "Current Schema Versions" section of this `README.md`.
