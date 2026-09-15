/* Cast logs, one per film played, scoped to whoever is asking.
 *
 *   POST /api/castlog                 -> { session, title, url, page, device,
 *                                          build, lines: [{at,line,detail,pos}] }
 *                                        appends to that session's row
 *   GET  /api/castlog                 -> your own, newest first, no lines
 *   GET  /api/castlog?scope=all       -> owner only: everyone's, with names
 *   GET  /api/castlog?user=<uuid>     -> owner only: one person's
 *   GET  /api/castlog?id=<uuid>       -> one log with every line (yours, or
 *                                        anyone's for the owner)
 *
 * Same isolation rule as /api/history: user_id always comes from the signed
 * session, and `scope=all` is checked against the role, not the request.
 *
 * POST also accepts text/plain, because navigator.sendBeacon on pagehide can
 * only send a body without a preflight — and pagehide is exactly when the last
 * lines of a failing cast are still sitting on the phone.
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const castlog = require('../lib/castlog');

const LIST_LIMIT = 150;
const KEEP_DAYS = 60;

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 256 * 1024) throw Object.assign(new Error('Too much data.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw Object.assign(new Error('That request was not readable.'), { status: 400 });
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
const UUID = /^[0-9a-f-]{36}$/i;
const LIST_COLS = 'id,session,title,url,page,device,build,line_count,problems,started_at,updated_at';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const me = await auth.guard(req, res);
  if (!me) return;

  const q = params(req);
  const isOwner = me.role === 'admin';

  try {
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!castlog.validSession(body.session)) return fail(res, 400, 'Which cast is this?');
      const { lines, problems } = castlog.shape(body.lines);
      if (!lines.length) return fail(res, 400, 'Nothing to record.');

      const id = await db.request('POST', 'rpc/cast_log_append', {
        body: {
          p_user: me.id, // never body.user_id
          p_session: body.session,
          p_title: castlog.clip(body.title, 300),
          p_url: castlog.clip(body.url, 4000),
          p_page: /^https?:\/\//i.test(String(body.page || '')) ? castlog.clip(body.page, 4000) : null,
          p_device: castlog.clip(body.device, 120),
          p_agent: castlog.clip(req.headers['user-agent'], 300),
          p_build: castlog.clip(body.build, 60),
          p_lines: lines,
          p_problems: problems
        }
      });

      /* Retention without a cron: roughly one write in fifty sweeps old rows.
         Failure is ignored — a missed sweep only means a slightly longer log. */
      if (Math.random() < 0.02) {
        const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
        db.remove('cast_logs?updated_at=lt.' + enc(cutoff) + '&select=id').catch(() => {});
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, id, stored: lines.length }));
      return;
    }

    if (req.method === 'GET') {
      if (q.id) {
        if (!UUID.test(String(q.id))) return fail(res, 400, 'Which log?');
        /* The user_id filter is the authorisation for everyone but the owner. */
        const path = 'cast_logs?select=' + LIST_COLS + ',agent,lines,user_id,users(username)' +
          '&id=eq.' + enc(q.id) + (isOwner ? '' : '&user_id=eq.' + enc(me.id));
        const rows = (await db.select(path)) || [];
        if (!rows.length) return fail(res, 404, 'That log is not yours or no longer kept.');
        const r = rows[0];
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, log: Object.assign({}, r, {
          who: r.users ? r.users.username : undefined, users: undefined
        }) }));
        return;
      }

      const wantsAll = q.scope === 'all' || q.user;
      if (wantsAll && !isOwner) return fail(res, 403, 'You can only see your own cast logs.');

      let path = 'cast_logs?select=' + LIST_COLS + (isOwner ? ',user_id,users(username)' : '');
      if (isOwner && q.user && UUID.test(String(q.user))) path += '&user_id=eq.' + enc(q.user);
      else if (!(isOwner && wantsAll)) path += '&user_id=eq.' + enc(me.id);
      if (q.problems) path += '&problems=gt.0';
      path += '&order=updated_at.desc&limit=' + LIST_LIMIT;

      const rows = (await db.select(path)) || [];
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true,
        scope: wantsAll ? 'all' : 'mine',
        canSeeAll: isOwner,
        items: rows.map((r) => Object.assign({}, r, {
          who: r.users ? r.users.username : undefined, users: undefined
        }))
      }));
      return;
    }

    return fail(res, 405, 'Use GET or POST.');
  } catch (e) {
    return fail(res, e.status || 502, e.message || 'That did not work.');
  }
};
