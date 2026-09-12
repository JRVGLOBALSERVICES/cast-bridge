/* Watch history, scoped to whoever is asking.
 *
 *   GET    /api/history                -> your own, newest first
 *   GET    /api/history?scope=all      -> owner only: everyone's, with names
 *   POST   /api/history                -> { url, title, kind } records one
 *   DELETE /api/history?id=<uuid>      -> removes one of yours
 *   DELETE /api/history?url=<address>  -> removes one of yours, found by url
 *   DELETE /api/history?all=1          -> clears yours
 *
 * The url form exists because the browser's own history cache keys on the
 * address, not on this table's uuid — a row it learned about offline has no
 * server id to send. Deleting by url is scoped to the caller exactly as the
 * id form is, so it widens nothing.
 *
 * The isolation rule lives here and only here: a normal user's query is
 * always pinned to their own id, taken from the signed session, never from
 * anything the browser sent. There is no parameter a user can pass to widen
 * their own scope — `scope=all` is checked against the role, not the request.
 */

const auth = require('../lib/auth');
const db = require('../lib/db');

const LIMIT = 200;

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 8192) throw new Error('Too much data.');
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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const me = await auth.guard(req, res);
  if (!me) return;

  const q = params(req);

  try {
    if (req.method === 'GET') {
      const wantsAll = q.scope === 'all' || q.user;
      const isOwner = me.role === 'admin';

      if (wantsAll && !isOwner) {
        return fail(res, 403, 'You can only see your own history.');
      }

      let path;
      if (isOwner && q.user) {
        path = 'history?select=id,url,title,kind,page,created_at,user_id' +
               '&user_id=eq.' + enc(q.user) +
               '&order=created_at.desc&limit=' + LIMIT;
      } else if (isOwner && wantsAll) {
        /* The embedded users(username) is what makes the owner's view
           readable — a screen of raw uuids explains nothing. */
        path = 'history?select=id,url,title,kind,page,created_at,user_id,users(username)' +
               '&order=created_at.desc&limit=' + LIMIT;
      } else {
        path = 'history?select=id,url,title,kind,page,created_at' +
               '&user_id=eq.' + enc(me.id) +
               '&order=created_at.desc&limit=' + LIMIT;
      }

      const rows = (await db.select(path)) || [];
      const items = rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        kind: r.kind,
        page: r.page || null,
        at: r.created_at,
        who: r.users ? r.users.username : undefined
      }));

      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true,
        scope: wantsAll ? 'all' : 'mine',
        canSeeAll: isOwner,
        items
      }));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return fail(res, 400, 'That is not a link this app can record.');
      }

      const row = {
        user_id: me.id, // never body.user_id
        url: url.slice(0, 4000),
        title: body.title ? String(body.title).slice(0, 300) : null,
        kind: body.kind ? String(body.kind).slice(0, 40) : null,
        /* The page the video was found on (db/006). http(s) only: it is
           rendered as a link. */
        page: /^https?:\/\//i.test(String(body.page || '')) ? String(body.page).slice(0, 4000) : null
      };

      /* Re-watching something should move it up the list, not add a second
         row, so drop any earlier copy of the same url for this user first. */
      try {
        await db.remove('history?user_id=eq.' + enc(me.id) + '&url=eq.' + enc(url));
      } catch (e) { /* a failed de-dupe must not lose the new entry */ }

      const made = await db.insert('history?select=id,url,title,kind,page,created_at', row);
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, item: Array.isArray(made) ? made[0] : made }));
      return;
    }

    if (req.method === 'DELETE') {
      if (q.all) {
        await db.remove('history?user_id=eq.' + enc(me.id));
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, cleared: true }));
        return;
      }
      if (q.url) {
        const gone = await db.remove(
          'history?user_id=eq.' + enc(me.id) + '&url=eq.' + enc(String(q.url)) + '&select=id'
        );
        if (!gone || !gone.length) return fail(res, 404, 'That item is not in your history.');
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, deleted: gone.length }));
        return;
      }

      if (!q.id) return fail(res, 400, 'Which item?');

      /* The user_id filter is the authorisation. Without it, an id from
         someone else's list would delete someone else's row. */
      const gone = await db.remove(
        'history?id=eq.' + enc(q.id) + '&user_id=eq.' + enc(me.id) + '&select=id'
      );
      if (!gone || !gone.length) return fail(res, 404, 'That item is not in your history.');

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, deleted: q.id }));
      return;
    }

    return fail(res, 405, 'Use GET, POST or DELETE.');
  } catch (e) {
    return fail(res, e.status || 502, e.message || 'That did not work.');
  }
};
