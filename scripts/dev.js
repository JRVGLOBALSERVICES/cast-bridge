/* Local dev server.
 *
 * The site is static, but /api/extract is a serverless function, so opening
 * index.html off the filesystem gives you a Browse tab that can't scan.
 * This serves the files and runs the function the same way Vercel routes it.
 *
 *   node scripts/dev.js [port]     → http://127.0.0.1:3400
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 3400);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const extract = require('../api/extract.js');
const scan = require('../api/scan.js');
const authApi = require('../api/auth.js');
const usersApi = require('../api/users.js');
const historyApi = require('../api/history.js');
const subsApi = require('../api/subs.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/auth') {
    try {
      await authApi(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/users' || pathname === '/api/history') {
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      await (pathname === '/api/users' ? usersApi : historyApi)(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/subs') {
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      await subsApi(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/scan') {
    try {
      await scan(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/extract') {
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      await extract(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    }
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  // cleanUrls, matching vercel.json
  let file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end('no'); return; }
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  res.end(fs.readFileSync(file));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Cast Bridge dev → http://127.0.0.1:' + PORT);
});
