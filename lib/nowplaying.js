/* The live session, shaped and judged.
 *
 * Pure functions on purpose: every rule below is a decision about what to
 * claim, and a decision about what to claim should be testable without a
 * database, a television or a network.
 */

const MAX_URL = 1000;
const MAX_TEXT = 300;

/* The states the receiver can be in, as far as this app cares.
 *
 * `sending` is not a receiver state -- it is ours, for the window between
 * loadMedia being accepted and the TV reporting that it actually started.
 * It is kept separate because that window is where this app's most common
 * failure lives, and a resume that cannot tell "the TV is playing this" from
 * "the TV was asked and never answered" will offer to rejoin a film that was
 * never on screen. */
const STATES = new Set(['sending', 'playing', 'paused', 'idle']);

/* How long a heartbeat stays fresh.
 *
 * The client beats every 15s while a session is live, so 60s is four missed
 * beats -- long enough that a phone that slept briefly, or lost Wi-Fi in a
 * lift, is not declared dead, and short enough that a session closed an hour
 * ago is not still being offered as live. */
const FRESH_MS = 60 * 1000;

/* And how long a row is worth offering as a resume point at all. A film
 * abandoned two days ago is history, not a session. */
const RESUMABLE_MS = 48 * 60 * 60 * 1000;

class InvalidSession extends Error {}

function text(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function seconds(v) {
  const n = Number(v);
  /* NaN, Infinity and negatives all mean "the receiver did not tell us", and
     all three must land on 0 rather than on the string "NaN" going into a
     numeric column. A duration of 0 is also what a live stream reports, so 0
     is a legitimate value here and not a sentinel for missing. */
  if (!Number.isFinite(n) || n < 0) return 0;
  /* A day. Longer than any film, and short of anything that looks like a
     millisecond value pasted into a seconds field. */
  return Math.min(n, 86400);
}

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/* What the browser sent, turned into what the row may contain.
 *
 * Nothing here trusts a user_id from the body -- that comes from the signed
 * session in the handler, exactly as it does in history.js. */
function shape(body) {
  const b = body && typeof body === 'object' ? body : {};

  const url = text(b.url, MAX_URL + 1);
  if (!url) throw new InvalidSession('A session needs the address that was cast.');
  if (url.length > MAX_URL) throw new InvalidSession('That address is too long to remember.');
  if (!/^https?:\/\//i.test(url)) throw new InvalidSession('Only http and https addresses can be cast.');

  const state = text(b.state, 20);
  if (state && !STATES.has(state)) throw new InvalidSession('That is not a state a receiver reports.');

  const subsId = b.subs_id === null || b.subs_id === undefined ? null : b.subs_id;
  if (subsId !== null && !isUuid(subsId)) throw new InvalidSession('That subtitle reference is not an id.');

  return {
    url,
    title: text(b.title, MAX_TEXT),
    device: text(b.device, MAX_TEXT),
    position: seconds(b.position),
    duration: seconds(b.duration),
    state: state || 'sending',
    subs_id: subsId,
    subs_name: text(b.subs_name, MAX_TEXT)
  };
}

/* Is this row still a live session?
 *
 * The honest answer, and the reason this function returns a word rather than
 * a boolean: THIS APP CANNOT KNOW. The television is not ours to poll. All
 * that is known is when the app last spoke, and an app that stopped speaking
 * is not proof that a film stopped playing -- the phone may simply be in a
 * pocket while the set plays on.
 *
 * So there are three answers, and the UI is required to say the right one:
 *
 *   live      -- beating now. The film is on, and rejoining is a fact.
 *   maybe     -- the app stopped talking, but recently enough that the TV is
 *                probably still going. Offer to look, do not assert.
 *   ended     -- old enough that claiming anything about the TV would be a
 *                guess. It becomes a resume point, not a session.
 *
 * The Cast SDK's own rejoin outranks all three: if it hands back a live
 * session on the next open, that is the television speaking, and this row is
 * only there to supply the title the SDK does not carry. */
function freshness(row, now) {
  if (!row || !row.updated_at) return 'ended';
  const at = Date.parse(row.updated_at);
  if (!Number.isFinite(at)) return 'ended';
  const age = (now === undefined ? Date.now() : now) - at;
  if (age < 0) return 'live';           // clock skew between phone and server
  if (age <= FRESH_MS) return 'live';
  if (age <= RESUMABLE_MS) return 'maybe';
  return 'ended';
}

/* Where a resume should pick up.
 *
 * Backed off by a few seconds, because the last heartbeat landed up to 15s
 * before the app was closed and dropping a viewer mid-sentence reads as a
 * bug. Never past the end: a film resumed at its own duration is a black
 * screen that looks like a failed cast. */
function resumeAt(row) {
  if (!row) return 0;
  const pos = seconds(row.position);
  if (pos <= 0) return 0;
  const dur = seconds(row.duration);
  const back = Math.max(0, pos - 5);
  /* Clamped to ten seconds short of the end whenever the duration is known.
     The first version of this only caught the last two seconds, so a film
     abandoned at 59:59 of 60:00 resumed at 59:54 -- six seconds of credits
     and then black, which reads exactly like a cast that failed. */
  if (dur > 0) return Math.max(0, Math.min(back, dur - 10));
  return back;
}

/* The shape the browser is handed. Deliberately not the raw row: `state` and
   `freshness` answer different questions and merging them is how a paused
   film from Tuesday gets announced as paused right now. */
function present(row, now) {
  if (!row) return null;
  const fresh = freshness(row, now);
  if (fresh === 'ended') return null;
  return {
    url: row.url,
    title: row.title || null,
    device: row.device || null,
    position: seconds(row.position),
    duration: seconds(row.duration),
    state: STATES.has(row.state) ? row.state : 'sending',
    subs_id: row.subs_id || null,
    subs_name: row.subs_name || null,
    freshness: fresh,
    resume_at: resumeAt(row),
    started_at: row.started_at || null,
    updated_at: row.updated_at || null
  };
}

module.exports = {
  shape, freshness, resumeAt, present, seconds, InvalidSession,
  STATES, FRESH_MS, RESUMABLE_MS, MAX_URL
};
