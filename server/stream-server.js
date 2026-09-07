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
const path = require('path');

const streamApi = require('../api/stream.js');

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const sentSoFar = meter(res);
  const t0 = Date.now();

  if (url.pathname === '/healthz') {
    const day = today();
    const month = day.slice(0, 7);
    let monthBytes = 0;
    for (const d of Object.keys(usage)) if (d.startsWith(month)) monthBytes += usage[d];
    json(res, 200, {
      ok: true,
      uptime_s: Math.round((Date.now() - started) / 1000),
      in_flight: inFlight,
      window_mb: Number(process.env.STREAM_RANGE_WINDOW_MB) || 8,
      served_today_gb: gb(usage[day] || 0),
      served_this_month_gb: gb(monthBytes)
    });
    return;
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
