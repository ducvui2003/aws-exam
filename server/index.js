import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteApiMiddleware, loadEnvConfig } from './sqlitePlugin.js';

const env = loadEnvConfig();
const PORT = Number(env.PORT) || 5173;
const HOST = env.HOST || '0.0.0.0';
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const sqliteMiddleware = createSqliteApiMiddleware();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  sqliteMiddleware(req, res, () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let reqPath = decodeURIComponent(url.pathname);
    if (reqPath === '/') reqPath = '/index.html';

    const filePath = path.join(DIST_DIR, reqPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    } else {
      const indexHtml = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        fs.createReadStream(indexHtml).pipe(res);
      } else {
        res.statusCode = 404;
        res.end('Not found. Run "npm run build" first.');
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`AWS SAA-C03 Exam Server with SQLite running at http://${HOST}:${PORT}`);
});
