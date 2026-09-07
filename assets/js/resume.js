/* Cast Bridge — what the banner above the player is allowed to say.
 *
 * Its own file for the same reason as artwork.js and castaction.js: the rule
 * in here was wrong, it is a rule about a television in another room, and it
 * should be provable without one. See scripts/test-resume.js.
 *
 * The reported fault, in Rj's words: "You were watching this / 720p · on 55"
 * Crystal UHD / Pick it back up — shows this but cast still ongoing."
 *
 * Offering to restart a film that is playing in front of you is worse than
 * saying nothing. It reads as the app having lost the television, and the
 * button under it invites a re-cast that would jump the film back to a
 * remembered position.
 *
 * lib/nowplaying.js already states the correct precedence, in a comment:
 * "The Cast SDK's own rejoin outranks all three." The client honoured that
 * in exactly two places — the moment the stored row arrived, and a single
 * SESSION_RESUMED event — and nowhere else. Neither is guaranteed to be the
 * moment the SDK actually rejoins, so the banner could be drawn from a row
 * alone and then never reconsidered.
 *
 * So the precedence lives here instead of in an event handler, and every
 * render pays it:
 *
 *   a live session   -- the television is speaking. There is nothing to
 *                       resume; adopt the row for its title and say nothing.
 *   freshness live   -- the app was beating seconds ago. "Still playing" is
 *                       a fact, and the offer is to take the remote back.
 *   otherwise        -- the app stopped talking and does not know. Say where
 *                       you were. Never assert that it is still on.
 */
(function (root) {
  'use strict';

  /* One implementation of the clock, here rather than in app.js, so a test
     can exercise the real formatter instead of agreeing with a copy of it. */
  function clock(sec) {
    /* Number() first, and a finite check, because Math.floor('x') is NaN and
       Math.max(0, NaN) is NaN — so the inherited version rendered the string
       "NaN:NaN" on screen. Reachable: a <video> reports currentTime and
       duration as NaN until it has metadata, and this formatter has twelve
       callers on that side of the app. */
    sec = Number(sec);
    if (!isFinite(sec)) sec = 0;
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /* `live` is whatever the Cast SDK hands back for a current session — this
     module only asks whether there is one. Passing the session itself keeps
     the caller honest: there is no way to describe a live cast as absent
     without actually looking. */
  function view(row, live, nameOf) {
    if (live) return { adopt: !!row, show: false, head: '', sub: '', action: '' };
    if (!row) return { adopt: false, show: false, head: '', sub: '', action: '' };

    var title = row.title || (nameOf ? nameOf(row.url) : row.url) || 'that film';
    var where = row.device || 'the TV';
    var at = row.position > 0 ? clock(row.position) : '';

    if (row.freshness === 'live') {
      return {
        adopt: false,
        show: true,
        head: 'Still playing on ' + where,
        sub: title + (at ? ' · ' + at + ' in' : ''),
        action: 'Take the remote'
      };
    }

    return {
      adopt: false,
      show: true,
      head: 'You were watching this',
      sub: title + (at ? ' · stopped ' + at + ' in' : '') + ' · on ' + where,
      action: 'Pick it back up'
    };
  }

  var api = { view: view, clock: clock };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBResume = api;
})(typeof self !== 'undefined' ? self : this);
