/* The stream proxy, as a service.
 *
 * WHY THIS EXISTS AT ALL. /api/stream is the one endpoint in this app that
 * carries the film itself, and on Vercel every byte of it is billed twice —
 * once function-to-CDN as Fast Origin Transfer, once CDN-to-television as
 * Fast Data Transfer. The data leg has a terabyte of headroom; the origin
 * leg has no free allowance whatsoever, so a proxied stream starts costing
 * from its first byte and works out around $0.27/GB. A 5 GB film is $1.35
 * to watch. Every HLS stream goes through the proxy by definition, so that
 * is the ordinary case, not the exceptional one.
 *
 * The same bytes leaving this VPS cost nothing per gigabyte. It also sits
 * in Singapore, roughly 300km and a few milliseconds from the television
 * doing the fetching, which is closer than any Vercel region gets.
 *
 * WHAT IT DOES NOT DO. It does not reimplement the proxy. It requires the
 * very same api/stream.js that Vercel runs, so the referer forwarding, the
 * playlist rewriting, the disguised-segment detection and the SSRF guard
 * cannot drift between the two hosts — there is only one of each. This
 * file is a socket, a route table and an accountant.
 *
 * It listens on loopback only. Public HTTPS is nginx's job (see
 * deploy/stream.jrvsystems.app.conf) because a television will not fetch
 * plain http from a receiver page served over https, and because TLS,
 * rate limiting and access logging are all things nginx already does.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Environment, from a file, before anything reads it.
 *
 * This service was started once with its variables typed on the command
 * line, so they lived nowhere but pm2's own dump. `pm2 delete cast-stream`
 * would have taken STREAM_UPLOAD_SECRET with it, and the only symptom
 * would have been every upload answering 503 — file casting silently off,
 * with nothing broken enough to notice. A file is the durable version of
 * that, and it is read before the requires below because lib/ticket.js
 * reads the secret at call time and storage.js reads its directories at
 * load time.
 *
 * Anything already in the environment WINS: pm2's env, a systemd unit or a
 * one-off `FOO=bar node server/...` must still be able to override the
 * file. No dependency — the stream path deliberately has none.
 */
(function loadEnvFile() {
  const file = process.env.STREAM_ENV_FILE || path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // no file is a normal deployment, not an error
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

const streamApi = require('../api/stream.js');
const storage = require('./storage.js');
const ticket = require('../lib/ticket.js');

const PORT = Number(process.env.PORT || 7801);
const HOST = process.env.HOST || '127.0.0.1';

/* Bytes served, kept per UTC day. The question this service was stood up
   to answer is "what does this actually cost", and the honest form of that
   answer is a measured number rather than an estimate from a price list.
   Flushed on a timer rather than per request: a film is tens of thousands
   of range responses and none of them is worth an fsync. */
const STATE_DIR = process.env.STREAM_STATE_DIR || '/var/lib/cast-stream';
const STATE_FILE = path.join(STATE_DIR, 'usage.json');
const FLUSH_MS = 30000;
const KEEP_DAYS = 90;

let usage = {};
let dirty = false;

try {
  usage = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
} catch (e) {
  usage = {};
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function record(bytes) {
  if (!bytes) return;
  const day = today();
  usage[day] = (usage[day] || 0) + bytes;
  dirty = true;
}

function flush() {
  if (!dirty) return;
  /* An unbounded ledger is a slow leak. Ninety days is more history than
     a monthly bill ever needs and still fits in a few kilobytes. */
  const days = Object.keys(usage).sort();
  while (days.length > KEEP_DAYS) delete usage[days.shift()];
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(usage));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    dirty = false;
  } catch (e) {
    console.error('[usage] could not write ' + STATE_FILE + ': ' + e.message);
  }
}

const flushTimer = setInterval(flush, FLUSH_MS);
flushTimer.unref();

/* Counted at the socket rather than from Content-Length, because the
   interesting responses are the ones that do not have one: an open-ended
   range answered a window at a time, and a stream that died halfway. What
   leaves the machine is what gets billed, so what leaves the machine is
   what gets counted. */
function meter(res) {
  let sent = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);

  res.write = function (chunk, ...rest) {
    if (chunk && typeof chunk !== 'function') sent += Buffer.byteLength(chunk);
    return write(chunk, ...rest);
  };
  res.end = function (chunk, ...rest) {
    if (chunk && typeof chunk !== 'function') sent += Buffer.byteLength(chunk);
    return end(chunk, ...rest);
  };

  return () => sent;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function gb(bytes) {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 1000) / 1000;
}

