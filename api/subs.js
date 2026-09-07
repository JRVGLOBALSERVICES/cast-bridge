/* Subtitles, in and out.
 *
 *   GET  /api/subs?u=<address>   fetch a subtitle file, convert, re-serve
 *   POST /api/subs?name=<file>   take one off the phone, convert, keep it
 *   GET  /api/subs?id=<uuid>     serve one that was kept
 *
 * Fetches a subtitle file, converts it to WebVTT, and re-serves it with the
 * cross-origin header a television needs. This exists because the Cast
 * receiver fetches the track itself, from its own address, and will take
 * only VTT served CORS-open — while the subtitle files people actually have
 * are SRTs on hosts that send no CORS header at all. Without this hop the
 * subtitle button lights up and the TV silently shows nothing.
 *
 * The POST exists because a file on the phone has no address at all, and
 * the receiver can only be handed one. Every path people are told to use —
 * OpenSubtitles, a .srt beside a downloaded film, the one a friend sent on
 * WhatsApp — ends with a file and no URL, so "paste the address of your
 * subtitles" was an instruction most subtitle files can never satisfy. The
 * converted VTT is stored once and served back at an address of its own.
 *
 * Reading is deliberately unauthenticated: the thing doing the fetching is a
 * Chromecast, which carries no session and cannot be made to. What keeps
 * that honest is that it is not a general proxy — every hop is checked
 * against private address space by safeFetch, the body is capped, and the
 * only thing it can ever emit is text/vtt built by our own parser. An
 * address that answers with something which is not subtitle-shaped is
 * refused rather than passed through.
 */

const { safeFetch, readCapped } = require('../lib/media');
const { toVtt, looksLikeSubtitles } = require('../lib/subs');
const auth = require('../lib/auth');
const db = require('../lib/db');

/* A feature-length subtitle file is around 60 KB. A megabyte is room for a
   dual-language track with formatting and still small enough that nothing
   here has to stream. */
const MAX_UPLOAD_BYTES = 1024 * 1024;

const enc = (v) => encodeURIComponent(String(v));

