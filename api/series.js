/* Remembered series pages — the season indexes you have opened.
 *
 *   GET    /api/series               -> yours, most recently opened first
 *   POST   /api/series               -> { url, title, host, episodes } remembers one
 *   DELETE /api/series?id=<uuid>     -> forgets one of yours
 *   DELETE /api/series?all=1         -> forgets all of yours
 *
 * This exists because a crawl is expensive and a season does not change
 * between Tuesday and Wednesday. Opening a remembered series paints the list
 * it found last time immediately and re-crawls behind it, so tomorrow costs
 * nothing to look at and is still up to date a few seconds later.
 *
 * Same isolation rule as api/history.js, and it lives here for the same
 * reason: the query is pinned to the id inside the signed session, never to
 * anything the browser sent. There is no scope parameter on this one at all —
 * not even for the owner. What somebody is part-way through watching is a
 * different kind of fact from a play they made, and nothing in this app needs
 * a cross-account view of it.
 */

const auth = require('../lib/auth');
const db = require('../lib/db');

const LIMIT = 100;
/* How much of a crawl is kept. The list is a CACHE, not the record — a
   season with more children than this still crawls in full, it just paints
   from a shorter memory while it does. */
const MAX_EPISODES = 400;
/* A long query string is legitimate; a two-kilobyte one is a tracking
   parameter. Capped well under the btree limit on the unique index that
   makes the upsert work at all. */
const MAX_URL = 1000;

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    /* An episode list is the bulk of this body: 400 rows of url plus title.
       128 KB is roomy for that and far short of anything worth storing. */
    if (total > 131072) throw new Error('That is more than a season.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new Error('That request was not readable.');
  }
}

function params(req) {
  if (req.query) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  } catch (e) {
    return {};
  }
}

function fail(res, status, error) {
  res.statusCode = status;
  res.end(JSON.stringify({ ok: false, error }));
}

const enc = (v) => encodeURIComponent(String(v));

/* Only the four fields the list draws from. Storing the crawl's own rows
   verbatim would put its scores and shapes in the database, where they would
   be read back one day as if they meant something about today's page. */
function tidyEpisodes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const e of input) {
    if (!e || typeof e.url !== 'string' || !/^https?:\/\//i.test(e.url)) continue;
    out.push({
      url: e.url.slice(0, MAX_URL),
      title: e.title ? String(e.title).slice(0, 200) : null,
      num: typeof e.num === 'number' && isFinite(e.num) ? e.num : null,
      season: typeof e.season === 'number' && isFinite(e.season) ? e.season : null
    });
    if (out.length >= MAX_EPISODES) break;
  }
  return out;
}

function shape(r) {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    host: r.host,
    episodes: Array.isArray(r.episodes) ? r.episodes : [],
    at: r.last_seen_at,
    first: r.created_at
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const me = await auth.guard(req, res);
  if (!me) return;

  const q = params(req);

  try {
    if (req.method === 'GET') {
      const rows = (await db.select(
        'series?select=id,url,title,host,episodes,created_at,last_seen_at' +
        '&user_id=eq.' + enc(me.id) +
        '&order=last_seen_at.desc&limit=' + LIMIT
      )) || [];
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, items: rows.map(shape) }));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return fail(res, 400, 'That is not a page this app can remember.');
      }
      if (url.length > MAX_URL) {
        return fail(res, 400, 'That address is too long to remember.');
      }

      let host = body.host ? String(body.host).slice(0, 200) : null;
      if (!host) {
        try { host = new URL(url).host.replace(/^www\./, ''); } catch (e) { host = null; }
      }

      const row = {
        user_id: me.id, // never body.user_id
        url,
        title: body.title ? String(body.title).slice(0, 300) : null,
        host,
        episodes: tidyEpisodes(body.episodes),
        last_seen_at: new Date().toISOString()
      };

      /* Upserted rather than inserted, against the unique index on
         (user_id, url). Opening the same season next week must move the row
         up the list and refresh its episodes, not add a second copy of it —
         which is exactly what a plain insert would do, quietly, until the
         screen showed the same show four times. */
      const made = await db.request('POST', 'series?on_conflict=user_id,url&select=' +
        'id,url,title,host,episodes,created_at,last_seen_at', {
        body: row,
        prefer: 'resolution=merge-duplicates,return=representation'
      });

      const saved = Array.isArray(made) ? made[0] : made;
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, item: saved ? shape(saved) : null }));
      return;
    }

    if (req.method === 'DELETE') {
      if (q.all) {
        await db.remove('series?user_id=eq.' + enc(me.id));
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, cleared: true }));
        return;
      }
      if (!q.id) return fail(res, 400, 'Which one?');

      /* The user_id filter is the authorisation, exactly as in
         api/history.js. Without it an id from anywhere would delete a row
         belonging to anyone. */
      const gone = await db.remove(
        'series?id=eq.' + enc(q.id) + '&user_id=eq.' + enc(me.id) + '&select=id'
      );
      if (!gone || !gone.length) return fail(res, 404, 'That is not one of yours.');

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, deleted: q.id }));
      return;
    }

    return fail(res, 405, 'Use GET, POST or DELETE.');
  } catch (e) {
    return fail(res, e.status || 502, e.message || 'That did not work.');
  }
};