const started = Date.now();
let inFlight = 0;

/* Which commit is actually running. Read from .git rather than baked in at
   build time because there is no build: the deploy is `git pull && pm2
   restart`, and the question worth answering on a bad day is whether that
   pull ever happened. Read once — it cannot change without a restart. */
const COMMIT = (function () {
  try {
    const head = fs.readFileSync(path.join(__dirname, '..', '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return head.slice(0, 12);
    const ref = fs.readFileSync(path.join(__dirname, '..', '.git', m[1]), 'utf8').trim();
    return ref.slice(0, 12);
  } catch (e) {
    return null;
  }
})();

function commit() {
  return COMMIT;
}

/* The app lives on another origin, so every call it makes here is a
   cross-origin one and the browser asks first. Named rather than starred:
   `*` would let any page on the internet spend this box's disk with a
   ticket it stole from a tab. The television is not a browser and asks
   nothing, so /f/ is exempt and says `*` for the Cast receiver's benefit. */
const APP_ORIGINS = (process.env.CAST_APP_ORIGINS ||
  'https://cast.jrvsystems.app,https://cast-bridge-new.vercel.app,' +
  'https://cast-bridge.vercel.app,http://127.0.0.1:3400,http://localhost:3400')
  .split(',').map((o) => o.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

/* Every route below this line is gated the same way, and a route that
   forgets to call it is a route with no gate — so it returns the ticket
   rather than a boolean, and the caller cannot use it without checking. */
function gate(req, res, scope) {
  if (!ticket.configured()) {
    json(res, 503, { ok: false, error: 'This host has no STREAM_UPLOAD_SECRET set, so file casting is off.' });
    return null;
  }
  const t = ticket.check(ticket.fromRequest(req), scope);
  if (!t) {
    json(res, 401, { ok: false, error: 'That ticket is not valid any more. Reload the app and try again.' });
    return null;
  }
  return t;
}

/* Range-serving a file off local disk. The television asks for windows and
   nothing else — an answer without 206 and Accept-Ranges is an answer it
   cannot seek in. */
function serveFile(req, res, meta) {
  const file = storage.pathOf(meta);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return json(res, 404, { ok: false, error: 'That file is not here any more.' });
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', meta.type || 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  /* Uploads are immutable and short-lived; the id never names two files. */
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m || (!m[1] && !m[2])) {
    res.statusCode = 200;
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  let start;
  let end;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : st.size - 1;
  } else {
    /* bytes=-N — the last N bytes. Used by players sniffing an MP4 whose
       moov atom is at the end of the file, which is most of them. */
    start = Math.max(0, st.size - Number(m[2]));
    end = st.size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', 'bytes */' + st.size);
    return res.end();
  }
  end = Math.min(end, st.size - 1);

  res.statusCode = 206;
  res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + st.size);
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start: start, end: end }).pipe(res);
}

function base() {
  return process.env.STREAM_PUBLIC_HOST || 'https://stream.jrvsystems.app';
}

/* The address a person is given. The 32 hex characters are the whole
   credential; the slug in front of them is so a pasted link says what it
   is. /f/<id> keeps working unchanged — that is what a television fetches,
   and a television must never be handed a page. */
