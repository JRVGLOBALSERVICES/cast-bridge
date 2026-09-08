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
    /* How a cover gets fetched a second time, by us, when the site refused
       to serve it to the phone. Injectable so the rules below can be
       proven without a server. */
    var proxy = env.proxy || function (u) { return '/api/img?u=' + encodeURIComponent(u); };
    var seen = {};      // url -> promise of the url, or of '' if it will not load
    var art = '';       // what the shade and the lock screen should use
    var source = '';    // 'poster' | 'frame' | ''
    var poster = '';    // the address the cover came from, before any proxying
    var token = 0;      // which set() is the current one
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

    /* Is there anything in this picture?
     *
     * Nearly every film opens on black. `loadeddata` is by definition the
     * FIRST frame, so a frame taken there is a black rectangle far more
     * often than it is the film — and once adopted it was never replaced,
     * which is how a notification ends up showing a black square as the
     * cover of an episode that has one on screen a second later.
     *
     * The test is spread, not darkness: a genuinely dark shot still has
     * highlights somewhere, while a leader frame, a white flash and a
     * solid colour card are all one value everywhere. Sampled on a stride
     * rather than pixel by pixel — this runs on a phone, several times a
     * film, and a coarse read answers the only question being asked.
     *
     * Returns false when it cannot see the pixels at all. A canvas that
     * refuses to be read is a tainted one, and that is toDataURL's answer
     * to give, not this function's — no frame should ever be thrown away
     * because we failed to measure it. */
    function blank(ctx, w, h) {
      var d;
      try {
        if (!ctx.getImageData) return false;
        d = ctx.getImageData(0, 0, w, h).data;
      } catch (e) {
        return false;
      }
      if (!d || !d.length) return false;
      var px = (w * h) || (d.length / 4);
      var step = Math.max(1, Math.floor(px / 2000)) * 4;
      var lo = 255, hi = 0, n = 0;
      for (var i = 0; i + 2 < d.length; i += step) {
        /* Rounded luma. The exact weights do not matter at this coarseness;
           what matters is that one number stands for the pixel. */
        var l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        if (l < lo) lo = l;
        if (l > hi) hi = l;
        n++;
      }
      if (!n) return false;
      /* Two ways to be nothing: too dark to show anything, or the same
         value everywhere at any brightness. */
      return hi < 16 || (hi - lo) < 10;
    }

    /* A still from the element already decoding the film. Returns '' rather
       than throwing on a cross-origin stream: that canvas is tainted by
       design and there is nothing to be done about it here. Also '' for a
       frame with nothing in it — see blank(). */
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
        var ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, c.width, c.height);
        if (blank(ctx, c.width, c.height)) return '';
        return c.toDataURL('image/jpeg', 0.7);
      } catch (e) {
        return '';
      }
    }

    /* A new film. The last one's cover is dropped in the same tick — the
       wrong picture is worse than no picture — and the new one is only
       adopted once it has proven it loads.
     *
     * Two attempts, not one. The direct address first, because when it
     * works it costs nothing. Then the same address fetched through this
     * app's own server, because the single most common reason a real
     * poster does not appear is hotlink protection: the site sees a Referer
     * that is not its own and answers 403, the <img> never fires onload,
     * and the shade falls back to the grey app mark over a film that has a
     * perfectly good cover. One refusal is not "there is no picture".
     *
     * The stale-answer guard is a token rather than a comparison against
     * the argument — the old `mine !== url` compared a value to itself and
     * could never be true, so a slow first film could still overwrite a
     * fast second one. */
    function set(url) {
      var mine = ++token;
      art = '';
      source = '';
      poster = '';
      announce();
      if (!url) return Promise.resolve('');

      var stale = function () { return mine !== token || Boolean(art); };

      return probe(url)
        .then(function (ok) {
          if (stale()) return '';
          if (ok) return ok;
          return probe(proxy(url)).then(function (viaUs) {
            return stale() ? '' : viaUs;
          });
        })
        .then(function (ok) {
          if (!ok || stale()) return art;
          art = ok;
          source = 'poster';
          poster = url;
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
         like any other client.
       *
       * A real cover always goes through our own server on the way to the
       * television, even when the phone loaded it direct. The receiver is
       * a separate client on the same network with no session, no cookies
       * and a referer of its own, so "the phone could fetch it" is not
       * evidence the TV can — and our copy is the only one that carries
       * the cross-origin header a receiver needs. */
      remote: function () { return source === 'poster' && poster ? proxy(poster) : ''; },
      onChange: function (fn) { listeners.push(fn); }
    };
  }

  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBArtwork = api;
})(typeof self !== 'undefined' ? self : this);
