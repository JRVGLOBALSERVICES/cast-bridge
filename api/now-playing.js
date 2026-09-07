/* The session that survives the app being closed.
 *
 *   GET    /api/now-playing   -> your live session, or null
 *   PUT    /api/now-playing   -> heartbeat: what is on, where it got to
 *   DELETE /api/now-playing   -> the session ended; forget it
 *
 * Why this exists: a Cast session lives inside the page. Everything the app
 * knew about what was playing lived in two page-scoped variables, so closing
 * the app forgot the film while the television carried on showing it. The
 * SDK would even rejoin the session on the next open — and the app had
 * nothing left to label it with.
 *
 * One row per person, overwritten. This is not a second history: `history` is
 * the record of what was watched, this is the one row saying what is
 * happening now, and when a session ends the row goes and the history row is
 * what remains.
 *
 * Same isolation rule as api/history.js and api/series.js, and it lives here
 * for the same reason: the row is pinned to the id in the signed session,
 * never to anything the browser sent. There is no scope parameter — what
 * somebody has on their television right now is not a thing this app offers a
 * cross-account view of, not even to the owner.
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const np = require('../lib/nowplaying');

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    /* A heartbeat is a few hundred bytes. 16 KB is generous for it and short
       of anything worth storing. */
    if (total > 16384) throw new np.InvalidSession('Too much data.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new np.InvalidSession('That request was not readable.');
  }
}

function fail(res, status, error) {
  res.statusCode = status;
  res.end(JSON.stringify({ ok: false, error }));
}

const enc = (v) => encodeURIComponent(String(v));

const COLS = 'user_id,url,title,device,position,duration,state,subs_id,subs_name,started_at,updated_at';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const me = await auth.guard(req, res);
  if (!me) return;

  try {
    if (req.method === 'GET') {
      const rows = await db.select(
        'now_playing?select=' + COLS + '&user_id=eq.' + enc(me.id) + '&limit=1'
      );
      const row = Array.isArray(rows) ? rows[0] : null;

      /* present() returns null for a row too old to say anything honest
         about. The row is left in place rather than deleted — deciding it is
         stale is a read-time judgement, and a phone that was in a lift for an
         hour should not have had its session destroyed by a page load. */
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, session: np.present(row) }));
      return;
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJson(req);
      const shaped = np.shape(body);

      const now = new Date().toISOString();
      const row = { user_id: me.id, ...shaped, updated_at: now };

      /* started_at is set only when the film changes. A heartbeat for the
         same address must not keep resetting it, or "started 40 minutes ago"
         becomes "started 15 seconds ago" forever and the row can never say
         how long something has been on. */
      const prior = await db.select(
        'now_playing?select=url,started_at&user_id=eq.' + enc(me.id) + '&limit=1'
      );
      const before = Array.isArray(prior) ? prior[0] : null;
      row.started_at = before && before.url === shaped.url && before.started_at
        ? before.started_at
        : now;

      /* Upserted against the primary key. One row per person: a second phone
         picking up the same session is the same person, and last write wins
         rather than a second row appearing that nothing will ever clear. */
      const made = await db.request('POST', 'now_playing?on_conflict=user_id&select=' + COLS, {
        body: row,
        prefer: 'resolution=merge-duplicates,return=representation'
      });

      const saved = Array.isArray(made) ? made[0] : made;
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, session: np.present(saved) }));
      return;
    }

    if (req.method === 'DELETE') {
      await db.remove('now_playing?user_id=eq.' + enc(me.id));
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, cleared: true }));
      return;
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return fail(res, 405, 'That method is not allowed here.');
  } catch (e) {
    if (e instanceof np.InvalidSession) return fail(res, 400, e.message);
    if (e instanceof db.DbError) return fail(res, e.status, e.message);
    return fail(res, 500, 'Something went wrong remembering that.');
  }
};
