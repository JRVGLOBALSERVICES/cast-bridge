/* TV mode — the rules, without the database.
 *
 * A browser on the television opens /tv and plays what a paired phone sends
 * it. The two never talk directly: the phone appends commands to a row, the
 * TV polls for the ones it has not seen and writes back what it is doing.
 *
 * Pure functions on purpose, same as lib/nowplaying.js: what a command may
 * contain, which ones the TV still owes, and whether a TV is still there are
 * decisions, and decisions should be testable without a television.
 */

const crypto = require('crypto');

class InvalidTv extends Error {}

/* Six digits. Typed on a phone's number pad in one go, read off a TV across
   a room. Guessing is not a route in: pairing needs a signed-in account AND
   a TV that is on the pairing screen right now. */
function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function makeKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function hash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function validCode(code) {
  return typeof code === 'string' && /^[0-9]{6}$/.test(code);
}

/* A key that is not even the right shape never reaches the database. */
function validKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(key);
}

/* How long a TV counts as still on the pairing screen. It polls every second
   or so; twenty seconds is a Wi-Fi hiccup, not a TV that was switched off. */
const TV_FRESH_MS = 20 * 1000;

/* And how long an abandoned room is kept before it is swept. */
const ROOM_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/* The queue only needs to outlast one missed poll. Twenty is generous and
   keeps a row from growing for the length of a film. */
const QUEUE_MAX = 20;

const MAX_URL = 4000;
const MAX_TEXT = 300;
const DAY = 86400;

const TYPES = new Set(['load', 'play', 'pause', 'seek', 'skip', 'stop']);
const MIMES = new Set([
  'application/x-mpegURL',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4'
]);

function text(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function httpUrl(v) {
  const s = text(v, MAX_URL + 1);
  if (!s) return null;
  if (s.length > MAX_URL) throw new InvalidTv('That address is too long.');
  let u;
  try { u = new URL(s); } catch (e) { throw new InvalidTv('That is not an address.'); }
  /* The TV loads it into a <video>. Anything but http(s) is either useless
     there or something that should never be handed to a page. */
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new InvalidTv('Only web addresses can be sent to the TV.');
  }
  return u.toString();
}

function seconds(v, { signed = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const lim = signed ? Math.max(-DAY, Math.min(DAY, n)) : Math.max(0, Math.min(DAY, n));
  return Math.round(lim * 10) / 10;
}

/* What a phone may ask a TV to do. Everything the TV reads comes through
   here, so the TV page can trust the shape and not re-check it. */
function shapeCommand(body) {
  if (!body || typeof body !== 'object') throw new InvalidTv('No command.');
  const type = String(body.type || '');
  if (!TYPES.has(type)) throw new InvalidTv('Unknown command.');

  if (type === 'load') {
    const url = httpUrl(body.url);
    if (!url) throw new InvalidTv('Nothing to play.');
    const mime = MIMES.has(body.mime) ? body.mime : 'video/mp4';
    return {
      type,
      url,
      /* The same film through the bridge, tried once if the direct address
         is refused — a host that wants its own page as the referer. */
      fallback: body.fallback ? httpUrl(body.fallback) : null,
      mime,
      title: text(body.title, MAX_TEXT),
      at: seconds(body.at),
      subs: body.subs ? httpUrl(body.subs) : null,
      subsName: text(body.subsName, 80)
    };
  }
  if (type === 'seek') return { type, to: seconds(body.to) };
  if (type === 'skip') return { type, by: seconds(body.by, { signed: true }) };
  return { type };
}

const STATES = new Set(['idle', 'loading', 'playing', 'paused', 'buffering', 'ended', 'blocked', 'error']);

/* What the TV says about itself. The phone draws its remote from this. */
function shapeStatus(body) {
  if (!body || typeof body !== 'object') return null;
  return {
    state: STATES.has(body.state) ? body.state : 'idle',
    position: seconds(body.position),
    duration: seconds(body.duration),
    title: text(body.title, MAX_TEXT),
    error: text(body.error, MAX_TEXT),
    seq: Math.max(0, Math.floor(Number(body.seq) || 0))
  };
}

/* Stamp a command with the next seq and keep the tail of the queue. */
function append(commands, seq, command) {
  const next = seq + 1;
  const list = Array.isArray(commands) ? commands.slice() : [];
  list.push({ ...command, seq: next, sentAt: Date.now() });
  return { seq: next, commands: list.slice(-QUEUE_MAX) };
}

/* The commands the TV has not run yet.
 *
 * A TV that has fallen further behind than the queue holds cannot replay the
 * gap, and replaying half of it would be worse than none: a pause from ten
 * minutes ago followed by nothing. So a gap collapses to the most recent load
 * and whatever came after it — the TV ends up playing what the phone last
 * chose, which is the only state worth arriving at. */
function pending(commands, since) {
  const list = Array.isArray(commands) ? commands : [];
  const after = list.filter((c) => c && c.seq > since);
  if (!after.length) return [];
  const gap = after[0].seq > since + 1;
  if (!gap) return after;
  let lastLoad = -1;
  after.forEach((c, i) => { if (c.type === 'load') lastLoad = i; });
  return lastLoad === -1 ? after.slice(-1) : after.slice(lastLoad);
}

function fresh(seenAt, now = Date.now()) {
  const t = Date.parse(seenAt);
  return Number.isFinite(t) && now - t < TV_FRESH_MS;
}

module.exports = {
  InvalidTv,
  makeCode,
  makeKey,
  hash,
  validCode,
  validKey,
  shapeCommand,
  shapeStatus,
  append,
  pending,
  fresh,
  TV_FRESH_MS,
  ROOM_TTL_MS,
  QUEUE_MAX
};