function shareUrl(meta) {
  return base() + '/w/' + storage.slugOf(meta.name) + '-' + meta.id;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function human(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / (1024 ** 3)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return Math.round(n / (1024 ** 2)) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function untilWords(expires) {
  if (!expires) return 'This link stays up until it is deleted.';
  const left = Date.parse(expires) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return 'This link has expired.';
  const h = Math.round(left / 3600000);
  if (h < 1) return 'This link expires within the hour.';
  if (h < 48) return 'This link expires in about ' + h + ' hour' + (h === 1 ? '' : 's') + '.';
  return 'This link expires in about ' + Math.round(h / 24) + ' days.';
}

/* The page behind a share link.
 *
 * Deliberately one file with no assets: it is opened by people who have
 * nothing to do with this app, often on a slow phone, and a player that
 * waits on a stylesheet from another origin is a player that stalls before
 * the video it is there for. Same reason there is no ticket on it — the
 * address IS the capability, exactly as it is for /f/<id>. Being able to
 * watch is the whole point; nothing here can delete, rename or list
 * anything, and there is no way from this page to any other file.
 */
function watchPage(meta) {
  const src = base() + '/f/' + meta.id;
  const audio = String(meta.type || '').startsWith('audio/');
  const title = esc(meta.name);
  return '<!doctype html>\n<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>' + title + '</title>' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<meta property="og:title" content="' + title + '">' +
    '<meta property="og:type" content="video.other">' +
    '<meta property="og:video" content="' + esc(src) + '">' +
    '<style>' +
    ':root{color-scheme:dark}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;background:#0e0f13;color:#e9eaf0;' +
    'font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'display:flex;flex-direction:column;min-height:100dvh;' +
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}' +
    'main{width:100%;max-width:960px;margin:0 auto;padding:20px 18px 32px;flex:1}' +
    'h1{font-size:19px;line-height:1.3;font-weight:600;margin:0 0 4px;overflow-wrap:anywhere}' +
    'p{margin:0;color:#9598a6;font-size:13.5px}' +
    '.stage{margin:16px 0 14px;background:#000;border-radius:14px;overflow:hidden;' +
    'box-shadow:0 18px 44px rgba(0,0,0,.5)}' +
    'video{display:block;width:100%;max-height:78dvh;background:#000}' +
    'audio{display:block;width:100%;padding:22px 16px;background:#15161c}' +
    '.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}' +
    'a.btn{appearance:none;text-decoration:none;display:inline-flex;align-items:center;gap:8px;' +
    'padding:11px 16px;border-radius:11px;background:#22242e;color:#e9eaf0;font-size:14px;' +
    'font-weight:600;border:1px solid #2e3140}' +
    'a.btn:hover{background:#2a2d38}' +
    'a.btn:focus-visible{outline:2px solid #7e8cff;outline-offset:2px}' +
    'footer{margin-top:22px;padding-top:14px;border-top:1px solid #22242e;font-size:12.5px;color:#7a7d8b}' +
    '</style></head><body><main>' +
    '<h1>' + title + '</h1>' +
    '<p>' + esc(human(meta.bytes)) + ' &middot; ' + esc(untilWords(meta.expires)) + '</p>' +
    '<div class="stage">' +
    (audio
      ? '<audio controls preload="metadata" src="' + esc(src) + '"></audio>'
      : '<video controls playsinline preload="metadata" x-webkit-airplay="allow" ' +
        'src="' + esc(src) + '"></video>') +
    '</div>' +
    '<div class="row">' +
    '<a class="btn" href="' + esc(src) + '" download>Download</a>' +
    '<a class="btn" href="vlc://' + esc(src.replace(/^https?:\/\//, '')) + '">Open in VLC</a>' +
    '</div>' +
    '<footer>Shared from Cast Bridge. Anyone with this link can watch it; ' +
    'nobody without it can find it.</footer>' +
    '</main></body></html>\n';
}

async function readJsonBody(req, cap) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > (cap || 8192)) throw new Error('Too much data.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* The disk gets back to zero on its own. The buttons in the app are for
   not waiting, not for remembering. */
const sweepTimer = setInterval(() => {
  storage.sweep().then((r) => {
    if (r && ((r.files && r.files.removed) || (r.tmp && r.tmp.removed))) {
      console.log('[sweep] removed ' +
        ((r.files && r.files.removed) || 0) + ' expired, ' +
        ((r.tmp && r.tmp.removed) || 0) + ' partial');
    }
  });
}, 15 * 60 * 1000);
sweepTimer.unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const sentSoFar = meter(res);
  const t0 = Date.now();

  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (url.pathname === '/healthz') {
    const day = today();
    const month = day.slice(0, 7);
    let monthBytes = 0;
    for (const d of Object.keys(usage)) if (d.startsWith(month)) monthBytes += usage[d];
    let disk = null;
    try { disk = await storage.usage(); } catch (e) { disk = null; }
    json(res, 200, {
      ok: true,
      uptime_s: Math.round((Date.now() - started) / 1000),
      in_flight: inFlight,
      window_mb: Number(process.env.STREAM_RANGE_WINDOW_MB) || 8,
      served_today_gb: gb(usage[day] || 0),
      served_this_month_gb: gb(monthBytes),
      uploads_enabled: ticket.configured(),
      storage: disk
    });
    return;
  }

  /* ---------- Files from a phone ----------
   *
   *   POST /api/upload?name=…&size=…   raw body, ticket in the header
   *   GET  /f/<id>                     what the television fetches
   *   GET  /api/storage                what is on the disk
   *   POST /api/storage/clear          { what: tmp|expired|files|all }
   *   POST /api/storage/delete         { ids: [...] }
   */

  if (url.pathname === '/api/upload') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' });
    const t = gate(req, res, 'upload');
    if (!t) return;
    try {
      const meta = await storage.receive(req, {
        name: url.searchParams.get('name'),
        declaredBytes: url.searchParams.get('size'),
        /* Absent means the default day. "0" means keep until deleted, and
           has to survive the difference between absent and zero. */
        keepHours: url.searchParams.has('keep') ? url.searchParams.get('keep') : undefined,
        uploader: t.uid
      });
      console.log(new Date().toISOString() + ' upload ' + meta.id + ' ' + meta.bytes + 'B ' +
        'keep=' + (meta.keepHours === 0 ? 'forever' : meta.keepHours + 'h') + ' ' + meta.name);
      return json(res, 201, {
        ok: true,
        file: Object.assign({}, meta, { slug: storage.slugOf(meta.name) }),
        url: base() + '/f/' + meta.id,
        share: shareUrl(meta)
      });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message || 'That upload failed.' });
    }
  }

  /* ---------- A share link ----------
   * /w/<anything>-<32 hex>. The slug is decoration and is not checked; the
   * id is matched off the end, so renaming the slug in a pasted URL still
   * lands on the right file rather than on a 404 nobody can explain. */
  const watchMatch = /^\/w\/(?:.*-)?([0-9a-f]{32})\/?$/.exec(url.pathname);
  if (watchMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { ok: false, error: 'Use GET.' });
    }
    const meta = await storage.metaOf(watchMatch[1]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!meta) {
      res.statusCode = 404;
      if (req.method === 'HEAD') return res.end();
      return res.end('<!doctype html><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Not here any more</title>' +
        '<body style="margin:0;background:#0e0f13;color:#e9eaf0;font:400 16px/1.6 ' +
        '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;display:grid;' +
        'place-items:center;min-height:100dvh;padding:24px;text-align:center">' +
        '<div><h1 style="font-size:20px;margin:0 0 8px">This file is not here any more</h1>' +
        '<p style="margin:0;color:#9598a6;max-width:34ch">Shared files are deleted when ' +
        'their time runs out, or by hand. Ask whoever sent the link to send it again.</p>' +
        '</div></body>\n');
    }
    const withExp = Object.assign({}, meta, { expires: storage.expiryOf(meta) });
    res.statusCode = 200;
    if (req.method === 'HEAD') return res.end();
    return res.end(watchPage(withExp));
  }

  const fileMatch = /^\/f\/([0-9a-f]{32})$/.exec(url.pathname);
  if (fileMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { ok: false, error: 'Use GET.' });
    }
    /* No ticket here on purpose. A Chromecast fetches this with no headers
       we control and no way to carry one; the 32-hex id IS the credential,
       and it is deleted within the day. */
    const meta = await storage.metaOf(fileMatch[1]);
    if (!meta) return json(res, 404, { ok: false, error: 'That file is not here any more.' });
    inFlight++;
    res.on('close', () => {
      inFlight--;
      const bytes = sentSoFar();
      record(bytes);
      console.log([new Date().toISOString(), res.statusCode, (req.headers.range || '-'),
        bytes + 'B', (Date.now() - t0) + 'ms',
        (res.writableFinished ? 'complete' : 'aborted'), 'file:' + meta.id].join(' '));
    });
    return serveFile(req, res, meta);
  }

  /* ---------- What this machine is doing ----------
   *
   * /healthz is public because the app has to be able to ask "is the box
   * up" before anybody signs in, and a Chromecast asks it with no headers
   * at all. Load average, free memory, the node version and the commit in
   * use are a different kind of fact: they are of no use to a viewer and
   * of some use to a stranger, so they live behind the same owner-only
   * ticket the file list uses rather than on the open endpoint.
   */
  if (url.pathname === '/api/system') {
    if (!gate(req, res, 'storage')) return;
    const day = today();
    const days = Object.keys(usage).sort().slice(-14)
      .map((d) => ({ day: d, bytes: usage[d] }));
    const total = os.totalmem();
    const free = os.freemem();
    const cpus = os.cpus() || [];
    let disk = null;
    try { disk = await storage.usage(); } catch (e) { disk = null; }
    return json(res, 200, {
      ok: true,
      service: {
        pid: process.pid,
        node: process.version,
        uptime_s: Math.round((Date.now() - started) / 1000),
        started_at: started,
        commit: commit(),
        port: PORT,
        in_flight: inFlight,
        window_mb: Number(process.env.STREAM_RANGE_WINDOW_MB) || 8,
        uploads_enabled: ticket.configured(),
        state_dir: STATE_DIR
      },
      machine: {
        hostname: os.hostname(),
        platform: os.platform() + ' ' + os.release(),
        arch: os.arch(),
        uptime_s: Math.round(os.uptime()),
        cpu_count: cpus.length,
        cpu_model: cpus.length ? cpus[0].model : null,
        /* Load per core, because 4.0 on this box and 4.0 on a laptop are
           not the same sentence. */
        load: os.loadavg().map((n) => Math.round(n * 100) / 100),
        load_per_core: cpus.length
          ? Math.round((os.loadavg()[0] / cpus.length) * 100) / 100
          : null,
        mem_total: total,
        mem_free: free,
        mem_used_pct: total ? Math.round(((total - free) / total) * 1000) / 10 : null
      },
      storage: disk,
      served: { today: usage[day] || 0, days: days }
    });
  }

  if (url.pathname === '/api/storage') {
    if (!gate(req, res, 'storage')) return;
    const [use, files] = await Promise.all([storage.usage(), storage.list()]);
    return json(res, 200, {
      ok: true,
      usage: use,
      files: files.map((f) => Object.assign({}, f, {
        url: base() + '/f/' + f.id,
        share: shareUrl(f)
      }))
    });
  }

  /* ---------- One person's own uploads ----------
   *
   *   GET  /api/library          what I have here
   *   POST /api/library/keep     { id, keep }   re-date it
   *   POST /api/library/delete   { ids: [...] } remove it
   *
   * Separate from /api/storage rather than a filter on it, because they
   * answer different questions and are trusted differently: /api/storage is
   * the owner reading a shared disk, this is a person reading their own
   * shelf. The uid in the ticket is the only thing that decides which rows
   * exist, so there is no id a caller can name to reach someone else's.
   */
  if (url.pathname === '/api/library') {
    const t = gate(req, res, 'library');
    if (!t) return;
    const files = await storage.listFor(t.uid);
    return json(res, 200, {
      ok: true,
      max_keep_hours: storage.MAX_KEEP_HOURS,
      files: files.map((f) => Object.assign({}, f, {
        url: base() + '/f/' + f.id,
        share: shareUrl(f)
      }))
    });
  }

  if (url.pathname === '/api/library/keep' || url.pathname === '/api/library/delete') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' });
    const t = gate(req, res, 'library');
    if (!t) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: 'That request was not readable.' });
    }
    if (url.pathname.endsWith('/keep')) {
      const meta = await storage.setExpiry(String(body.id || ''), body.keep, t.uid);
      if (!meta) return json(res, 404, { ok: false, error: 'That file is not yours, or not here.' });
      return json(res, 200, {
        ok: true,
        file: Object.assign({}, meta, { share: shareUrl(meta), url: base() + '/f/' + meta.id })
      });
    }
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 50) : [];
    let removed = 0;
    for (const id of ids) {
      /* Ownership is checked before the unlink, not after: removeOne takes
         an id and would happily delete anybody's. */
      const meta = await storage.metaOf(id);
      if (!meta || (meta.uploader && meta.uploader !== t.uid)) continue;
      if (await storage.removeOne(id)) removed++;
    }
    console.log('[library] ' + t.uid + ' deleted ' + removed + ' of ' + ids.length);
    return json(res, 200, { ok: true, removed: removed });
  }

  if (url.pathname === '/api/storage/clear' || url.pathname === '/api/storage/delete') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' });
    if (!gate(req, res, 'storage')) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: 'That request was not readable.' });
    }
    try {
      if (url.pathname.endsWith('/delete')) {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        let removed = 0;
        for (const id of ids) if (await storage.removeOne(id)) removed++;
        console.log('[storage] deleted ' + removed + ' of ' + ids.length);
        return json(res, 200, { ok: true, removed: removed, usage: await storage.usage() });
      }
      const result = await storage.clear(String(body.what || ''));
      console.log('[storage] cleared ' + String(body.what));
      return json(res, 200, { ok: true, cleared: result, usage: await storage.usage() });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.message || 'That could not be done.' });
    }
  }

  if (url.pathname !== '/api/stream') {
    json(res, 404, { ok: false, error: 'Not found.' });
    return;
  }

  /* api/stream.js reads req.query when it is present, exactly as Vercel
     hands it over, and falls back to parsing req.url when it is not. Set
     it so both hosts take the identical path through the handler. */
  req.query = Object.fromEntries(url.searchParams.entries());

  inFlight++;
  res.on('close', () => {
    inFlight--;
    const bytes = sentSoFar();
    record(bytes);
    const target = String(req.query.u || '').slice(0, 120);
    console.log([
      new Date().toISOString(),
      res.statusCode,
      (req.headers.range || '-'),
      bytes + 'B',
      (Date.now() - t0) + 'ms',
      (res.writableFinished ? 'complete' : 'aborted'),
      target
    ].join(' '));
  });

  try {
    await streamApi(req, res);
  } catch (e) {
    console.error('[stream] ' + (e && e.stack ? e.stack : e));
    if (!res.headersSent) json(res, 500, { ok: false, error: 'That stream could not be served.' });
    else res.end();
  }
});

/* A film is one long quiet response. Node's defaults are written for APIs
   that answer in milliseconds, and left alone they would cut a stream off
   at exactly the point it was working. */
server.headersTimeout = 30000;
server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 75000;

function shutdown(signal) {
  console.log('[stream] ' + signal + ', flushing usage and closing');
  flush();
  server.close(() => process.exit(0));
  /* In-flight films would otherwise hold the process open indefinitely.
     The television treats a dropped response as a rebuffer and asks for
     the range again, which the restarted process answers. */
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log('[stream] listening on http://' + HOST + ':' + PORT +
    ' (window ' + ((Number(process.env.STREAM_RANGE_WINDOW_MB) || 8)) + ' MiB)');
});
