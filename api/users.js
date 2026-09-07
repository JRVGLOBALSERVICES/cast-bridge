/* Account management. Admin only, all of it.
 *
 *   GET    /api/users                  -> every account
 *   POST   /api/users                  -> { username, password, role } creates one
 *   PATCH  /api/users?id=<uuid>        -> { password } or { active }
 *   DELETE /api/users?id=<uuid>        -> removes the account and its history
 *
 * The owner is the only role that reaches any of this. A normal user asking
 * for the list gets a 403, not a filtered list — a filtered list would say
 * "the endpoint is yours, there is just nothing in it", which is a different
 * and untrue thing.
 */

const auth = require('../lib/auth');
const users = require('../lib/users');

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

function fail(res, status, error) {
  res.statusCode = status;
  res.end(JSON.stringify({ ok: false, error }));
}

function queryId(req) {
  if (req.query && req.query.id) return String(req.query.id);
  try {
    return new URL(req.url, 'http://x').searchParams.get('id') || '';
  } catch (e) {
    return '';
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const me = await auth.guardAdmin(req, res);
  if (!me) return;

  try {
    if (req.method === 'GET') {
      const rows = await users.list();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, users: rows, me: me.id }));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const made = await users.create({
        username: body.username,
        password: body.password,
        role: body.role,
        createdBy: me.id
      });
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, user: made }));
      return;
    }

    const id = queryId(req);

    if (req.method === 'PATCH') {
      if (!id) return fail(res, 400, 'Which account?');
      const target = await users.byId(id);
      if (!target) return fail(res, 404, 'No such account.');

      const body = await readJson(req);

      if (typeof body.password === 'string') {
        const row = await users.setPassword(id, body.password);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, user: row }));
        return;
      }

      if (typeof body.active === 'boolean') {
        /* Locking yourself out is a one-way door on a single-owner app: no
           other admin exists to let you back in. */
        if (id === me.id && body.active === false) {
          return fail(res, 400, 'You cannot switch off your own account.');
        }
        const row = await users.setActive(id, body.active);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, user: row }));
        return;
      }

      return fail(res, 400, 'Send a password or an active flag.');
    }

    if (req.method === 'DELETE') {
      if (!id) return fail(res, 400, 'Which account?');
      if (id === me.id) return fail(res, 400, 'You cannot delete your own account.');

      const target = await users.byId(id);
      if (!target) return fail(res, 404, 'No such account.');

      await users.destroy(id); // history rows cascade
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, deleted: target.username }));
      return;
    }

    return fail(res, 405, 'Use GET, POST, PATCH or DELETE.');
  } catch (e) {
    return fail(res, e.status || 502, e.message || 'That did not work.');
  }
};
