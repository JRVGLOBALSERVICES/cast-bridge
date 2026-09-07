/* PostgREST client for the `castbridge` schema.
 *
 * There is no Supabase SDK here on purpose: one `fetch` against PostgREST is
 * the whole surface this app needs, and a dependency-free lib keeps the
 * serverless cold start honest.
 *
 * Every call uses the service-role key, so it bypasses RLS. That is the
 * design: both tables are RLS-deny-all, the anon key can read nothing, and
 * "which rows may this person see" is decided in the API layer by the signed
 * session — never by a query the browser gets to write.
 */

const SCHEMA = 'castbridge';

function config() {
  const url = process.env.CAST_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.CAST_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function configured() {
  return config() !== null;
}

/* A distinct error type so a handler can tell "the store is down" (503, and
   not the caller's fault) apart from "you sent something wrong" (400). */
class DbError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DbError';
    this.status = status || 502;
  }
}

async function request(method, path, { body, prefer, headers } = {}) {
  const cfg = config();
  if (!cfg) throw new DbError('The user store is not configured.', 503);

  const h = {
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Accept-Profile': SCHEMA,
    'Content-Profile': SCHEMA,
    'Content-Type': 'application/json',
    ...(headers || {})
  };
  if (prefer) h.Prefer = prefer;

  let res;
  try {
    res = await fetch(cfg.url + '/rest/v1/' + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    throw new DbError('Could not reach the user store.', 503);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.message || j.hint || detail;
    } catch (e) { /* keep the raw text */ }
    throw new DbError(detail || ('Store returned ' + res.status), res.status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

const select = (path) => request('GET', path);
const insert = (table, row) =>
  request('POST', table, { body: row, prefer: 'return=representation' });
const update = (path, patch) =>
  request('PATCH', path, { body: patch, prefer: 'return=representation' });
const remove = (path) => request('DELETE', path, { prefer: 'return=representation' });

module.exports = { SCHEMA, configured, DbError, request, select, insert, update, remove };
