/* Cast Bridge — what a button in the notification shade is allowed to act on.
 *
 * Its own file for the same reason as artwork.js: the rule in here is the
 * one that was wrong, it is a rule about a television that is in another
 * room, and it should be provable without one. See scripts/test-notify.js.
 *
 * The rule is short. The `cast` notification is only ever drawn about a
 * television — reportCast() has four callers and all four are cast events —
 * so its buttons have exactly one legitimate target. There is no second
 * thing for them to fall back to, and the version of this that fell back to
 * the phone's own <video> is what made a tap read as "nothing happened":
 * while a film is on the television that element is hidden, empty and
 * already paused, so toggling it is silent, changes nothing on screen, and
 * leaves the television playing.
 *
 * That fallback was not a rare path. `ready()` is false for a moment on
 * every thaw — Android freezes a backgrounded PWA and the Cast SDK re-syncs
 * `isMediaLoaded` when the page wakes, which is precisely the moment a shade
 * tap arrives. The previous version only waited for the session when the tap
 * had been REPLAYED out of the worker's cache, and took the ordinary
 * live-page tap straight past the guard.
 *
 * So: wait for the remote, or give up and say so. Never a third thing.
 */
(function (root) {
  'use strict';

  /* Two budgets, because the two situations are different. A page that was
     alive to receive the tap either has the session or is a moment from it.
     A tap that had to open the app is waiting on a full rejoin, which is
     slower and worth more patience — but not unbounded patience, because a
     television that has been switched off never answers. */
  var LIVE = 2500;
  var REJOIN = 8000;
  var STEP = 250;

  function create(env) {
    env = env || {};
    var setI = env.setInterval || setTimeout;
    var clearI = env.clearInterval || clearTimeout;
    var step = env.step || STEP;
    var live = env.live || LIVE;
    var rejoin = env.rejoin || REJOIN;

    return {
      live: live,
      rejoin: rejoin,

      /* `ready` is asked again on every step rather than once: the whole
         point is that the answer changes. `act` runs at most once, `giveUp`
         at most once, and never both. */
      wait: function (tap, ready, act, giveUp) {
        if (ready()) { act(); return null; }

        var budget = tap && tap.replayed ? rejoin : live;
        var waited = 0;
        var tick = setI(function () {
          if (ready()) { clearI(tick); act(); return; }
          waited += step;
          if (waited < budget) return;
          clearI(tick);
          giveUp();
        }, step);
        return tick;
      }
    };
  }

  var api = { create: create, LIVE: LIVE, REJOIN: REJOIN, STEP: STEP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBCastAction = api;
})(typeof self !== 'undefined' ? self : this);
