/* TV mode — the mailbox between a phone and a browser on the television.
 *
 * POST, JSON, one `action` per request:
 *
 *   create        TV   → { code, tvKey }          a fresh pairing code
 *   poll          TV   { code, tvKey, since, status } → { commands, seq, paired }
 *   pair          phone (signed in) { code }  → { phoneKey }
 *   send          phone { code, phoneKey, command } → { seq }
 *   status        phone { code, phoneKey } → { status, online }
 *   unpair        phone { code, phoneKey }
 *
 * The TV carries no session and cannot be given one, same as /api/stream.
 * What stands in for it is the key it was handed at create, stored hashed.
 * Pairing is the one step that needs an account: a code on a TV screen is
 * readable by anyone in the room, and "anyone in the room who is also signed
 * in to Cast Bridge" is the right bar for driving that TV.
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const tv = require('../lib/tv');

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 16384) throw new tv.InvalidTv('Too much data.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new tv.InvalidTv('That request was not readable.');
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

const enc = (v) => encodeURIComponent(String(v));
const first = (rows) => (Array.isArray(rows) ? rows[0] : rows) || null;

/* Gone is its own answer, not a generic 401: the TV's reaction to it is to
   ask for a new code, and the phone's is to say the TV is no longer there. */
const GONE = { ok: false, gone: true, error: 'That TV is no longer paired. Check the code on the TV.' };

async function create(res) {
  /* Sweep on the way in. Nothing else would ever delete a room whose TV was
     switched off at the wall, and create is rare enough to carry it. */
  const cutoff = new Date(Date.now() - tv.ROOM_TTL_MS).toISOString();
  db.remove('tv_rooms?tv_seen_at=lt.' + enc(cutoff)).catch(() => {});

  const tvKey = tv.makeKey();
  for (let i = 0; i < 6; i++) {
    const code = tv.makeCode();
    try {
      await db.insert('tv_rooms', { code, tv_hash: tv.hash(tvKey) });
      return send(res, 200, { ok: true, code, tvKey });
    } catch (e) {
      /* 409 is a code another TV holds. Try another; anything else is real. */
      if (!(e instanceof db.DbError) || e.status !== 409) throw e;
    }
  }
  return send(res, 503, { ok: false, error: 'Could not find a free code. Try again.' });
}

async function poll(res, body) {
  if (!tv.validCode(body.code) || !tv.validKey(body.tvKey)) return send(res, 404, GONE);
  const since = Math.max(0, Math.floor(Number(body.since) || 0));
  const patch = { tv_seen_at: new Date().toISOString() };
  const status = tv.shapeStatus(body.status);
  if (status) patch.status = status;

  /* One round trip: the key match is in the filter, so a wrong key updates
     nothing and returns nothing. */
  const row = first(await db.update(
    'tv_rooms?code=eq.' + enc(body.code) + '&tv_hash=eq.' + tv.hash(body.tvKey) +
      '&select=commands,seq,phone_hash',
    patch
  ));
  if (!row) return send(res, 404, GONE);
  return send(res, 200, {
    ok: true,
    seq: row.seq,
    paired: !!row.phone_hash,
    commands: tv.pending(row.commands, since)
  });
}

async function pair(req, res, body) {
  const me = await auth.guard(req, res);
  if (!me) return;
  const code = String(body.code || '').replace(/\D/g, '');
  if (!tv.validCode(code)) return send(res, 400, { ok: false, error: 'The code is six digits.' });

  const row = first(await db.select('tv_rooms?select=code,tv_seen_at&code=eq.' + enc(code) + '&limit=1'));
  /* A code nobody is showing is refused, even if the row still exists: the
     person pairing should be looking at the TV that is going to play. */
  if (!row || !tv.fresh(row.tv_seen_at)) {
    return send(res, 404, { ok: false, error: 'No TV is showing that code. Open the TV page and check the number.' });
  }

  const phoneKey = tv.makeKey();
  await db.update('tv_rooms?code=eq.' + enc(code), {
    phone_hash: tv.hash(phoneKey),
    user_id: me.id,
    phone_seen_at: new Date().toISOString()
  });
  return send(res, 200, { ok: true, code, phoneKey });
}

function phoneFilter(body) {
  return 'tv_rooms?code=eq.' + enc(body.code) + '&phone_hash=eq.' + tv.hash(body.phoneKey);
}

async function sendCommand(res, body) {
  if (!tv.validCode(body.code) || !tv.validKey(body.phoneKey)) return send(res, 404, GONE);
  const command = tv.shapeCommand(body.command);

  /* Optimistic: the update only lands if seq is still what was read. Two
     taps racing each other retry rather than one overwriting the other. */
  for (let i = 0; i < 4; i++) {
    const row = first(await db.select(phoneFilter(body) + '&select=commands,seq&limit=1'));
    if (!row) return send(res, 404, GONE);
    const next = tv.append(row.commands, row.seq, command);
    const done = first(await db.update(
      phoneFilter(body) + '&seq=eq.' + row.seq + '&select=seq',
      { commands: next.commands, seq: next.seq, phone_seen_at: new Date().toISOString() }
    ));
    if (done) return send(res, 200, { ok: true, seq: done.seq });
  }
  return send(res, 409, { ok: false, error: 'The TV was busy. Tap again.' });
}

async function status(res, body) {
  if (!tv.validCode(body.code) || !tv.validKey(body.phoneKey)) return send(res, 404, GONE);
  const row = first(await db.update(
    phoneFilter(body) + '&select=status,seq,tv_seen_at',
    { phone_seen_at: new Date().toISOString() }
  ));
  if (!row) return send(res, 404, GONE);
  return send(res, 200, {
    ok: true,
    online: tv.fresh(row.tv_seen_at),
    seq: row.seq,
    status: row.status || null
  });
}

async function unpair(res, body) {
  if (!tv.validCode(body.code) || !tv.validKey(body.phoneKey)) return send(res, 200, { ok: true });
  await db.update(phoneFilter(body), { phone_hash: null, user_id: null });
  return send(res, 200, { ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'Use POST.' });
  }

  try {
    const body = await readJson(req);
    switch (body.action) {
      case 'create': return await create(res);
      case 'poll': return await poll(res, body);
      case 'pair': return await pair(req, res, body);
      case 'send': return await sendCommand(res, body);
      case 'status': return await status(res, body);
      case 'unpair': return await unpair(res, body);
      default: return send(res, 400, { ok: false, error: 'Unknown action.' });
    }
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof tv.InvalidTv) return send(res, 400, { ok: false, error: e.message });
    if (e instanceof db.DbError) return send(res, e.status >= 500 ? e.status : 502, { ok: false, error: e.message });
    return send(res, 500, { ok: false, error: 'Something went wrong talking to the TV.' });
  }
};
