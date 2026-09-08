/* Cast Bridge — the other streams the same scan found.
 *
 * Its own file for the same reason artwork.js is: every rule in here is a
 * decision about what to try next after something did not play, and those
 * are exactly the rules that should be provable without a phone, a
 * television or a film. See scripts/test-sources.js.
 *
 * The problem it exists for. A scan of one episode page routinely finds
 * several addresses for that one episode — a master playlist, a fixed
 * rendition, sometimes a second host entirely. Which of them actually plays
 * is not knowable in advance: one has a token that expired an hour ago, one
 * refuses this origin, one works. The app used to throw away the rest the
 * moment one was picked, so a stream that did not play sent the person back
 * to scan the page again — and the scan is the slow part of the whole app.
 *
 * Two ways forward, and they are deliberately different:
 *
 *   - Automatic, after a failure. Capped, and it only ever visits addresses
 *     nobody has tried, because walking the whole list on its own is a
 *     spinner changing its mind while somebody watches.
 *   - Deliberate, from the picker. Uncapped, wraps, and visits everything —
 *     a control that refuses on the last item is a dead end at exactly the
 *     moment somebody is looking for a way forward.
 */
(function (root) {
  'use strict';

  function create(env) {
    env = env || {};
    var isHttp = env.isHttp || function (u) { return /^https?:\/\//i.test(String(u || '')); };
    var kindOf = env.kindOf || function () { return ''; };
    var nameOf = env.nameOf || function (u) { return String(u || ''); };
    /* A page that somehow yields forty addresses is a list nobody scrolls,
       and the ones past the first handful are near-duplicates anyway. */
    var CAP = env.cap || 12;
    /* Two automatic hops. A set whose every address is dead would otherwise
       walk itself end to end and arrive at the same answer more slowly. */
    var AUTO_MAX = env.autoMax === undefined ? 2 : env.autoMax;

    var list = [];
    var at = -1;
    var tried = {};
    var autoUsed = 0;

    function clean(input) {
      var out = [];
      var seen = {};
      (input || []).forEach(function (m) {
        if (!m || !isHttp(m.url) || seen[m.url]) return;
        seen[m.url] = true;
        if (out.length >= CAP) return;
        out.push({ url: m.url, label: m.label || '', kind: m.kind || kindOf(m.url) });
      });
      return out;
    }

    function same(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i].url !== b[i].url) return false;
      return true;
    }

    return {
      /* Install the set that came with a load.
       *
       * The same set arriving again is what a hop WITHIN it looks like, and
       * it must not wipe the record of what has already been tried — a
       * reset there would send the automatic hop straight back to the
       * stream that just failed, forever. */
      set: function (input, url, hint) {
        var next = clean(input);
        if (!same(next, list)) {
          list = next;
          tried = {};
          autoUsed = 0;
        }
        at = -1;
        /* Position is carried explicitly where the caller knows it. Finding
           it by address is right too — clean() has already made addresses
           unique — but the caller's own index cannot be wrong. */
        if (typeof hint === 'number' && list[hint] && list[hint].url === url) {
          at = hint;
        } else {
          for (var i = 0; i < list.length; i++) {
            if (list[i].url === url) { at = i; break; }
          }
        }
        if (url) tried[url] = true;
        return at;
      },

      list: function () { return list.slice(); },
      count: function () { return list.length; },
      at: function () { return at; },
      item: function (i) { return list[i] || null; },
      tried: function (url) { return Boolean(tried[url]); },

      /* A stream's name in the picker. The scan's own label is what the row
         in the table said, so the two agree; the kind is appended because
         "video" and "480" say nothing about which one a television takes. */
      name: function (i) {
        var m = list[i];
        if (!m) return '';
        var label = String(m.label || nameOf(m.url) || 'Stream ' + (i + 1)).trim();
        var kind = m.kind || kindOf(m.url);
        return kind && label.toUpperCase().indexOf(String(kind).toUpperCase()) === -1
          ? label + ' — ' + kind
          : label;
      },

      /* The next address nobody has tried, and the budget spent on getting
         it. Returns -1 rather than throwing or wrapping: the caller then
         says the thing it was going to say anyway, which is better than a
         silent no-op that reads as a broken button. */
      takeAuto: function () {
        if (list.length < 2) return -1;
        if (autoUsed >= AUTO_MAX) return -1;
        for (var n = 1; n <= list.length; n++) {
          var i = (Math.max(0, at) + n) % list.length;
          if (tried[list[i].url]) continue;
          autoUsed += 1;
          return i;
        }
        return -1;
      },

      /* The deliberate step. Wraps, and says nothing about what has been
         tried — somebody asking for the next one has their own reason. */
      next: function () {
        if (list.length < 2) return -1;
        return (Math.max(0, at) + 1) % list.length;
      },

      /* A source that actually started playing is evidence the set is not
         the problem, so the budget for automatic hops is handed back. */
      resetAuto: function () { autoUsed = 0; },
      autoUsed: function () { return autoUsed; },

      /* What goes on the history row: address and name only. The rest of a
         scan row is measurement, and it will be stale by the time anybody
         comes back to the film. */
      forStore: function () {
        return list.map(function (m) {
          return { url: m.url, label: m.label || '', kind: m.kind || kindOf(m.url) };
        });
      }
    };
  }

  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBSources = api;
})(typeof self !== 'undefined' ? self : this);
