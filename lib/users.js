/* Accounts for Cast Bridge.
 *
 * The app used to have a single shared password in an env var. That is why
 * signing in with a username never worked — there was no username. This is
 * the replacement: real rows, one admin, per-user history.
 *
 * Passwords are hashed with scrypt from node's own crypto. No dependency, and
 * the cost parameters are stored alongside the hash so they can be raised
 * later without invalidating the accounts already created.
 */

const crypto = require('crypto');
const db = require('./db');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(
      password, salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 },
      (err, key) => {
        if (err) return reject(err);
        resolve([
          'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
          salt.toString('base64url'), key.toString('base64url')
        ].join('$'));
      }
    );
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (typeof password !== 'string' || typeof stored !== 'string') return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);

    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    if (!N || !r || !p) return resolve(false);

    let salt, expected;
    try {
      salt = Buffer.from(parts[4], 'base64url');
      expected = Buffer.from(parts[5], 'base64url');
    } catch (e) { return resolve(false); }

    crypto.scrypt(
      password, salt, expected.length,
      { N, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => {
        if (err) return resolve(false);
        /* Lengths already match by construction, but timingSafeEqual throws
           on a mismatch rather than returning false, so guard it. */
        if (key.length !== expected.length) return resolve(false);
        resolve(crypto.timingSafeEqual(key, expected));
      }
    );
  });
}

/* PostgREST needs the value percent-encoded inside the filter, and a username
   is user-controlled, so never interpolate it raw. */
function enc(v) {
  return encodeURIComponent(String(v));
}

/* One spelling of a username, everywhere.
 *
 * This used to look accounts up with PostgREST's `ilike`, which was a real
 * hole rather than a style problem: `%` and `_` are wildcards to `ilike`, and
 * the username pattern is only enforced when an account is CREATED, never
 * when someone signs in. So `rjnfli%` matched `rjnflix1` and, with that
 * account's password, signed the caller in as the owner. Verified against a
 * live server before this fix, and again after.
 *
 * `eq.` on a lowercased value is exact. Case-insensitive sign-in survives
 * because the stored value is lowercased too, not because the query is fuzzy. */
function normalize(username) {
  if (typeof username !== 'string') return '';
  return username.trim().toLowerCase();
}

const COLUMNS = 'id,username,role,active,created_at,created_by,last_seen_at';

async function byUsername(username) {
  const clean = normalize(username);
  if (!clean) return null;
  const rows = await db.select(
    'users?select=' + COLUMNS + ',password_hash' +
    '&username=eq.' + enc(clean) + '&limit=1'
  );
  return (rows && rows[0]) || null;
}

async function byId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const rows = await db.select('users?select=' + COLUMNS + '&id=eq.' + enc(id) + '&limit=1');
  return (rows && rows[0]) || null;
}

async function list() {
  return (await db.select(
    'users?select=' + COLUMNS + '&order=role.asc,username.asc'
  )) || [];
}

async function count() {
  const rows = await db.select('users?select=id&limit=1000');
  return rows ? rows.length : 0;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return 'A username is 3-32 characters, letters, numbers, dot, dash or underscore.';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return 'A password needs at least ' + MIN_PASSWORD + ' characters.';
  }
  return null;
}

async function create({ username, password, role, createdBy }) {
  const uErr = validateUsername(username);
  if (uErr) throw Object.assign(new Error(uErr), { status: 400 });
  const pErr = validatePassword(password);
  if (pErr) throw Object.assign(new Error(pErr), { status: 400 });

  const clean = normalize(username);
  if (await byUsername(clean)) {
    throw Object.assign(new Error('That username is taken.'), { status: 409 });
  }

  const row = {
    username: clean,
    password_hash: await hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    active: true
  };
  if (createdBy) row.created_by = createdBy;

  const made = await db.insert('users?select=' + COLUMNS, row);
  return Array.isArray(made) ? made[0] : made;
}

async function setPassword(id, password) {
  const pErr = validatePassword(password);
  if (pErr) throw Object.assign(new Error(pErr), { status: 400 });
  const patched = await db.update(
    'users?id=eq.' + enc(id) + '&select=' + COLUMNS,
    { password_hash: await hashPassword(password) }
  );
  return Array.isArray(patched) ? patched[0] : patched;
}

async function setActive(id, active) {
  const patched = await db.update(
    'users?id=eq.' + enc(id) + '&select=' + COLUMNS,
    { active: Boolean(active) }
  );
  return Array.isArray(patched) ? patched[0] : patched;
}

async function destroy(id) {
  return db.remove('users?id=eq.' + enc(id) + '&select=' + COLUMNS);
}

async function touch(id) {
  try {
    await db.update('users?id=eq.' + enc(id), { last_seen_at: new Date().toISOString() });
  } catch (e) { /* a missing heartbeat must never fail a sign-in */ }
}

/* Sign-in returns the row only when the password matches AND the account is
   active. A disabled account gets the same generic message as a wrong
   password, so the form can't be used to enumerate who exists. */
async function authenticate(username, password) {
  const row = await byUsername(username);
  if (!row) {
    /* Spend the time anyway. Returning instantly on an unknown username
       tells an attacker which names are real. */
    await verifyPassword(String(password || ''), 'scrypt$16384$8$1$AAAA$AAAA');
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok || !row.active) return null;
  delete row.password_hash;
  return row;
}

/* Bootstrap. Runs on any sign-in attempt while the table is empty, so a fresh
   deploy has an owner without a console step. The credentials come from env,
   never from the request — otherwise the first person to hit the URL owns it. */
async function ensureSeedAdmin() {
  const username = process.env.CAST_ADMIN_USER;
  const password = process.env.CAST_ADMIN_PASSWORD;
  if (!username || !password) return { seeded: false, reason: 'no-env' };

  const existing = await byUsername(username);
  if (existing) {
    /* Keep the env the source of truth for the owner's password, so a
       forgotten password is fixed by editing one project setting. */
    if (!(await verifyPassword(password, existing.password_hash))) {
      await setPassword(existing.id, password);
      return { seeded: false, reset: true };
    }
    if (existing.role !== 'admin' || !existing.active) {
      await db.update('users?id=eq.' + enc(existing.id), { role: 'admin', active: true });
      return { seeded: false, promoted: true };
    }
    return { seeded: false, reason: 'exists' };
  }

  await create({ username, password, role: 'admin' });
  return { seeded: true };
}

module.exports = {
  COLUMNS, MIN_PASSWORD, USERNAME_RE,
  hashPassword, verifyPassword, validateUsername, validatePassword, normalize,
  byUsername, byId, list, count, create, setPassword, setActive, destroy,
  touch, authenticate, ensureSeedAdmin
};
