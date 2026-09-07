/* Cast Bridge — where the picture on the lock screen comes from.
 *
 * Its own file, and not because app.js is long. Every rule in here is a
 * decision about what to SHOW someone about a film this app did not make
 * and cannot see: whether a cover exists, whether it will load, whether the
 * frames are ours to read. Those are exactly the rules that should be
 * provable without a phone, a television or a film — see
 * scripts/test-notify.js.
 *
 * Three sources, in the order of how much they actually say:
 *
 *   1. The page's own cover. `/api/scan` and `/api/extract` both already
 *      read <video poster> and og:image and return it as `poster`; nothing
 *      on the client ever looked at it, which is why every notification was
 *      a grey app icon over a film with a perfectly good cover.
 *   2. A frame of the film. Only readable when the pixels are ours — a
 *      cross-origin <video> taints the canvas and toDataURL throws. That is
 *      a rule about the stream, not a bug to work around.
 *   3. Nothing, and the caller falls back to the app icon. Which says only
 *      "Cast Bridge" — already on the badge.
 *
 * A cover is PROVEN to load before it is handed to the shade: a hotlinked
 * poster from a site that refuses our referer is a broken-image icon on the
 * lock screen, and the app icon is better than that.
 */
(function (root) {
  'use strict';

  function create(env) {
    env = env || {};
    var doc = env.document;
    var ImageCtor = env.Image;
    var MAX_W = env.maxWidth || 512;
    var PROBE_MS = env.probeMs || 5000;
    var timer = env.setTimeout;

    var video = function () { return env.video || null; };
    var seen = {};      // url -> promise of the url, or of '' if it will not load
    var art = '';       // what the shade and the lock screen should use
    var source = '';    // 'poster' | 'frame' | ''
    var listeners = [];

    function announce() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](art, source); } catch (e) { /* one must not stop the rest */ }
      }
    }

    /* Load it here first. A picture that 403s for our referer — which is
       most hotlinked posters — must never reach a notification, because
       there it is a broken-image glyph and there is no second chance. */
    function probe(url) {
      if (!url) return Promise.resolve('');
      if (seen[url]) return seen[url];
      seen[url] = new Promise(function (done) {
        var settled = false;
        function finish(v) { if (settled) return; settled = true; done(v); }
        var img;
        try { img = new ImageCtor(); } catch (e) { finish(''); return; }
        img.onload = function () { finish(img.naturalWidth > 0 ? url : ''); };
        img.onerror = function () { finish(''); };
        /* A host that neither answers nor refuses would otherwise leave the
           notification waiting for a picture forever. */
        timer(function () { finish(''); }, PROBE_MS);
        img.src = url;
      });
      return seen[url];
    }

    /* A still from the element already decoding the film. Returns '' rather
       than throwing on a cross-origin stream: that canvas is tainted by
       design and there is nothing to be done about it here. */
    function frame() {
      try {
        var v = video();
        if (!v || v.readyState < 2) return '';
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) return '';
        var scale = Math.min(1, MAX_W / w);
        var c = doc.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.7);
      } catch (e) {
        return '';
      }
    }

    /* A new film. The last one's cover is dropped in the same tick — the
       wrong picture is worse than no picture — and the new one is only
       adopted once it has proven it loads. */
    function set(poster) {
      art = '';
      source = '';
      announce();
      if (!poster) return Promise.resolve('');
      var mine = poster;
      return probe(poster).then(function (ok) {
        /* Another film was loaded while this one was being fetched, or a
           frame won the race. Either way this answer is stale. */
        if (!ok || art || mine !== poster) return art;
        art = ok;
        source = 'poster';
        announce();
        return art;
      });
    }

    /* The fallback, tried once the element has pixels. Never overwrites a
       real cover — the page's own picture is chosen, a frame is a guess. */
    function tryFrame() {
      if (art) return '';
      var f = frame();
      if (!f) return '';
      art = f;
      source = 'frame';
      announce();
      return art;
    }

    return {
      set: set,
      tryFrame: tryFrame,
      current: function () { return art; },
      source: function () { return source; },
      /* Only an address the television can fetch for itself. A captured
         frame is a data: URL: fine for this phone's lock screen, useless to
         a Chromecast, which has to go and get the picture over the network
         like any other client. */
      remote: function () { return source === 'poster' ? art : ''; },
      onChange: function (fn) { listeners.push(fn); }
    };
  }

  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBArtwork = api;
})(typeof self !== 'undefined' ? self : this);