async function readBody(req, cap) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) throw new Error('That subtitle file is too big — the limit is 1 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fail(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    res.end();
    return;
  }

  const query = (req.query && Object.keys(req.query).length)
    ? req.query
    : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

  if (req.method === 'POST') {
    await keepUploaded(req, res, query);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'Use GET or POST.');
    return;
  }

  /* A kept file. Served by id and nothing else: there is no listing, no
     search, and no way to walk from one id to the next. */
  if (query.id) {
    await serveKept(req, res, String(query.id));
    return;
  }

  const raw = query.u;

  if (!raw) {
    fail(res, 400, 'No subtitle address given.');
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let source;
  try {
    const { res: subRes } = await safeFetch(target, 'text/vtt,application/x-subrip,text/plain,*/*;q=0.8');

    if (!subRes.ok) {
      fail(res, 502, 'That subtitle file answered ' + subRes.status + '.');
      return;
    }

    /* A host that hands back its own web page instead of the file is the
       usual shape of a dead or moved link, and it parses as zero cues.
       Say so here rather than let it read as "the file was empty". */
    const type = (subRes.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) {
      fail(res, 415, 'That address is a web page, not a subtitle file.');
      return;
    }

    source = await readCapped(subRes);
  } catch (e) {
    fail(res, 502, (e && e.message) || "That subtitle file couldn't be reached.");
    return;
  }

  if (!looksLikeSubtitles(source)) {
    fail(res, 415, "That doesn't look like a subtitle file — it needs to be .srt or .vtt.");
    return;
  }

  let converted;
  try {
    converted = toVtt(source);
  } catch (e) {
    fail(res, 422, (e && e.message) || 'That subtitle file could not be read.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('X-Subtitle-Cues', String(converted.cues));
  res.setHeader('Access-Control-Expose-Headers', 'X-Subtitle-Cues');
  /* The receiver may refetch on a seek or a reconnect; a subtitle file for
     a given address does not change under it. */
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(req.method === 'HEAD' ? undefined : converted.vtt);
};

/* POST /api/subs?name=<file name>  —  body is the subtitle file, as text.
 *
 * Kept rather than converted-and-returned, because the answer has to be an
 * ADDRESS. A television fetches its own text track; handing the phone a
 * converted string does nothing for the screen the film is actually on.
 *
 * There is no CSRF token here and it does not need one: the session cookie
 * is SameSite=Lax, which a cross-site POST does not carry, so a request
 * that reaches the guard with a session is one this app made.
 */
async function keepUploaded(req, res, query) {
  const me = await auth.guard(req, res);
  if (!me) return;

  let source;
  try {
    source = await readBody(req, MAX_UPLOAD_BYTES);
  } catch (e) {
    fail(res, 413, (e && e.message) || 'That subtitle file is too big.');
    return;
  }

  if (!source.trim()) {
    fail(res, 400, 'That file is empty.');
    return;
  }

  /* Same gate as the fetched path, and it earns its keep more here: a
     phone's file picker will happily hand over a .jpg renamed to .srt, and
     an empty track that loads cleanly is worse than a refusal. */
  if (!looksLikeSubtitles(source)) {
    fail(res, 415, "That doesn't look like a subtitle file — it needs to be .srt or .vtt.");
    return;
  }

  let converted;
  try {
    converted = toVtt(source);
  } catch (e) {
    fail(res, 422, (e && e.message) || 'That subtitle file could not be read.');
    return;
  }

  const name = String(query.name || 'Subtitles').slice(0, 120) || 'Subtitles';

  /* Take the caller's own expired rows out on the way past. There is no
     cron on this app and a subtitle nobody can reach is not worth a
     scheduled job — the person adding a new one is the only visitor the
     table reliably gets. Scoped to them, so it can never touch anyone
     else's, and a failure here must not lose the file being added. */
  try {
    await db.remove('subtitles?user_id=eq.' + enc(me.id) + '&expires_at=lt.' + enc(new Date().toISOString()));
  } catch (e) { /* housekeeping is never worth failing an upload over */ }

  let made;
  try {
    made = await db.insert('subtitles?select=id,name,cues,expires_at', {
      user_id: me.id, // never anything the browser sent
      name,
      vtt: converted.vtt,
      cues: converted.cues
    });
  } catch (e) {
    fail(res, e.status || 502, e.message || 'That subtitle file could not be kept.');
    return;
  }

  const row = Array.isArray(made) ? made[0] : made;
  if (!row || !row.id) {
    fail(res, 502, 'That subtitle file could not be kept.');
    return;
  }

  res.statusCode = 201;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    ok: true,
    id: row.id,
    url: '/api/subs?id=' + encodeURIComponent(row.id),
    name: row.name,
    cues: row.cues,
    expires: row.expires_at
  }));
}

/* GET /api/subs?id=<uuid>
 *
 * Unauthenticated, like the ?u= path and for the same reason: the fetch
 * comes from a Chromecast, which carries no session and cannot be made to.
 * The id IS the credential — a random uuid, nothing else about the row
 * guessable, no listing endpoint and no way to walk from one to the next.
 * The screen that creates one says so in those words.
 */
async function serveKept(req, res, id) {
  /* Checked before it reaches the database, so a malformed id is a 400 here
     rather than a PostgREST type error surfacing as "the store is down". */
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    fail(res, 400, 'That is not a subtitle id.');
    return;
  }

  let rows;
  try {
    rows = await db.select('subtitles?select=vtt,name,cues,expires_at&id=eq.' + enc(id) + '&limit=1');
  } catch (e) {
    fail(res, e.status || 502, e.message || 'That subtitle file could not be read.');
    return;
  }

  const row = rows && rows[0];
  if (!row) {
    fail(res, 404, 'That subtitle file is gone.');
    return;
  }

  /* Expiry is enforced on read as well as swept on write. The sweep only
     runs when somebody uploads, so without this a file could outlive its
     date by however long it takes the next person to add one. */
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    fail(res, 410, 'That subtitle file has expired.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('X-Subtitle-Cues', String(row.cues || 0));
  res.setHeader('Access-Control-Expose-Headers', 'X-Subtitle-Cues');
  /* Private, because the address is the credential — a shared cache in
     front of this would be handing one person's file to the next asker. */
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(req.method === 'HEAD' ? undefined : row.vtt);
}
