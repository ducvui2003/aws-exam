const fs = require('node:fs');
const path = require('node:path');

// Parse .env file if it exists (values in process.env take precedence if passed directly)
const envFile = path.resolve(__dirname, '.env');
const fileEnv = {};
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fileEnv[key] = val;
  }
}

module.exports = {
  apps: [
    {
      name: process.env.APP_NAME || fileEnv.APP_NAME || 'aws-saa-cloudexam',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: process.env.NODE_ENV || fileEnv.NODE_ENV || 'production',
        HOST: process.env.HOST || fileEnv.HOST || '0.0.0.0',
        PORT: Number(process.env.PORT || fileEnv.PORT || 5173),
        DB_PATH: process.env.DB_PATH || fileEnv.DB_PATH || './cloudexam.sqlite',
        BACKUP_DIR: process.env.BACKUP_DIR || fileEnv.BACKUP_DIR || './backup',
      },
    },
  ],
};
