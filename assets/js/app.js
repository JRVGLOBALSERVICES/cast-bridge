/* Cast Bridge — app logic.
   No framework, no build step. Sections in order:
   helpers · history store · toasts · tabs · player · cast · handoff ·
   browser · history view · boot */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  /* Same list the scanner uses. Where the two drift, an address the server
     resolves happily is one the Link box sends the long way round. */
  var MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ogv|mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;

  function mimeOf(u) {
    var p = String(u).split('?')[0].split('#')[0].toLowerCase();
    /* Our own generated manifest, which has no extension to read. bilibili.tv
       serves DASH and publishes no manifest, so /api/bstar builds one; the
       address carries a signed token rather than a filename, and every other
       branch here is an extension sniff. Told nothing, this would fall
       through to video/mp4 and the receiver would be handed an XML document
       labelled as a film. */
    if (/\/api\/bstar$/.test(p)) return 'application/dash+xml';
    if (/\.m3u8$/.test(p)) return 'application/x-mpegURL';
    if (/\.mpd$/.test(p)) return 'application/dash+xml';
    if (/\.webm$/.test(p)) return 'video/webm';
    if (/\.mkv$/.test(p)) return 'video/x-matroska';
    if (/\.mov$/.test(p)) return 'video/quicktime';
    if (/\.(mp3)$/.test(p)) return 'audio/mpeg';
    if (/\.(m4a|aac)$/.test(p)) return 'audio/mp4';
    if (/\.opus$/.test(p)) return 'audio/ogg';
    if (/\.(ogg|ogv)$/.test(p)) return 'video/ogg';
    if (/\.(flac)$/.test(p)) return 'audio/flac';
    if (/\.(wav)$/.test(p)) return 'audio/wav';
    return 'video/mp4';
  }

  function kindOf(u) {
    var m = mimeOf(u);
    if (m === 'application/x-mpegURL') return 'HLS';
    if (m === 'application/dash+xml') return 'DASH';
    if (m.indexOf('audio/') === 0) return 'AUDIO';
    var p = String(u).split('?')[0].toLowerCase();
    var ext = (p.match(/\.([a-z0-9]{2,5})$/) || [])[1];
    return ext ? ext.toUpperCase() : 'VIDEO';
  }

  function nameOf(u) {
    try {
      var p = new URL(u);
      var last = p.pathname.split('/').filter(Boolean).pop();
      var f = last ? decodeURIComponent(last) : p.host;
      f = f.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._-]+/g, ' ').trim();
      if (!f) f = p.host;
      return f.length > 70 ? f.slice(0, 67) + '…' : f;
    } catch (e) { return String(u).slice(0, 70); }
  }

  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function ago(t) {
    var s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 604800) return Math.floor(s / 86400) + ' d ago';
    return new Date(t).toLocaleDateString();
  }

  /* One implementation, in resume.js, so the suite exercises the formatter
     this app actually renders with rather than a copy of it. */
  function clock(sec) { return window.CBResume.clock(sec); }

  function isHttp(u) { return /^https?:\/\//i.test(String(u).trim()); }

  /* Turn common share links into direct media links. */
  function resolveShare(u) {
    var m;
    if ((m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([\w-]{10,})/))) {
      return 'https://drive.google.com/uc?export=download&id=' + m[1];
    }
    if (/dropbox\.com\//.test(u)) {
      return u.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace(/[?&]dl=0/, '');
    }
    if (/res\.cloudinary\.com\/.+\/video\/upload\//.test(u) && !/\/upload\/(q_|f_|vc_)/.test(u)) {
      return u.replace('/video/upload/', '/video/upload/q_auto,f_auto/');
    }
    return u;
  }

  /* ------------------------------------------------------------------ *
   * History store
   *
   * v1 was 20 bare URLs in localStorage. v2 keeps a record per item —
   * title, kind, where it came from, play count, and the position you
   * got to — so a thing you half-watched can be picked up later.
   * ------------------------------------------------------------------ */

  var store = (function () {
    var KEY = 'cb:hist:v2';
    var LEGACY = 'cb:hist';
    var CAP = 200;
    var cache = null;

    /* Tombstones. Removing a row here used to touch localStorage only, so
       the server still had it and the next sync — which adds back any
       server row the local store is missing — put it straight back. That
       is why × looked like it did nothing. The server copy is deleted too
       now, but a delete made offline has not reached it yet, so the url is
       remembered as buried until the server confirms it is gone. */
    var DEAD = 'cb:hist:dead';
    var DEAD_CAP = 500;
    var DEAD_MS = 90 * 24 * 60 * 60 * 1000;

    function blank() { return { v: 2, items: [] }; }

    function read() {
      if (cache) return cache;
      var raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) { return (cache = blank()); }

      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.items)) return (cache = parsed);
        } catch (e) { /* falls through to a rebuild below */ }
      }

      /* Migrate v1 rather than dropping it — those are links the user chose. */
      var out = blank();
      try {
        var old = JSON.parse(localStorage.getItem(LEGACY) || '[]');
        if (Array.isArray(old)) {
          out.items = old.filter(function (x) { return x && x.u; }).map(function (x) {
            return {
              id: id(), url: x.u, title: nameOf(x.u), kind: kindOf(x.u),
              addedAt: x.t || Date.now(), lastAt: x.t || Date.now(),
              plays: 1, pos: 0, dur: 0, from: '', fav: false
            };
          });
        }
      } catch (e) { /* nothing to migrate */ }
      cache = out;
      write();
      return cache;
    }

    function write() {
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* quota / private mode */ }
    }

    /* A tombstone that outlives every copy of the row it was hiding is just
       a url the person can never re-add from another device, so they age
       out — ninety days is far longer than any sync takes to settle. */
    function readDead() {
      var d;
      try { d = JSON.parse(localStorage.getItem(DEAD) || '{}'); } catch (e) { return {}; }
      if (!d || typeof d !== 'object') return {};
      var cut = Date.now() - DEAD_MS;
      var keys = Object.keys(d), out = {}, kept = 0;
      for (var i = keys.length - 1; i >= 0 && kept < DEAD_CAP; i--) {
        if (d[keys[i]] > cut) { out[keys[i]] = d[keys[i]]; kept++; }
      }
      return out;
    }

    function writeDead(d) {
      try { localStorage.setItem(DEAD, JSON.stringify(d)); } catch (e) { /* quota */ }
    }

    function id() {
      return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    return {
      all: function () { return read().items.slice(); },
      count: function () { return read().items.length; },

      find: function (url) {
        var items = read().items;
        for (var i = 0; i < items.length; i++) if (items[i].url === url) return items[i];
        return null;
      },

      /* Record a play. Existing entries move to the front and keep position. */
      touch: function (url, meta) {
        meta = meta || {};
        /* Playing something again is an undelete — the tombstone has to go
           or the next sync would drop it back out from under them. */
        this.revive(url);
        var d = read();
        var found = null, i;
        for (i = 0; i < d.items.length; i++) {
          if (d.items[i].url === url) { found = d.items.splice(i, 1)[0]; break; }
        }
        if (!found) {
          found = {
            id: id(), url: url, title: meta.title || nameOf(url), kind: kindOf(url),
            addedAt: Date.now(), lastAt: 0, plays: 0, pos: 0, dur: 0,
            from: meta.from || '', fav: false
          };
        }
        found.lastAt = Date.now();
        found.plays = (found.plays || 0) + 1;
        if (meta.title) found.title = meta.title;
        if (meta.from) found.from = meta.from;
        if (meta.poster) found.poster = meta.poster;
        /* The other streams the same scan found for this film. Written only
           when there are any, so replaying a row from History — which knows
           of no siblings — cannot erase the set the scan put there. Address
           and name only: the rest of a scan row is measurement that will be
           stale by the time anyone comes back to it. */
        if (meta.sources && meta.sources.length > 1) {
          found.sources = meta.sources.slice(0, 12).map(function (m) {
            return { url: m.url, label: m.label || '', kind: m.kind || kindOf(m.url) };
          });
        }
        found.kind = kindOf(url);
        d.items.unshift(found);
        if (d.items.length > CAP) d.items.length = CAP;
        write();
        return found;
      },

      progress: function (url, pos, dur) {
        var it = this.find(url);
        if (!it) return;
        it.pos = Math.floor(pos || 0);
        if (dur && isFinite(dur)) it.dur = Math.floor(dur);
        write();
      },

      star: function (itemId) {
        var items = read().items;
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === itemId) { items[i].fav = !items[i].fav; write(); return items[i].fav; }
        }
        return false;
      },

      remove: function (itemId) {
        var d = read();
        for (var i = 0; i < d.items.length; i++) {
          if (d.items[i].id === itemId) {
            var gone = { item: d.items[i], at: i };
            d.items.splice(i, 1);
            write();
            return gone;
          }
        }
        return null;
      },

      insertAt: function (item, at) {
        var d = read();
        d.items.splice(Math.min(at, d.items.length), 0, item);
        write();
      },

      clear: function () {
        var d = read();
        var snapshot = d.items.slice();
        d.items = [];
        write();
        return snapshot;
      },

      restore: function (items) {
        var d = read();
        d.items = items.slice();
        write();
      },

      isBuried: function (url) {
        return Object.prototype.hasOwnProperty.call(readDead(), url);
      },

      bury: function (url) {
        if (!url) return;
        var d = readDead();
        d[url] = Date.now();
        writeDead(d);
      },

      revive: function (url) {
        var d = readDead();
        if (!Object.prototype.hasOwnProperty.call(d, url)) return;
        delete d[url];
        writeDead(d);
      },

      exportJson: function () {
        return JSON.stringify(read(), null, 2);
      }
    };
  })();

  /* ------------------------------------------------------------------ *
   * Toasts — auto-dismiss, and the ones that destroy carry an undo
   * ------------------------------------------------------------------ */

  var toastHost = $('toasts');

  function toast(opts) {
    var el = document.createElement('div');
    el.className = 'cb-toast';
    el.setAttribute('role', opts.assertive ? 'alert' : 'status');

    var text = document.createElement('span');
    text.className = 'cb-toast-text';
    text.textContent = opts.text;
    el.appendChild(text);

    var timer = null;
    var close = function () {
      if (timer) clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    };

    if (opts.actionLabel) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', function () {
        close();
        if (opts.onAction) opts.onAction();
      });
      el.appendChild(btn);
    }

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'close';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.innerHTML = '<span aria-hidden="true">&times;</span>';
    dismiss.addEventListener('click', close);
    el.appendChild(dismiss);

    toastHost.appendChild(el);
    while (toastHost.children.length > 3) toastHost.removeChild(toastHost.firstChild);

    timer = setTimeout(close, opts.ms || (opts.actionLabel ? 10000 : 4000));
    return close;
  }

  /* ------------------------------------------------------------------ *
   * Buttons — one tap, one request
   * ------------------------------------------------------------------ */

  /* `label` is the verb in progress — Scan becomes Scanning…. Optional, and
     a button without a .cb-label (the cast and VLC ones) just gets the ring.
     The old behaviour was to hide the label and show the ring alone, which
     on a filled button is a blue rectangle with a speck in it and reads as
     nothing having happened. A word is the part of this a person sees. */
  /* ------------------------------------------------------------------ *
   * Notifications — what the phone says while you are not looking at it
   *
   * The whole point of this app is that you start something and then go and
   * do something else: an upload runs for four minutes, a television takes
   * fifteen seconds to admit it cannot play a file, a scan opens a page in a
   * real browser somewhere else. Every one of those used to report into a
   * screen nobody was looking at, and the phone said nothing at all.
   *
   * Three rules, and they are the whole design:
   *
   *   1. NOTHING IS DRAWN WHILE THE APP IS ON SCREEN. A notification for
   *      something already visible two inches away is noise, and it is how
   *      an app teaches someone to turn notifications off. Every state is
   *      held here and painted only once `document.hidden` goes true; coming
   *      back to the app clears them, because you are now looking at the
   *      real thing.
   *   2. ONE TAG PER SUBJECT. The upload is one notification that changes
   *      from 4% to 96%, not twenty-four notifications. A television is one
   *      notification that moves from "sending" to "playing" to "it refused
   *      it". Same tag, replaced in place, so the shade never fills up.
   *   3. A BUTTON THAT DOES NOTHING IS WORSE THAN NO BUTTON. Pause and Stop
   *      are only attached when there is genuinely something running to act
   *      on, and the tap is handed back to this page to perform — see the
   *      NOTIFY_ACTION handler at the bottom of this module.
   *
   * Permission is asked for from the Notifications row in More and never on
   * boot. A permission prompt at second one, before the app has done
   * anything worth being told about, is refused — and a refusal in a
   * browser is permanent from our side.
   * ------------------------------------------------------------------ */

  var notify = (function () {
    var PREF_KEY = 'cb.notify';
    var reg = null;
    /* One outstanding wait at a time. drainPending() is called from three
       places and a cold open can hit two of them within a tick. */
    var drainWaiting = false;
    var wanted = {};      // tag -> the notification that SHOULD be up
    var painted = {};     // tag -> is up right now
    /* tag -> this subject has already made its one sound. Deliberately NOT
       `painted`: leaving and re-entering the app takes a notification down
       and puts it back, and a film that buzzes every time you glance at your
       phone is the reason the whole thing was silent in the first place. One
       alert per subject, cleared only when the subject ends. */
    var alerted = {};
    var swiped = {};      // tag -> the person dismissed it; stop redrawing
    var listeners = [];
    var changed = [];

    function readPref() {
      try { return localStorage.getItem(PREF_KEY); } catch (e) { return null; }
    }
    function writePref(v) {
      try { localStorage.setItem(PREF_KEY, v); } catch (e) { /* private mode */ }
    }

    /* An installed copy, by any of the three spellings the platforms use. */
    function standalone() {
      if (navigator.standalone === true) return true;                 // iOS Safari
      try {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.matchMedia('(display-mode: minimal-ui)').matches;
      } catch (e) { return false; }
    }

    function apple() {
      return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    /* Why this is not simply "does Notification exist".
     *
     * On iOS, web notifications arrived in 16.4 and ONLY inside a copy added
     * to the Home Screen — in a Safari tab the constructor is not defined at
     * all. So the honest answer for an iPhone in a browser tab is not "your
     * phone can't do this", it is "add it to your Home Screen and it can",
     * and those are different sentences that lead to different actions. */
    function support() {
      if (!('serviceWorker' in navigator)) return 'none';
      if (!('Notification' in window)) return apple() && !standalone() ? 'needs-install' : 'none';
      return 'ok';
    }

    function permission() {
      try { return Notification.permission; } catch (e) { return 'default'; }
    }

    /* One word for the settings row and the code to both read from. */
    function state() {
      var s = support();
      if (s !== 'ok') return s;                       // 'none' | 'needs-install'
      var p = permission();
      if (p === 'denied') return 'blocked';           // only the browser can undo this
      if (p !== 'granted') return 'ask';
      return readPref() === '0' ? 'off' : 'on';
    }

    function on() { return state() === 'on'; }

    function announce() {
      for (var i = 0; i < changed.length; i++) {
        try { changed[i](state()); } catch (e) { /* a listener must not stop the rest */ }
      }
    }

    /* Must be called from a tap. Browsers refuse a permission prompt that
       did not come from a gesture, silently, which reads as a broken
       switch. */
    function ask() {
      if (support() !== 'ok') return Promise.resolve(state());
      if (permission() === 'granted') { writePref('1'); announce(); return Promise.resolve(state()); }
      var p;
      try { p = Notification.requestPermission(); } catch (e) { p = null; }
      /* Safari answered this with a callback for years and still may. */
      if (!p || typeof p.then !== 'function') {
        p = new Promise(function (done) {
          try { Notification.requestPermission(done); } catch (e) { done(permission()); }
        });
      }
      return p.then(function (result) {
        if (result === 'granted') writePref('1');
        announce();
        return state();
      });
    }

    function setOff() { writePref('0'); clearAll(); announce(); }

    function setReg(r) {
      reg = r;
      paint();
      clearShade();
      /* Every open re-registers. Nearly always a no-op — the endpoint
         outlives the session — but it is the one moment a rotated key, a
         reinstalled app or a server that lost the row can be noticed, and
         every one of those failures is otherwise completely silent. */
      try { pushSync(); } catch (e) { /* push is a bonus, never a blocker */ }
    }

    function post(msg) {
      var w = (reg && (reg.active || reg.waiting)) || navigator.serviceWorker.controller;
      if (!w) return false;
      w.postMessage(msg);
      return true;
    }

    /* What one notification looks like on the shade.
     *
     * `first` is whether this tag is being DRAWN, as opposed to redrawn with
     * newer text, and it decides the one thing that determines whether any
     * of this is ever seen: `silent`.
     *
     * Everything used to be silent except a failure. That is why background
     * notifications appeared not to work. A silent notification is not a
     * quieter notification — Android files it under "Silent" in the shade,
     * below the fold and with no heads-up banner, and iOS delivers it with
     * no banner and no lock screen. It arrives, and there is nothing to see
     * unless you already went looking. An app that only tells you things
     * you have to go and ask for has not told you anything.
     *
     * The reason it was silent was the progress notification buzzing per
     * percent, and that was never what `silent` was holding back: `renotify`
     * false with a tag already means a replacement lands without re-alerting.
     * So the first draw of a subject alerts once, every update after it is
     * silent by way of the tag, and twenty percent ticks still make one
     * sound between them. */
    function options(n, first) {
      var o = {
        body: n.body || '',
        tag: n.tag,
        /* Three separate pictures, and they are not interchangeable.
           `badge` is the monochrome stencil in the status bar and must stay
           the app's mark — a film's cover reduced to one colour is a smear.
           `icon` is the small square beside the text: the cover when there
           is one, because that is what tells two notifications apart at a
           glance. `image` is the wide picture Android draws when the shade
           is expanded, and it is the cover or nothing — the app icon
           stretched across it says nothing and costs a whole row. */
        icon: n.art || '/assets/icon-192.png',
        badge: '/assets/icon-192.png',
        silent: !(n.urgent || first),
        renotify: false,
        requireInteraction: Boolean(n.ongoing),
        data: { url: n.url || '/', tag: n.tag }
      };
      if (n.art) o.image = n.art;
      if (n.actions && n.actions.length) o.actions = n.actions.slice(0, 2);
      return o;
    }

    /* The reconciler. Everything else in this module just changes `wanted`
       and calls this — which is why there is exactly one place that decides
       whether a notification is allowed to be on screen. */
    function paint() {
      var visible = !document.hidden;
      for (var tag in wanted) {
        if (!Object.prototype.hasOwnProperty.call(wanted, tag)) continue;
        var n = wanted[tag];
        var should = !visible && on() && !swiped[tag];
        if (should) {
          post({ type: 'NOTIFY_SHOW', title: n.title, options: options(n, !alerted[tag]) });
          painted[tag] = true;
          alerted[tag] = true;
        } else if (painted[tag]) {
          post({ type: 'NOTIFY_CLOSE', tag: tag });
          painted[tag] = false;
        }
      }
    }

    function show(tag, n) {
      n = n || {};
      n.tag = tag;
      wanted[tag] = n;
      paint();
    }

    /* Change one field of a notification that is already up — the cover
       arriving a second after the film started is the case this exists
       for. Silent by tag: the shade replaces it in place. */
    function update(tag, patch) {
      if (!wanted[tag] || !patch) return;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) wanted[tag][k] = patch[k];
      }
      paint();
    }

    function close(tag) {
      delete wanted[tag];
      delete swiped[tag];
      delete alerted[tag];
      if (painted[tag]) post({ type: 'NOTIFY_CLOSE', tag: tag });
      delete painted[tag];
    }

    function clearAll() {
      for (var tag in wanted) {
        if (Object.prototype.hasOwnProperty.call(wanted, tag)) close(tag);
      }
    }

    function onAction(fn) { listeners.push(fn); }
    function onChange(fn) { changed.push(fn); }

    /* Coming to the front clears the shade.
     *
     * paint() only takes down what THIS page put up, and after a tap that
     * opened the app there is a notification up that no live page owns —
     * drawn by an instance that has since been shut down. It would sit
     * there reporting on the screen now in front of them. The tagless
     * close is registration-wide, so it gets that one too. */
    function clearShade() {
      if (document.hidden) return;
      post({ type: 'NOTIFY_CLOSE' });
      for (var tag in painted) {
        if (Object.prototype.hasOwnProperty.call(painted, tag)) painted[tag] = false;
      }
    }

    /* Coming to the front is also the moment to ask for a tap that could
       not be delivered.

       This is why Pause and Stop still did nothing. The worker's fallback
       is "write the tap down and bring the app up", and the app asked for
       the written-down tap exactly once, at boot. But the common case on a
       phone is an app that is ALREADY running and merely frozen: the
       worker gets no acknowledgement inside its window, writes the tap
       down, and focuses the page — which thaws, never boots again, and so
       never asks. The tap sat in the cache until it went stale. Every road
       back to the foreground has to ask, not just the first one. */
    document.addEventListener('visibilitychange', function () {
      paint();
      clearShade();
      if (!document.hidden) drainPending();
    });

    /* A page restored from the back/forward cache fires this and not
       visibilitychange, and on iOS it is the usual way back in. */
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) drainPending();
    });

    /* Every tap carries an id and no id is performed twice.
     *
     * A tap can arrive here by two roads and often by both: the worker
     * posts it to this page, and — when this page was frozen or shut and
     * could not answer in time — it also writes it down and opens the app,
     * which asks for it on boot. A phone that was merely frozen then thaws
     * and delivers the queued copy as well. Without this set, one tap on
     * Pause is a pause and then a play. */
    var done = {};

    function perform(d, ack) {
      if (!d || !d.action) return;
      if (d.id) {
        if (done[d.id]) { ack(); return; }
        done[d.id] = true;
      }
      /* Acknowledged BEFORE the work, not after: the worker is counting
         milliseconds to decide whether anybody is alive, and a Stop that
         tears down a Cast session can take longer than that. The claim
         being made is "a page has this", which is true at this line. */
      ack();
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](d.action, d.tag, { replayed: Boolean(d.replayed), id: d.id || null }); }
        catch (err) { /* one listener falling over must not stop the rest */ }
      }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        var d = e.data || {};
        if (d.type === 'NOTIFY_CLOSED') {
          swiped[d.tag] = true;
          painted[d.tag] = false;
          return;
        }
        if (d.type !== 'NOTIFY_ACTION') return;
        perform(d, function () {
          var msg = { type: 'NOTIFY_ACTION_ACK', id: d.id };
          /* The port answers the worker that is still awake waiting for it;
             the controller answers one that has since been shut down and
             restarted, which is where the written-down copy lives. */
          if (e.ports && e.ports[0]) { try { e.ports[0].postMessage(msg); } catch (err) {} }
          post(msg);
        });
      });
    }

    /* "Was a button tapped while I could not answer?" Asked on boot, and
       again on every return to the foreground — see visibilitychange
       above for why once was not enough. Safe to ask when there is
       nothing: the worker replies with a null job. */
    function drainPending() {
      if (!('serviceWorker' in navigator)) return;
      var ch;
      try { ch = new MessageChannel(); } catch (e) { return; }
      ch.port1.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.type !== 'PENDING_ACTION' || !d.job) return;
        perform({ id: d.job.id, action: d.job.action, tag: d.job.tag, replayed: true },
          function () {});
      };
      var w = (reg && reg.active) || navigator.serviceWorker.controller;

      /* No worker to ask YET is not the same as nothing to ask for, and
         `return` here dropped the tap on the one path the whole replay
         exists for. A tap that had to open the app arrives at a page whose
         registration is still installing: `reg.active` is null and there is
         no controller on the first load after an update. The old code gave
         up there — and because the tap OPENED the app, the page is already
         visible, so the visibilitychange retry never fires either. The tap
         sat in the cache until it went stale.

         `ready` resolves only once a worker is active, which is exactly the
         condition being waited for. */
      if (!w) {
        if (drainWaiting) return;
        drainWaiting = true;
        navigator.serviceWorker.ready
          .then(function () { drainWaiting = false; drainPending(); })
          .catch(function () { drainWaiting = false; });
        return;
      }
      try { w.postMessage({ type: 'GET_PENDING_ACTION' }, [ch.port2]); } catch (e) {}
    }

    /* What the page managed to DO with a tap, told to the worker so the two
       halves of one tap end up on one line. "It arrived" and "it worked"
       are different claims and only the second one answers the question a
       person asks when a button appears dead. */
    function result(id, outcome) {
      if (!id) return;
      post({ type: 'NOTIFY_ACTION_RESULT', id: id, outcome: outcome });
    }

    /* The last few taps, for the sentence under the Notifications switch. */
    function taps(cb) {
      if (!('serviceWorker' in navigator)) { cb([]); return; }
      var ch;
      try { ch = new MessageChannel(); } catch (e) { cb([]); return; }
      var answered = false;
      ch.port1.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.type !== 'ACTION_LOG') return;
        answered = true;
        cb(d.list || []);
      };
      var w = (reg && reg.active) || navigator.serviceWorker.controller;
      if (!w) { cb([]); return; }
      try { w.postMessage({ type: 'GET_ACTION_LOG' }, [ch.port2]); } catch (e) { cb([]); return; }
      setTimeout(function () { if (!answered) cb([]); }, 1200);
    }

    /* ======================================================================
     * REAL PUSH — registering this browser so a SERVER can reach it
     *
     * Everything above draws a notification because a running page asked for
     * one. That is the whole of what this app could do until now, and it is
     * why background notifications kept reading as broken: a phone freezes a
     * tab it has not looked at in a while, and a closed app is not running at
     * all. Neither state can be woken by the page — by definition.
     *
     * A push subscription is a URL the browser mints and the server keeps.
     * Pushing to it wakes the service worker whether or not this page exists.
     *
     * Three rules that are easy to get wrong and silent when you do:
     *  · Subscribe only AFTER permission is granted. `pushManager.subscribe`
     *    prompts by itself otherwise, from wherever it was called, which is
     *    the boot-time prompt this app deliberately does not do.
     *  · Re-subscribe on every open. The endpoint survives, so this is nearly
     *    always a no-op — but it is also the only moment a rotated key or a
     *    server that lost the row can be noticed, and a phone that quietly
     *    stopped receiving reports nothing at all.
     *  · `userVisibleOnly: true` is required by Chrome and is not a setting:
     *    a push that draws nothing is refused at subscribe time.
     * ==================================================================== */
    var pushed = null;      // the subscription this page registered, if any
    var pushNote = '';      // why push is unavailable, in the server's words
    var regFailed = '';     // why there is no worker at all, if there is none

    function pushSupported() {
      return ('serviceWorker' in navigator) && ('PushManager' in window);
    }

    /* Registration failing is not the same as it being slow, and the two
       used to be indistinguishable from here: both left `regs` empty and
       both said nothing. Told which it is, the settings row can name it. */
    function setRegFailed(why) { regFailed = why || 'the background worker could not be started'; }

    /* Chrome takes a base64url string; Safari has wanted the bytes. Handing
       both the bytes costs nothing and removes a per-browser branch that
       would only ever be discovered on the one browser without it. */
    function keyBytes(b64) {
      var pad = '='.repeat((4 - (b64.length % 4)) % 4);
      var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      var out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }

    function pushConfig() {
      return fetch('/api/push', { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    }

    /* `navigator.serviceWorker.ready` never rejects and never times out. It
       waits for an ACTIVE registration, and if one never arrives — the worker
       script 404s, a proxy or a bot wall answers it with HTML, storage is
       full, the tab is in private mode — the promise simply hangs. Every
       `.catch` after it is then unreachable, so the settings row keeps
       whatever it painted last and the person is told nothing at all.
       That is the same shape of fault as the silent notification: working
       code, no output, nothing anywhere to contradict "it doesn't work".
       Losing the race is a real answer and gets said out loud. */
    function swReady() {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var t = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('no-sw'));
        }, 12000);
        navigator.serviceWorker.ready.then(function (r) {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve(r);
        }, function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          reject(e);
        });
      });
    }

    /* Bring the server's idea of this browser in line with this browser's.
       Returns a word for the settings panel: 'on', 'off', 'unsupported', or
       'error' with `pushNote` set to the reason. */
    function pushSync() {
      if (!pushSupported()) { pushNote = ''; return Promise.resolve('unsupported'); }
      if (regFailed) {
        pushNote = 'The background worker could not be started (' + regFailed + '), so ' +
                   'nothing can reach this device while the app is closed. Reopening the app usually settles it.';
        return Promise.resolve('error');
      }

      return swReady().then(function (r) {
        return r.pushManager.getSubscription().then(function (existing) {
          /* Switched off, or never allowed: tear down rather than leave a
             live endpoint on the server. A subscription the person believes
             is off, still able to wake their phone, is worse than no push. */
          if (!on()) {
            pushed = null;
            if (!existing) return 'off';
            var gone = existing.endpoint;
            return existing.unsubscribe().catch(function () { return false; }).then(function () {
              return fetch('/api/push', {
                method: 'DELETE',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: gone })
              }).catch(function () {});
            }).then(function () { return 'off'; });
          }

          return pushConfig().then(function (cfg) {
            if (!cfg || !cfg.ok) { pushNote = 'The server could not be asked about push.'; return 'error'; }
            if (!cfg.configured || !cfg.publicKey) {
              /* The server's own sentence, verbatim. This is the branch that
                 says a key is missing or a placeholder — and the reason it is
                 shown on the phone rather than logged is that a server log is
                 not somewhere the person who can fix it is looking. */
              pushNote = cfg.problem || 'Push is not switched on for this deployment.';
              return 'error';
            }

            var want = keyBytes(cfg.publicKey);
            var reuse = existing;

            /* An existing subscription made against a DIFFERENT key is dead
               and will never be told so: sends to it fail server-side and the
               phone sees nothing. Rotating the keys without this check is how
               push stops working with no error anywhere. */
            if (existing && existing.options && existing.options.applicationServerKey) {
              var had = new Uint8Array(existing.options.applicationServerKey);
              var same = had.length === want.length;
              for (var i = 0; same && i < had.length; i++) if (had[i] !== want[i]) same = false;
              if (!same) reuse = null;
            }

            var step = reuse
              ? Promise.resolve(reuse)
              : (existing ? existing.unsubscribe().catch(function () {}) : Promise.resolve())
                  .then(function () {
                    return r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
                  });

            return step.then(function (sub) {
              pushed = sub;
              return fetch('/api/push', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub)
              }).then(function (res) { return res.json(); }).then(function (j) {
                if (j && j.ok) { pushNote = ''; return 'on'; }
                pushNote = (j && j.error) || 'The server would not keep this browser.';
                return 'error';
              });
            }).catch(function (e) {
              /* A refusal here is nearly always the permission being revoked
                 between the check and the call, or an iOS copy that is not on
                 the Home Screen. Either way the message is the browser's. */
              pushNote = (e && e.message) || 'This browser refused to register for push.';
              return 'error';
            });
          });
        });
      }).catch(function (e) {
        pushNote = (e && e.message === 'no-sw')
          ? 'This browser never started the background worker, so nothing can be delivered while the app is closed. Closing and reopening the app usually settles it.'
          : 'The service worker is not ready yet.';
        return 'error';
      });
    }

    /* Fire one, for real, through the server. The only thing that can answer
       "does a push actually reach this handset", which is a question no
       amount of correct code can settle from a laptop. */
    function pushTest() {
      return fetch('/api/push?test=1', { method: 'POST', credentials: 'include' })
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, error: 'The server could not be reached.' }; });
    }

    function pushWhy() { return pushNote; }

    return {
      setReg: setReg, setRegFailed: setRegFailed, state: state, on: on, ask: ask, off: setOff,
      show: show, update: update, close: close, clearAll: clearAll,
      onAction: onAction, onChange: onChange, standalone: standalone,
      drainPending: drainPending, result: result, taps: taps,
      pushSync: pushSync, pushTest: pushTest, pushWhy: pushWhy,
      pushSupported: pushSupported
    };
  })();

  /* The Notifications row in More.
   *
   * Five states, five sentences. The one that matters most is `blocked`:
   * once a browser has been told no, this app cannot ask again — the switch
   * is dead and the only true thing to say is where the setting lives. A
   * toggle that silently does nothing there is the worst version of this
   * screen, and it is the version almost every web app ships. */
  (function wireNotifySetting() {
    var row = $('notifyToggle');
    if (!row) return;
    var note = $('notifyNote');
    var saved = $('notifySaved');

    var COPY = {
      on: 'Casting, upload progress and anything that goes wrong, while you are in another app.',
      off: 'Turned off. Nothing will be said while you are in another app.',
      ask: 'Casting, upload progress and anything that goes wrong, while you are in another app. Tap to allow it.',
      blocked: 'Your browser is blocking notifications for this site. This switch cannot undo that — ' +
               'it has to be changed in the browser\'s own settings for this address, under Notifications.',
      'needs-install': 'On an iPhone this only exists in the copy added to the Home Screen. ' +
                       'Share → Add to Home Screen, then open Cast Bridge from there.',
      none: 'This browser has no notifications to give.'
    };

    function say(text, bad) {
      saved.textContent = text;
      saved.classList.toggle('is-bad', Boolean(bad));
      saved.hidden = !text;
    }

    function paint(state) {
      var checked = state === 'on';
      row.setAttribute('aria-checked', checked ? 'true' : 'false');
      row.disabled = state === 'blocked' || state === 'needs-install' || state === 'none';
      note.textContent = COPY[state] || COPY.ask;
    }

    notify.onChange(paint);
    paint(notify.state());

    /* What became of the last tap in the shade.
     *
     * A Pause that does nothing can fail in three places that cannot see
     * each other: the worker never delivered it, the page took it and did
     * nothing, or the television refused. None of that is visible from a
     * handset, and describing the symptom out loud has already cost three
     * attempts at the wrong fix. So the app says which one it was.
     *
     * One sentence, and only when there has been a tap — a diagnostic
     * nobody needs is clutter, and this screen is a settings screen. */
    var tapsEl = $('notifyTaps');
    var TAPPED = { toggle: 'Pause', stop: 'Stop', cancel: 'Cancel' };

    function tapSentence(e) {
      var what = TAPPED[e.action] || 'a button';
      var when = ago(e.at);
      var tail;

      if (e.route === 'written-down' && !e.woke) {
        tail = 'nothing could be woken to perform it';
      } else if (e.route === 'written-down') {
        tail = e.outcome === 'performed'
          ? 'no page was awake, so the app was opened and it was done'
          : e.outcome === 'no-session'
            ? 'the app was opened, but the television could not be reached'
            : e.outcome === 'refused'
              ? 'the app was opened and the television refused it'
              : 'the app was opened and never performed it';
      } else {
        tail = e.outcome === 'performed'
          ? 'the app did it'
          : e.outcome === 'no-session'
            ? 'the app had it, but the television could not be reached'
            : e.outcome === 'refused'
              ? 'the television refused it'
              : 'the app took it and never said what it did';
      }
      /* "The shade" is what a developer calls it. The person reading this
         tapped a button on a notification. */
      return 'You tapped ' + what + ' ' + when + '. ' +
        tail.charAt(0).toUpperCase() + tail.slice(1) + '.';
    }

    function paintTaps() {
      if (!tapsEl) return;
      notify.taps(function (list) {
        var e = list && list[0];
        if (!e || !e.at) { tapsEl.hidden = true; return; }
        tapsEl.textContent = tapSentence(e);
        tapsEl.hidden = false;
      });
    }

    /* ------------------------------------------------------------------
     * Push: the state, and the one button that can prove it
     *
     * "Notifications are on" has never been the whole truth. It says this
     * browser granted permission; it says nothing about whether a server can
     * reach it while the app is shut, which is the thing that was actually
     * missing and the thing that cannot be established from here. So the
     * state is reported separately, and the test send is a real push down
     * the real path — the only way anybody finds out whether the handset's
     * own settings are swallowing it.
     * ---------------------------------------------------------------- */
    var pushEl = $('notifyPush');
    var testBtn = $('notifyTest');

    function paintPush(word) {
      if (!pushEl) return;
      if (typeof word === 'undefined') { pushEl.hidden = true; return; }
      var why = notify.pushWhy();
      var text = '';
      if (word === 'on') text = 'This device is registered — the server can reach it while the app is closed.';
      else if (word === 'off') text = '';
      else if (word === 'unsupported') text = 'This browser has no push, so notifications only arrive while the app is running.';
      else text = why || 'This device could not be registered for push.';
      if (!text) { pushEl.hidden = true; }
      else { pushEl.textContent = text; pushEl.hidden = false; }
      if (testBtn) testBtn.hidden = (word !== 'on');
    }

    if (testBtn) {
      testBtn.addEventListener('click', function () {
        testBtn.disabled = true;
        var before = testBtn.textContent;
        testBtn.textContent = 'Sending…';
        notify.pushTest().then(function (out) {
          testBtn.disabled = false;
          testBtn.textContent = before;
          if (!out || out.ok === false) { say((out && out.error) || 'That did not send.', true); return; }
          if (!out.installs) { say('Nothing is registered yet. Turn the switch off and on again.', true); return; }
          if (!out.sent) {
            /* Accepted by nobody. Naming the count is the difference between
               "the app is broken" and "the one device you registered is
               gone", which have different fixes. */
            say('The push service refused all ' + out.installs + ' registered device' +
                (out.installs === 1 ? '' : 's') + '.', true);
            return;
          }
          /* Deliberately not "delivered". The push service accepted it; what
             the handset then does with it is the operating system's decision
             and this app cannot see it. Claiming delivery here is exactly the
             lie that made the last two rounds of this unfalsifiable. */
          say('Sent to ' + out.sent + ' device' + (out.sent === 1 ? '' : 's') +
              '. If nothing appears, the phone is holding it back, not the app.');
        });
      });
    }

    notify.pushSync().then(paintPush);

    paintTaps();
    /* Refreshed when the row is actually looked at, which needs no
       knowledge of how views are switched — and a stale sentence on a
       screen nobody is on costs nothing to leave alone. */
    if (tapsEl && window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) { paintTaps(); return; }
        }
      }).observe(tapsEl.parentNode);
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) paintTaps();
    });

    row.addEventListener('click', function () {
      var state = notify.state();
      if (state === 'on') {
        notify.off();
        paint(notify.state());
        say('Off.');
        /* Not fire-and-forget bookkeeping: this deletes the endpoint at the
           server. Left behind, it would still be able to wake the phone,
           which is precisely what the switch just said would not happen. */
        notify.pushSync().then(paintPush);
        return;
      }

      notify.ask().then(function (next) {
        paint(next);
        if (next === 'on') {
          say('On — saved.');
          /* Only now. Subscribing before the grant makes the browser raise
             its own prompt from wherever the call happened to be. */
          notify.pushSync().then(paintPush);
          return;
        }
        if (next === 'blocked') {
          /* Said twice on purpose. The note explains the state; this line
             confirms that the tap was received and did what it could. */
          say('The browser refused. Change it in your browser\'s settings for this site.', true);
          return;
        }
        say('Not allowed yet.', true);
      });
    });
  })();

  /* Hold the room the busy word will need, before it is ever needed.
   *
   * Locking the width at the moment of the swap only stops the button
   * SHRINKING. "Reading…" is wider than "Play", so the button still grew
   * from 65px to 126px on tap and took 61px off the address field beside
   * it — measured. Reserving the wider of the two at boot means the idle
   * button is already that size and the swap moves nothing at all. */
  function reserveBusy(btn, labels) {
    if (!btn) return;
    var el = btn.querySelector('.cb-label');
    if (!el) return;
    var idle = el.textContent;
    var widest = btn.offsetWidth;
    for (var i = 0; i < labels.length; i++) {
      el.textContent = labels[i];
      btn.classList.add('is-busy');
      widest = Math.max(widest, btn.offsetWidth);
      btn.classList.remove('is-busy');
    }
    el.textContent = idle;
    btn.style.minWidth = widest + 'px';
  }

  function busy(btn, on, label) {
    var el = btn.querySelector('.cb-label');
    if (on) {
      /* Only a button nobody reserved for needs this, and it can still only
         stop a shrink. reserveBusy is the one that stops the shove. */
      if (!btn.style.minWidth) btn.style.minWidth = btn.offsetWidth + 'px';
      if (el && label) {
        if (!el.dataset.idle) el.dataset.idle = el.textContent;
        el.textContent = label;
      }
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
    } else {
      if (el && el.dataset.idle) {
        el.textContent = el.dataset.idle;
        delete el.dataset.idle;
      }
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
    }
  }

  /* ------------------------------------------------------------------ *
   * Field errors — inline, under the field, with a way out
   * ------------------------------------------------------------------ */

  /* `input` is optional. A form whose message covers two fields at once — the
     people form answers for the username AND the password with one sentence —
     has no single field to mark, and passing null used to throw here, which
     killed the submit handler before it ever reached the network. */
  function fieldError(input, box, message, action) {
    box.innerHTML = '';
    if (!message) {
      box.classList.remove('is-shown');
      if (input) input.removeAttribute('aria-invalid');
      return;
    }
    var span = document.createElement('span');
    span.textContent = message;
    box.appendChild(span);
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      box.appendChild(b);
    }
    box.classList.add('is-shown');
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  /* ------------------------------------------------------------------ *
   * Screens
   *
   * This used to be one page: a player, then a four-tab strip, then four
   * collapsed panels stacked under the action row. Everything was reachable
   * and nothing was findable — the Bilibili sign-in, the stream host and a
   * page of instructions about screen mirroring all sat in the same column
   * as the paste box, and the page read as a pile.
   *
   * So: nine screens, one job each, and a bar at the bottom. Five entries
   * fit a thumb; the other four live behind More rather than being crammed
   * into a strip too narrow to hit. A screen is a route — the phone's own
   * Back button walks it, and each one remembers where it was scrolled to,
   * because coming back to History and landing at the top is the same bug
   * as losing the page.
   * ------------------------------------------------------------------ */

  var VIEWS = ['cast', 'browse', 'library', 'history', 'more',
    'bilibili', 'host', 'people', 'help'];

  var NAV_VIEWS = ['cast', 'browse', 'library', 'history', 'more'];

  /* The four behind More light More up while they are open, so the bar
     never shows nothing selected. */
  var NAV_OF = {
    bilibili: 'more', host: 'more', people: 'more', help: 'more'
  };

  /* The names the rest of this file already calls, kept working rather than
     renamed at sixty call sites. */
  var VIEW_ALIAS = { link: 'cast', users: 'people' };

  var activeView = 'cast';
  var scrollMemory = {};

  function viewEl(name) { return $('view-' + name); }

  /* Drawn on arrival, not on sign-in: three of these cost a round trip to a
     second machine, and paying for them on a screen nobody opened is how an
     app feels slow for no reason. */
  function onEnterView(name) {
    if (name === 'browse') refreshSeries();
    if (name === 'history') renderHistory();
    if (name === 'people') renderUsers();
    if (name === 'library') renderLibrary();
    if (name === 'bilibili') refreshBili();
    if (name === 'host') renderHost();
  }

  /* Walking away from a screen has to stop what that screen started. The
     Bilibili poll is a request every two seconds against a key that lives
     three minutes — left running it is traffic nobody is watching. */
  function onLeaveView(name) {
    if (name === 'bilibili') stopBiliPoll();
  }

  function showView(name, opts) {
    name = VIEW_ALIAS[name] || name;
    if (VIEWS.indexOf(name) === -1) return;
    opts = opts || {};

    if (name !== activeView) {
      scrollMemory[activeView] = window.scrollY;
      onLeaveView(activeView);
    }
    activeView = name;

    VIEWS.forEach(function (v) {
      var el = viewEl(v);
      if (!el) return;
      var on = v === name;
      el.hidden = !on;
      el.classList.toggle('is-on', on);
    });

    var lit = NAV_OF[name] || name;
    NAV_VIEWS.forEach(function (v) {
      var btn = $('nav-' + v);
      if (!btn) return;
      var on = v === lit;
      btn.classList.toggle('is-on', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    /* The phone's Back button is the one every hand reaches for, so a screen
       change is a real history entry. A pop replays it without pushing, or
       Back would need pressing twice for every screen it ever showed. */
    if (opts.push && window.history && window.history.pushState) {
      window.history.pushState({ view: name }, '', '#' + name);
    }

    if (opts.focus) {
      var focusTarget = viewEl(name);
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
    /* A screen you have opened before comes back where you left it. A screen
       you have just navigated to opens at the top, because its first line is
       the thing you went there for. */
    var y = opts.push ? 0 : scrollMemory[name];
    window.scrollTo({ top: typeof y === 'number' ? y : 0, behavior: 'auto' });

    onEnterView(name);
  }

  /* Every call already in this file goes through here. link → cast and
     users → people; the rest are unchanged. */
  function showTab(name, opts) { showView(name, opts); }

  NAV_VIEWS.forEach(function (v) {
    var btn = $('nav-' + v);
    if (btn) {
      btn.addEventListener('click', function () {
        showView(v, { focus: true, push: true });
      });
    }
  });

  /* The rows inside More, and the Menu button at the top of each screen it
     leads to. One listener, because both are just "go there". */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var row = e.target.closest('.cb-menurow');
    if (row && row.dataset.view) {
      showView(row.dataset.view, { focus: true, push: true });
      return;
    }
    var back = e.target.closest('.cb-back');
    if (back) {
      /* Back to the menu, not back through history: arriving at Stream host
         from somewhere else and then tapping Menu should still land on More. */
      showView(back.dataset.back || 'more', { focus: true, push: true });
    }
  });

  window.addEventListener('popstate', function (e) {
    var name = (e.state && e.state.view) || (location.hash || '').replace('#', '') || 'cast';
    showView(name);
  });

  /* A reload, or a link into a screen, opens on that screen. An unknown
     fragment is not an error worth a message — it opens on Cast. */
  (function initialView() {
    var wanted = (location.hash || '').replace('#', '');
    var start = VIEWS.indexOf(wanted) === -1 ? 'cast' : wanted;
    if (window.history && window.history.replaceState) {
      window.history.replaceState({ view: start }, '',
        start === 'cast' ? location.pathname : '#' + start);
    }
    showView(start);
  }());

  /* ------------------------------------------------------------------ *
   * Player
   * ------------------------------------------------------------------ */

  var video = $('video');
  var screenEl = $('screen');
  var statusDot = $('statusDot');
  var statusText = $('statusText');
  var statusBox = $('status');
  var qualitySel = $('quality');

  var current = null;      // the media URL now loaded
  var currentTitle = '';
  /* The page the media was playing on. Hosts that check a referer want
     this one, not ours, and it is what /api/stream forwards on our behalf. */
  var currentFrom = '';
  /* The quality that was chosen, when the scan offered a choice. Hosts of
     this kind serve every rendition as the same filename, so if the bridge
     ever has to ask the page for a fresh address this is the only thing
     that tells 720p apart from 192p. */
  var currentLabel = '';
  /* Every other stream the same scan found. The rules live in
     assets/js/sources.js so they can be proved without a browser; this file
     owns the DOM and the loading, which cannot be. */
  var sources = window.CBSources.create({
    isHttp: isHttp, kindOf: kindOf, nameOf: nameOf
  });
  var hls = null;
  /* The DASH counterpart of `hls`. No phone browser plays a DASH manifest
     from a bare <video src>, so a Bilibili TV film — which only exists as
     DASH — used to resolve, name its quality and size, and then sit there. */
  var dash = null;
  /* One proxy retry per load, or a stream that is genuinely gone loops. */
  var hlsProxied = false;
  var castState = 'NO_DEVICES_AVAILABLE';
  var lastSaved = 0;

  /* The Cast remote. Null until the sender library is up; the panel that
     drives it stays hidden until the TV reports media actually loaded. */
  var remotePlayer = null;
  var remoteCtl = null;
  var scrubbing = false;
  var lastPlayerState = null;

  /* Subtitles, as the address of our own converted copy — never the file
     the person pasted, which is almost never VTT and almost never CORS. */
  /* Set by load(); read by the player and by every cast attempt for the
     address currently loaded. */
  var forceProxy = false;

  var subsProxy = '';
  var subsName = '';

  function setStatus(text, kind) {
    statusText.textContent = text;
    statusDot.className = 'cb-dot' + (kind ? ' is-' + kind : '');
    statusBox.classList.toggle('is-bad', kind === 'bad');
  }

  /* One pill, six possible values, and they used to be written in two
     different cases: five hand-written strings in lower case ("looking…",
     "no devices", "device ready", "connecting", "no cast") and, in the
     connected state, a TV's own name — "Living Room TV" — which arrives
     capitalised and cannot be talked out of it. So the same component said
     `device ready` one second and `Living Room TV` the next.
     Sentence case is the app's convention everywhere else (buttons, status
     line, scan stages); the pill now follows it. Any new value goes in
     sentence case too — the device name is the reason, and it is not
     going to change. */
  function setPill(text, kind) {
    const el = $('devicePillText');
    el.textContent = text;
    /* The pill truncates a long TV name rather than shoving the page
       sideways, so the full name has to stay reachable somewhere. */
    el.title = text;
    $('devicePillDot').className = 'cb-dot' + (kind ? ' is-' + kind : '');
  }

  /* Safari plays HLS itself, in the media stack, with hardware decoding.
   * hls.js plays it through Media Source Extensions instead — and an MSE
   * stream cannot be AirPlayed. AirPlay hands the television a source to
   * fetch; there is no source, only buffers this page appended.
   *
   * Hls.isSupported() is true on macOS Safari and on iPadOS, so the old
   * check picked hls.js on exactly the browsers where it costs the feature
   * this app has an AirPlay button for. Native first wherever it exists;
   * hls.js everywhere else, which is where it is the only option anyway. */
  function nativeHls() {
    return Boolean(video.canPlayType &&
      (video.canPlayType('application/vnd.apple.mpegurl') ||
       video.canPlayType('application/x-mpegURL')));
  }

  function teardownHls() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    qualitySel.hidden = true;
    qualitySel.innerHTML = '<option value="-1">Auto</option>';
  }

  /* Attach hls.js to an address. Separate from load() because a stream the
     host refuses is retried here against the same media through our own
     origin, and that retry has to run the identical setup. */
  function playHls(src) {
    hls = new window.Hls({
      startLevel: -1, capLevelToPlayerSize: false,
      maxBufferLength: 60, maxMaxBufferLength: 120, backBufferLength: 30,
      abrEwmaDefaultEstimate: 5e6, lowLatencyMode: false
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, function (_, data) {
      if (data.levels && data.levels.length > 1) {
        data.levels.map(function (l, i) { return { i: i, h: l.height, b: l.bitrate }; })
          .sort(function (a, b) { return b.h - a.h; })
          .forEach(function (l) {
            var o = document.createElement('option');
            o.value = l.i;
            o.textContent = l.h ? l.h + 'p' : Math.round(l.b / 1000) + 'k';
            qualitySel.appendChild(o);
          });
        qualitySel.hidden = false;
      }
    });
    hls.on(window.Hls.Events.ERROR, function (_, data) {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        /* Almost always the host refusing a request that does not carry
           the page it was embedded in, or simply sending no cross-origin
           header. Both are what /api/stream is for, so try that before
           telling anyone it cannot be played — one retry only, or a
           stream that is genuinely gone loops here forever. */
        if (!hlsProxied) {
          hlsProxied = true;
          setStatus('The host blocked that fetch — routing it through the bridge.', '');
          teardownHls();
          playHls(streamUrl(current));
          return;
        }
        /* Refused through our own origin as well. Another address from the
           same scan is the cheap thing to try before telling anyone this
           needs a television — see the note in the <video> error handler
           for why casting is left alone. */
        if (castState !== 'CONNECTED' &&
            advanceSource('That host blocked the stream')) return;

        setStatus('This stream won\'t open in a browser tab — the server blocks it. The TV can still fetch it directly.', 'bad');
        toast({
          text: 'Blocked here, but Cast and VLC fetch it themselves.',
          actionLabel: 'Open in VLC',
          onAction: handoffVlc
        });
      } else {
        if (castState !== 'CONNECTED' &&
            advanceSource('That stream failed — ' + data.details)) return;
        setStatus('Stream error: ' + data.details, 'bad');
      }
    });
  }

  /* Shaka Player, fetched the first time a DASH address is opened rather
     than on every page load — it is ~750 KB and most films are not DASH.
     The same library the Cast receiver runs, so what plays here is what the
     television will be asked to play. */
  var SHAKA_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.16.8/shaka-player.compiled.js';
  var shakaReady = null;
  function loadShaka() {
    if (window.shaka) return Promise.resolve(window.shaka);
    if (shakaReady) return shakaReady;
    shakaReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SHAKA_SRC;
      s.async = true;
      s.onload = function () {
        if (!window.shaka) { reject(new Error('shaka missing')); return; }
        window.shaka.polyfill.installAll();
        resolve(window.shaka);
      };
      s.onerror = function () { shakaReady = null; reject(new Error('shaka failed to load')); };
      document.head.appendChild(s);
    });
    return shakaReady;
  }

  function teardownDash() {
    if (dash) { try { dash.destroy(); } catch (e) {} dash = null; }
  }

  function playDash(src, autoplay) {
    var mine = src;
    setStatus('Opening the stream…', '');
    loadShaka().then(function (shaka) {
      /* Another film was opened while the library was downloading. */
      if (current !== mine) return;
      if (!shaka.Player.isBrowserSupported()) {
        setStatus('This browser can\'t play this kind of stream. Cast it — the TV can.', 'bad');
        return;
      }
      teardownDash();
      var player = new shaka.Player();
      dash = player;
      player.configure({ streaming: { bufferingGoal: 60, rebufferingGoal: 4 } });
      player.addEventListener('error', function (ev) {
        var err = ev && ev.detail;
        logCast('Player error', err ? 'shaka ' + err.code : 'unknown');
        setStatus('Stream error (' + (err ? err.code : '?') + '). Paste the link again if it has been a while.', 'bad');
      });
      return player.attach(video).then(function () {
        return player.load(src, null, 'application/dash+xml');
      }).then(function () {
        if (dash !== player) return;
        setStatus('', '');
        if (autoplay && castState !== 'CONNECTED') {
          video.play().catch(function () { /* autoplay policy */ });
        }
      });
    }).catch(function (err) {
      if (current !== mine) return;
      var code = err && err.code;
      logCast('Player error', code ? 'shaka ' + code : String(err && err.message || err));
      /* 1001 is a refused manifest request — in practice an expired link. */
      setStatus(code === 1001
        ? 'That link has expired. Paste the Bilibili TV link again.'
        : 'This stream wouldn\'t open here (' + (code || 'load failed') + '). Casting may still work.', 'bad');
    });
  }

  /* The same address, fetched by us on the television's behalf.
   *
   * Two things stop a receiver reading a CDN address directly, and neither
   * is about how the address was found: the host serves segments only to a
   * request carrying the page they were embedded in, and Cast requires HLS
   * and DASH to be served cross-origin-open, which a CDN that never
   * expected a television is not. Going through our own origin fixes both.
   */

  /* WHERE THE TELEVISION FETCHES THROUGH.
   *
   * The proxy is the one endpoint that carries the film itself, and on
   * Vercel every byte of it is billed twice — once function-to-CDN, once
   * CDN-to-television — with no free allowance on the first leg. That is
   * about $0.27 a gigabyte, so a 5 GB film costs $1.35 to watch, and since
   * every HLS stream is proxied by definition, that is the ordinary case.
   *
   * The same bytes leave our own server in Singapore for nothing, a few
   * milliseconds from the television asking for them. So that is the first
   * address tried.
   *
   * The second entry is this origin — the Vercel function, unchanged and
   * still deployed. It is not decoration: a box that is down, rebooting or
   * mid-deploy would otherwise take casting down with it, and the fallback
   * costs nothing while it is not being used. A stream that stalls or is
   * refused on the first host is retried on the second before anyone is
   * told it cannot be played.
   */
  var STREAM_HOSTS = ['https://stream.jrvsystems.app', ''];
  var streamHostIndex = 0;

  /* Moves to the next host, or reports that there is not one. */
  function nextStreamHost() {
    if (streamHostIndex + 1 >= STREAM_HOSTS.length) return false;
    streamHostIndex++;
    return true;
  }

  function streamUrl(u, absolute) {
    var out = STREAM_HOSTS[streamHostIndex] + '/api/stream?u=' + encodeURIComponent(u);
    if (currentFrom && /^https?:/i.test(currentFrom)) {
      out += '&r=' + encodeURIComponent(currentFrom);
    }
    if (currentLabel) out += '&q=' + encodeURIComponent(currentLabel);
    /* The receiver is a different device. It resolves whatever it is handed
       against its own origin, not this page's, so a root-relative path
       reaches nothing at all on the television — which looks exactly like
       "it says loading and then nothing happens". The tab can use the short
       form; anything handed to the TV has to be absolute. */
    return absolute ? new URL(out, location.href).toString() : out;
  }

  /* ------------------------------------------------------------------ *
   * Cast log
   *
   * "The TV says loading and nothing happens" is not answerable from a
   * one-line status, because the useful part is a sequence: which address
   * went over, what the receiver said about it, and what state it settled
   * in. All of it is recorded here in order and can be copied out whole.
   * ------------------------------------------------------------------ */

  var castLogEl = $('castLog');
  var castLogLines = $('castLogLines');
  var castLogEntries = [];
  var CAST_LOG_CAP = 120;

  function stamp(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function castLogText() {
    return castLogEntries.map(function (e) {
      return stamp(e.at) + '  ' + e.line + (e.detail ? '\n          ' + e.detail : '');
    }).join('\n');
  }

  function paintCastLog() {
    if (!castLogEl) return;
    var n = castLogEntries.length;
    castLogEl.hidden = n === 0;
    $('castLogSummary').textContent = n
      ? 'Cast log · ' + n + (n === 1 ? ' line' : ' lines')
      : 'Cast log';
    castLogLines.textContent = castLogText();
    castLogLines.scrollTop = castLogLines.scrollHeight;   // newest is the one being read
  }

  function logCast(line, detail) {
    castLogEntries.push({
      at: Date.now(),
      line: String(line),
      detail: (detail === undefined || detail === null) ? '' : String(detail)
    });
    if (castLogEntries.length > CAST_LOG_CAP) castLogEntries.shift();
    paintCastLog();
  }

  function openCastLog(bad) {
    if (!castLogEl) return;
    castLogEl.hidden = false;
    castLogEl.open = true;
    castLogEl.classList.toggle('is-bad', !!bad);
  }

  /* A Cast failure arrives either as a bare error-code string or as an
     object carrying a description — print whichever it is rather than
     "[object Object]", which is what a bare concatenation would give. */
  function describeCastError(err) {
    if (!err) return 'no reason given';
    if (typeof err === 'string') return err;
    var bits = [];
    if (err.code) bits.push('code ' + err.code);
    if (err.description) bits.push(err.description);
    if (err.details) {
      try { bits.push(JSON.stringify(err.details)); } catch (e) { /* circular */ }
    }
    if (!bits.length) {
      try { bits.push(JSON.stringify(err)); } catch (e) { bits.push(String(err)); }
    }
    return bits.join(' · ');
  }

  if (castLogEl) {
    $('btnCopyLog').addEventListener('click', function () {
      var text = castLogText();
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast({ text: 'Cast log copied.' }); },
          function () { toast({ text: 'Couldn\'t reach the clipboard — select the log and copy it.' }); }
        );
      } else {
        toast({ text: 'Select the log above and copy it.' });
      }
    });
    $('btnClearLog').addEventListener('click', function () {
      castLogEntries = [];
      castLogEl.classList.remove('is-bad');
      castLogEl.open = false;
      paintCastLog();
    });
  }

  /* ---------- Source set ---------- */

  var sourcesBox = $('sources');
  var sourcePick = $('sourcePick');

  function renderSources() {
    /* One source is not a choice, and a picker offering it is a control
       that cannot do anything. Hidden rather than disabled — a disabled
       control is a promise of something you might unlock. */
    if (sources.count() < 2) {
      sourcesBox.hidden = true;
      sourcePick.innerHTML = '';
      return;
    }

    sourcesBox.hidden = false;
    sourcePick.innerHTML = '';
    sources.list().forEach(function (m, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = (i + 1) + ' of ' + sources.count() + ' \u00b7 ' + sources.name(i);
      sourcePick.appendChild(o);
    });
    sourcePick.value = String(Math.max(0, sources.at()));
  }

  /* Load one of the set. `why` is null for a deliberate pick and a sentence
     for an automatic hop — the difference is whether the person is told
     anything, because a switch they made themselves needs no announcement. */
  /* One tap, one switch. Not a cooldown — somebody stepping through four
     sources looking for the one that works should be able to tap four times
     in four seconds. This only refuses the second half of a double-fire,
     and it is released by the element reporting back rather than by a
     timer, so it cannot outlive the load it is guarding. */
  var switching = false;

  ['loadstart', 'error', 'emptied', 'loadedmetadata'].forEach(function (ev) {
    video.addEventListener(ev, function () {
      switching = false;
      sourcesBox.classList.remove('is-switching');
    });
  });

  function playSource(i, why) {
    var m = sources.item(i);
    if (!m) return false;
    if (switching) return false;
    switching = true;
    sourcesBox.classList.add('is-switching');
    var ok = load(m.url, {
      title: m.label || currentTitle,
      label: m.label || '',
      from: currentFrom,
      /* Left empty rather than carried across: load() falls back to the
         cover remembered on the history row, which is the page's own
         artwork. artwork.current() may by now be a frame grabbed off the
         video, and a frame of the stream that just failed is not a cover. */
      poster: '',
      sources: sources.list(),
      sourceIndex: i
    });
    if (!ok) {
      switching = false;
      sourcesBox.classList.remove('is-switching');
      return false;
    }
    if (why) {
      setStatus(why + ' \u2014 trying source ' + (i + 1) + ' of ' + sources.count() + '.', '');
      toast({ text: why + '. Now on ' + sources.name(i) + '.', ms: 6000 });
    }
    return true;
  }

  /* The automatic hop, after something failed to play. Returns false when
     there is nowhere left to go, so the caller says the thing it was going
     to say anyway rather than failing silently. */
  function advanceSource(why) {
    var i = sources.takeAuto();
    if (i < 0) return false;
    return playSource(i, why);
  }

  sourcePick.addEventListener('change', function () {
    var i = parseInt(sourcePick.value, 10);
    if (isNaN(i) || i === sources.at()) return;
    playSource(i, null);
  });

  $('btnNextSource').addEventListener('click', function () {
    var i = sources.next();
    if (i < 0) return;
    if (playSource(i, null)) {
      toast({
        text: (i === 0 ? 'Back to the first source \u2014 ' : 'Source ' + (i + 1) +
          ' of ' + sources.count() + ' \u2014 ') + sources.name(i) + '.',
        ms: 5000
      });
    }
  });

  function load(rawUrl, meta) {
    meta = meta || {};
    var u = String(rawUrl || '').trim();

    if (!isHttp(u)) {
      fieldError($('url'), $('urlError'), 'That needs to be a full address starting with http:// or https://');
      return false;
    }
    fieldError($('url'), $('urlError'), null);

    u = resolveShare(u);
    current = u;
    currentTitle = meta.title || nameOf(u);
    currentFrom = meta.from || '';
    currentLabel = meta.label || '';
    hlsProxied = false;
    /* The siblings this address arrived with. An address that arrived on
       its own — pasted, opened from a file, deep-linked — genuinely has
       none, and passing nothing here clears the last page's set rather
       than leaving a picker pointing at a different film. */
    /* The siblings this address arrived with. An address that arrived on
       its own — pasted, opened from a file, deep-linked — genuinely has
       none, and passing nothing here clears the last page's set rather than
       leaving a picker pointing at a different film. */
    sources.set(meta.sources || [], u, meta.sourceIndex);
    renderSources();
    /* Some addresses are only fetchable with the referer of the page they
       belong to — Bilibili's CDN is the case this exists for, and it answers
       403 to anything else. That is true of the phone as well as the
       television: a <video> element sends this app's origin as the referer
       and gets the same 403. So the bridge is not a retry here, it is the
       route, and it is taken on the first attempt rather than after a
       failure the person would have watched happen. */
    forceProxy = Boolean(meta.proxy);
    $('url').value = u;

    teardownHls();
    teardownDash();
    screenEl.classList.remove('is-idle');
    screenEl.classList.add('is-live');

    var isDash = mimeOf(u) === 'application/dash+xml';
    if (mimeOf(u) === 'application/x-mpegURL' && !nativeHls() &&
        window.Hls && window.Hls.isSupported()) {
      playHls(u);
    } else if (isDash) {
      /* Never via /api/stream: that relays an .mpd without rewriting it
         (see castLoad). Ours already carry proxied segment URLs.
         The old film is cleared first so it does not keep playing while
         the player library downloads. */
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
      playDash(u, true);
    } else {
      /* Native HLS included: Safari takes the playlist address directly and
         picks its own rendition, so the quality menu has nothing to offer
         and stays hidden (teardownHls already did that). */
      video.src = forceProxy ? streamUrl(u) : u;
    }

    var record = store.touch(u, {
      title: currentTitle, from: meta.from || '', poster: meta.poster || '',
      sources: sources.forStore()
    });
    /* The cover the scan found, or the one remembered from the last time
       this address was played — which is what makes a film opened from
       History or resumed from the TV arrive with its picture rather than
       only the ones opened from a fresh scan. */
    /* The title and the host go with it: without a poster and without a
       readable frame, they are the only things a cover can be made out of. */
    artwork.set(meta.poster || (record && record.poster) || '', {
      title: currentTitle,
      from: meta.from || currentFrom || hostOf(u) || ''
    });
    /* Local first so the list is instant, then up to the server, which is
       the copy that survives a reinstall or a different phone. */
    recordPlay(u, { title: currentTitle, kind: record && record.kind });
    updateHistCount();

    /* Pick up where they left off, and offer the way back. */
    var resumeAt = record.pos > 30 && (!record.dur || record.pos < record.dur - 20) ? record.pos : 0;
    if (resumeAt) {
      var seek = function () {
        try { video.currentTime = resumeAt; } catch (e) {}
        video.removeEventListener('loadedmetadata', seek);
      };
      video.addEventListener('loadedmetadata', seek);
      toast({
        text: 'Picked up at ' + clock(resumeAt) + '.',
        actionLabel: 'Start over',
        onAction: function () { try { video.currentTime = 0; } catch (e) {} },
        ms: 8000
      });
    }

    $('btnVlc').disabled = false;
    $('btnCopy').disabled = false;
    /* Named before it plays, so the lock screen never shows the previous
       film's title over this one's audio. */
    mediaSession.update({ state: 'paused' });
    /* A different film is a different subtitle file. Carrying the last one
       across would silently caption the wrong thing. */
    clearSubs();
    subsBox.hidden = false;
    updateCastUi();

    /* Already on the TV: the phone is the remote, not a second speaker.
       Playing locally as well is two audio tracks a few seconds apart, in
       the same room. The element still loads (metadata, resume seek, the
       scrubber) — it just stays paused. */
    if (castState === 'CONNECTED') {
      video.pause();
      stallRetried = false;
      castLoad(u, { viaProxy: forceProxy });
    } else if (!isDash) {
      /* DASH starts itself once Shaka has the manifest; playing an element
         with no source yet only rejects. */
      video.play().catch(function () { /* autoplay policy — the controls are right there */ });
    }
    return true;
  }

  qualitySel.addEventListener('change', function () {
    if (hls) hls.currentLevel = parseInt(qualitySel.value, 10);
  });

  video.addEventListener('error', function () {
    if (!current) return;
    /* Shaka reports its own failures; the proxy retry below would hand the
       manifest to /api/stream, which cannot serve one. */
    if (dash) return;
    /* A file picked off the phone is not a link, and telling someone to go
       and scan the page it came from is advice about a page that does not
       exist. The cause is different too: an address that fails is usually
       the wrong kind of address, a file that fails is a codec this browser
       does not have. */
    if (localPick && !localPick.remote) {
      setStatus('This browser can\'t decode that file. A television may still ' +
        'manage it — send it over and see.', 'bad');
      return;
    }

    /* hls.js retries a refused stream through our own origin from inside its
       own error handler. The native player has no such hook, so on Safari —
       where native HLS is now preferred, precisely so AirPlay works — a host
       that refuses this origin used to end here with a wrong explanation
       about webpages. Same retry, one level up, and guarded by the same flag
       so it happens once. */
    if (!hlsProxied && current && isHttp(current) &&
        current.indexOf(STREAM_HOSTS[0] + '/api/stream') !== 0 &&
        current.indexOf(location.origin + '/api/stream') !== 0) {
      hlsProxied = true;
      logCast('Retrying', 'the host refused this origin — serving through the bridge');
      var via = streamUrl(current, true);
      video.src = via;
      video.load();
      setStatus('That host refused us. Trying again through the bridge…', '');
      return;
    }
    /* The bridge could not save it either. If the same scan found other
       addresses for this episode, one of them is the next thing to try —
       and it is already in hand, so trying it costs nothing but a load.
       Only while the phone is playing: on a television the receiver
       fetches for itself, and swapping the source out from under a cast
       that is merely slow to start would look like the app losing the
       film. */
    if (castState !== 'CONNECTED' &&
        advanceSource('That source would not play here')) return;

    setStatus('This link won\'t play here. It has to be the media file itself, not a webpage.', 'bad');
    toast({
      text: sources.count() > 1
        ? 'None of the streams from that page played here.'
        : 'Nothing played. Try scanning the page it came from.',
      actionLabel: 'Browse',
      onAction: function () { showTab('browse', { focus: true }); }
    });
  });

  /* The lock screen's own transport state. Cheap, and it has to be exact:
     a widget showing a play triangle over a film that is playing is a tap
     that stops what you wanted. */
  /* A film with no cover gets one from itself, once there are pixels to
     read. `loadeddata` is the first moment a frame exists; `seeked` covers
     the resume case, where the frame they actually came back to is a
     better picture than the opening.
   *
   * And then it keeps looking. `loadeddata` is the first frame of the
   * film, which is black in nearly everything ever shot, so one attempt
   * there is one attempt at the worst moment available. artwork refuses a
   * frame with nothing in it, so those early tries simply cost nothing and
   * the first real picture wins. Throttled, and it stops the moment there
   * is a cover — including a cover that came from the page, so a film with
   * its own artwork never runs this at all.
   *
   * `settled`, not `current`. There is now always a cover showing: a card
   * with the title on it goes up the moment the film loads. Asking whether
   * one exists would answer yes on the first tick and end the search before
   * a single frame had decoded, which would leave every cross-origin film
   * on its placeholder for good. */
  video.addEventListener('loadeddata', function () { artwork.tryFrame(); });
  video.addEventListener('seeked', function () { artwork.tryFrame(); });
  var lastLook = 0;
  video.addEventListener('timeupdate', function () {
    if (artwork.settled()) return;
    var now = Date.now();
    if (now - lastLook < 1000) return;
    lastLook = now;
    artwork.tryFrame();
  });

  /* A source that actually started is evidence the set is not the problem,
     so the budget for automatic hops is given back. Without this, a film
     paused for an hour and resumed onto a stale token would find the app
     had already spent its two hops on a different stream last night. */
  video.addEventListener('playing', function () { sources.resetAuto(); });

  video.addEventListener('play', function () { mediaSession.update({ state: 'playing' }); });
  video.addEventListener('pause', function () { mediaSession.update({ state: 'paused' }); });
  video.addEventListener('loadedmetadata', function () { mediaSession.position(); });
  video.addEventListener('durationchange', function () { mediaSession.position(); });
  video.addEventListener('seeked', function () { mediaSession.position(); });

  /* Position tracking — throttled, plus the moments a phone actually leaves. */
  video.addEventListener('timeupdate', function () {
    if (!current) return;
    var now = Date.now();
    if (now - lastSaved < 5000) return;
    lastSaved = now;
    store.progress(current, video.currentTime, video.duration);
    /* Same throttle. The OS interpolates between updates from the playback
       rate, so it does not need one per frame to draw a smooth scrubber. */
    mediaSession.position();
  });

  function flushProgress() {
    if (!current) return;
    store.progress(current, video.currentTime, video.duration);
  }
  video.addEventListener('pause', flushProgress);
  video.addEventListener('ended', function () {
    if (current) store.progress(current, 0, video.duration);
  });
  window.addEventListener('pagehide', function () {
    flushProgress();
    /* The last beat before the app disappears, and the one that matters
       most: it is the difference between coming back to where the film had
       actually got to and coming back to where it was up to fifteen seconds
       earlier. It goes out over sendBeacon, because a fetch started here
       does not survive the teardown. */
    sessionBeat({ force: true, leaving: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') return;
    flushProgress();
    sessionBeat({ force: true, leaving: true });
  });

  /* ------------------------------------------------------------------ *
   * Google Cast
   * ------------------------------------------------------------------ */

  /* Set once the sender library has told us this browser will never cast.
     Firefox is the whole of this case: Google ships the Cast sender SDK for
     Chrome and Edge only, so there is no Chromecast from Firefox at all —
     not a gap in this app, and not something a page can work around. */
  var castImpossible = false;

  window.__onGCastApiAvailable = function (ok) {
    if (ok) { initCast(); return; }

    /* What used to happen here: the status line said "casting needs Chrome"
       and updateCastUi() disabled the Cast button. On the idle screen that
       button is the ONLY one on show, so Firefox opened the app on a single
       dead control — which reads as the app being broken rather than as one
       feature being somewhere else. Give the button a job it can do. */
    setPill('Casting unavailable', '');

    /* Apple is checked FIRST, before the window.chrome fallback below.
       Chrome on iOS is WebKit with a Chrome badge: it defines window.chrome
       and it cannot cast, ever, because no browser on iOS has the Cast API.
       Reaching the "reload and check the Wi-Fi" line there would be advice
       for a fault that does not exist and a retry that cannot work. */
    if (isApple()) {
      castImpossible = true;
      setStatus('No browser on an iPhone or iPad can reach a Chromecast — ' +
                'Apple does not allow the Cast API on iOS, and that includes ' +
                'Chrome. AirPlay is the way to a television from here.', '');
      offerAirplayInstead();
      return;
    }

    /* Chrome and Edge both define window.chrome and both can cast, so a false
       here from one of them is the SDK having a bad start, not the wrong
       browser — and turning Chrome's own button into "Open in Chrome" would be
       nonsense. Only offer the handoff where there is somewhere to hand off
       TO. */
    if (window.chrome) {
      setStatus('Cast didn\'t start up. Reload the page, and check the TV is on ' +
                'the same Wi\u2011Fi.', '');
      return;
    }

    castImpossible = true;
    setStatus('Firefox can\'t reach a Chromecast — only Chrome carries Google\'s ' +
              'cast support. Everything else here works; Open in Chrome hands ' +
              'this over with the link already loaded.', '');
    offerChromeHandoff();
  };

  /* iPadOS 13+ reports itself as a Mac, so the touch test is what tells an
     iPad from a desktop Safari. Both are Apple and both AirPlay, which is
     all this is deciding. */
  function isApple() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    if (/Macintosh/i.test(ua)) return true;
    return /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  }

  /* The Cast button is the only control on the idle screen, so leaving it
     dead is the app reading as broken. On Apple it becomes a pointer to the
     button that does work, and AirPlay takes the filled treatment because it
     is now the primary action rather than the alternative one. */
  function offerAirplayInstead() {
    var cast = $('btnCast');
    var air = $('btnRemote');
    if (cast) {
      cast.disabled = true;
      var launcher = cast.querySelector('google-cast-launcher');
      if (launcher) launcher.hidden = true;
      cast.querySelector('span').textContent = 'Cast needs Chrome';
    }
    if (air && !air.hidden) {
      air.classList.remove('btn-primary');
      air.classList.add('btn-secondary');
    }
    setPill('AirPlay only', '');
  }

  /* The same app, in the browser that can finish the job — carrying whatever
     is loaded, so nothing has to be pasted twice. */
  function chromeHandoffUrl() {
    var base = location.origin + location.pathname;
    return current ? base + '?u=' + encodeURIComponent(current) : base;
  }

  function offerChromeHandoff() {
    var btn = $('btnCast');
    if (!btn) return;
    btn.disabled = false;
    btn.classList.add('is-handoff');
    var launcher = btn.querySelector('google-cast-launcher');
    if (launcher) launcher.hidden = true;
    if (!btn.querySelector('.cb-handoff-icon')) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'cb-handoff-icon');
      svg.setAttribute('width', '17'); svg.setAttribute('height', '17');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
                      '<path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>';
      btn.insertBefore(svg, btn.firstChild);
    }
    btn.querySelector('span').textContent = 'Open in Chrome';
  }

  /* Android lets one browser hand a URL to a named other one. Everywhere else
     there is no such handoff, so the honest move is to put the address on the
     clipboard and say where to paste it — never to claim a jump that will not
     happen. */
  function handOffToChrome() {
    var target = chromeHandoffUrl();

    function copyInstead(why) {
      var say = function () { toast({ text: why, ms: 7000 }); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(target).then(say, function () {
          toast({ text: 'Couldn\'t reach the clipboard. The address is in the box above.', ms: 7000 });
        });
      } else say();
    }

    if (!/Android/i.test(navigator.userAgent)) {
      copyInstead('Link copied. Open Chrome and paste it there — this page, ready to cast.');
      return;
    }

    /* If Chrome is not installed the intent does nothing at all: no error, no
       navigation. So arm the fallback first and cancel it only if we actually
       leave, rather than leaving a tap that silently did nothing. */
    var left = false;
    var onLeave = function () { left = true; };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onLeave);

    var noScheme = target.replace(/^https?:\/\//, '');
    try {
      location.href = 'intent://' + noScheme +
        '#Intent;scheme=' + location.protocol.replace(':', '') +
        ';package=com.android.chrome;end';
    } catch (e) { left = false; }

    setTimeout(function () {
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onLeave);
      if (left || document.visibilityState === 'hidden') return;
      copyInstead('Chrome didn\'t open — link copied instead. Paste it into Chrome.');
    }, 1400);
  }

  function initCast() {
    logCast('Cast sender library ready.');
    var ctx = window.cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    ctx.addEventListener(window.cast.framework.CastContextEventType.CAST_STATE_CHANGED, function (e) {
      castState = e.castState;
      logCast('Cast state: ' + castState);
      updateCastUi();
      /* CONNECTED fires for every route into a live session, including the
         ones that never produce a SESSION_RESUMED. Re-deciding the banner
         here is what stops "Pick it back up" surviving a rejoin. */
      renderResume();
    });
    ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function (e) {
      var SS = window.cast.framework.SessionState;
      logCast('Session: ' + e.sessionState);

      /* Read BEFORE anything below can adopt: adoption sets `current`, and
         the SESSION_STARTED branch below casts `current`. Without this the
         act of recognising a film already on the television would re-send
         it, jumping it back to the remembered position. */
      var hadTarget = !!current;

      if (e.sessionState === SS.SESSION_STARTED || e.sessionState === SS.SESSION_RESUMED) {
        logCast('Connected to ' + deviceName());
        /* A rejoin is the SDK handing back a cast that was already running
           when the app opened. It carries no title, so without the stored
           row the panel appears over a film it cannot name — which is
           precisely what "can't see it back after closing the app" looked
           like from the sofa.

           RESUMED is the documented flavour, but it is not the only one that
           arrives: a session this page did not ask for (`current` is empty,
           because nothing has been sent yet in this page's life) is a rejoin
           whatever the SDK calls it. Gating on RESUMED alone left the banner
           up over a live film. */
        var handedBack = e.sessionState === SS.SESSION_RESUMED || !askedForSession;
        askedForSession = false;
        if (restored && handedBack) adoptIfRejoined();
        showSending();
        renderResume();
      }
      if (e.sessionState === SS.SESSION_STARTED && hadTarget) {
        video.pause();
        stallRetried = false;
        /* A cast that began as "pick it back up" carries the position the
           film had reached before the app was closed. Without this the
           device picker silently restarts it from the beginning, which is
           the failure the whole resume exists to prevent. */
        var at = pendingResumeAt;
        pendingResumeAt = null;
        castLoad(current, at ? { at: at } : undefined);
        startBeating();
      }
      if (e.sessionState === SS.SESSION_START_FAILED) {
        askedForSession = false;
        disarmStallWatch();
        screenEl.classList.remove('is-onair');
        setStatus('That device refused the connection. Check it is on the same Wi\u2011Fi.', 'bad');
        openCastLog(true);
      }
      if (e.sessionState === SS.SESSION_ENDED) {
        askedForSession = false;
        disarmStallWatch();
        lastPlayerState = null;
        screenEl.classList.remove('is-onair');
        /* The session is over for real. The row has to go, or the next open
           offers to rejoin a television showing its home screen. */
        sessionClear();
      }
    });
    castState = ctx.getCastState();
    initRemote();
    updateCastUi();
  }

  function castSession() {
    if (!window.cast || !window.cast.framework) return null;
    return window.cast.framework.CastContext.getInstance().getCurrentSession();
  }

  function deviceName() {
    var s = castSession();
    try { return (s && s.getCastDevice().friendlyName) || 'the TV'; } catch (e) { return 'the TV'; }
  }

  /* ------------------------------------------------------------------
   * The session that survives the app being closed.
   *
   * The bug, in Rj's words: "can't really see stream history back even
   * when it's still streaming from the app just because close the app."
   *
   * That is what was happening, and it was not a history bug. A Cast
   * session lives in the SDK, which lives in the page; everything the app
   * knew ABOUT it — what is on, what it is called, where it had got to —
   * lived in `current` and `currentTitle`, two page-scoped variables.
   * Closing the app threw them away. The television carried on playing.
   * The SDK even rejoined the session on the next open, and `showSending()`
   * ran with nothing to say, so the on-air panel came back with an empty
   * subtitle over a film that was still on the wall.
   *
   * So the identity of what is playing is posted to /api/now-playing,
   * where closing a tab cannot reach it, and read back on open.
   *
   * What this deliberately does NOT do is claim to know the television.
   * The set is not ours to poll. All the row proves is when the app last
   * spoke — and an app that stopped speaking is not a film that stopped
   * playing, it is usually a phone in a pocket. The SDK's own rejoin is
   * the only thing here that is evidence about the TV; everything else is
   * offered as "this is where you were", never asserted as "this is on".
   * ------------------------------------------------------------------ */

  /* Every 15s. Four beats inside the 60s the server calls fresh, so one
     dropped beat in a lift does not end the session. */
  var BEAT_MS = 15000;
  var beatTimer = null;
  var lastBeatKey = '';
  var restored = null;        // the row read at boot, until it is used or cleared
  /* Set the instant this page calls requestSession(), cleared when the SDK
     answers. A SESSION_STARTED with this false is a session nobody on this
     screen asked for — which is what an auto-join looks like. Without it,
     tapping "Cast to TV" with nothing loaded would adopt the stored row and
     announce a film it had not sent. */
  var askedForSession = false;
  /* Where a resume should start once a device has been picked. Held
     across requestSession(), because the cast does not happen here — it
     happens in the SESSION_STARTED handler, several seconds and one
     device-picker later, and by then `restored` has been cleared. */
  var pendingResumeAt = null;

  function subsIdFromProxy() {
    if (!subsProxy) return null;
    try {
      return new URL(subsProxy, location.origin).searchParams.get('id');
    } catch (e) { return null; }
  }

  /* What the receiver says, not what the app hoped for. `sending` is its own
     state on purpose: a load that was accepted and never started is this
     app's most common failure, and a resume must be able to tell that apart
     from a film that is genuinely on screen. */
  function receiverState() {
    if (!remotePlayer || !remotePlayer.isMediaLoaded) return 'sending';
    var PS = window.cast && window.cast.framework && window.cast.framework.PlayerState;
    if (!PS) return 'playing';
    if (remotePlayer.playerState === PS.PLAYING) return 'playing';
    if (remotePlayer.playerState === PS.PAUSED) return 'paused';
    if (remotePlayer.playerState === PS.IDLE) return 'idle';
    return 'sending';
  }

  function sessionBeat(opts) {
    if (!signedIn || !current || !castSession()) return;
    opts = opts || {};

    var body = {
      url: current,
      title: currentTitle || nameOf(current),
      device: deviceName(),
      /* From the receiver, never from the local <video>. That element has
         been paused at zero the whole time the film has been on the
         television, and reading it here is how a resume restarts a film. */
      position: (remotePlayer && remotePlayer.isMediaLoaded && remotePlayer.currentTime) || 0,
      duration: (remotePlayer && remotePlayer.isMediaLoaded && remotePlayer.duration) || 0,
      state: receiverState(),
      subs_id: subsIdFromProxy(),
      subs_name: subsName || null
    };

    /* Deliberately keyed on the film and the state, NOT on the position.
       The receiver fires a change event roughly every second while playing,
       so including the position here would post a beat per second for the
       length of a film. State transitions go up immediately because they are
       what a resume reads; the position rides the 15s timer, which passes
       force and skips this check. */
    var key = body.url + '|' + body.state;
    if (!opts.force && key === lastBeatKey) return;
    lastBeatKey = key;

    var payload = JSON.stringify(body);

    /* On the way out there is no time for fetch to settle — the page is
       being torn down. sendBeacon is the only thing that survives it, and
       it is the difference between remembering where a film got to and
       remembering where it was fifteen seconds earlier. */
    if (opts.leaving && navigator.sendBeacon) {
      try {
        navigator.sendBeacon('/api/now-playing',
          new Blob([payload], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }

    fetch('/api/now-playing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: !!opts.leaving
    }).catch(function () { /* offline: the next beat carries it */ });
  }

  function startBeating() {
    stopBeating();
    sessionBeat({ force: true });
    beatTimer = setInterval(function () { sessionBeat({ force: true }); }, BEAT_MS);
  }

  function stopBeating() {
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    lastBeatKey = '';
  }

  /* The session ended for real — the row must go, or the next open offers to
     rejoin a television that is showing its home screen. */
  function sessionClear() {
    stopBeating();
    if (!signedIn) return;
    fetch('/api/now-playing', { method: 'DELETE' }).catch(function () {});
  }

  /* ---- reading it back ---- */

  function restoreSession() {
    if (!signedIn) return Promise.resolve(null);
    return fetch('/api/now-playing', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return null; }
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.ok || !body.session) { restored = null; renderResume(); return null; }
        restored = body.session;

        /* If the SDK already rejoined, the television is speaking and this
           row is only here to supply the label the SDK does not carry.
           Adopting it is the whole fix for the reported bug. */
        adoptIfRejoined();
        renderResume();
        return restored;
      })
      .catch(function () { return null; });
  }

  /* The SDK rejoins on its own (autoJoinPolicy is ORIGIN_SCOPED), and when it
     does the app has a live session it cannot name. Give it the name back. */
  function adoptIfRejoined() {
    var s = castSession();
    if (!s || !restored) return false;

    /* The receiver's own metadata outranks the stored row — it came from the
       television, the row came from a phone that has been asleep. */
    var fromTv = '';
    var tvUrl = '';
    try {
      var ms = s.getMediaSession();
      if (ms && ms.media) {
        tvUrl = ms.media.contentId || '';
        fromTv = (ms.media.metadata && ms.media.metadata.title) || '';
      }
    } catch (e) { /* the SDK is still settling */ }

    current = restored.url;
    currentTitle = fromTv || restored.title || nameOf(restored.url);
    if (restored.subs_id) {
      subsProxy = new URL('/api/subs?id=' + encodeURIComponent(restored.subs_id), location.origin).toString();
      subsName = restored.subs_name || 'Subtitles';
    }

    logCast('Rejoined a session already running',
      currentTitle + (restored.device ? ' on ' + restored.device : '') +
      (tvUrl && tvUrl !== restored.url ? ' · the TV is playing something else' : ''));

    restored = null;          // it is live now, not a resume point
    showSending();
    startBeating();
    updateCastUi();
    return true;
  }

  /* ---- the banner ----
   *
   * A BANNER, not a toast and not a modal: this is a condition that persists
   * rather than an event that passed, and it must not block the app. Manual
   * dismissal, quiet until cleared.
   *
   * The copy is the careful part. Two states, and they must not be written
   * the same way, because only one of them is a fact:
   *
   *   live  — the app was talking to the TV seconds ago. Say it plainly.
   *   maybe — the app stopped talking. The film is PROBABLY still on, and
   *           saying "still playing" would be a claim this app cannot
   *           support. So it says where you were, and offers to look.
   */
  function renderResume() {
    var el = $('resume');
    if (!el) return;

    /* The precedence is asked on EVERY render, not once at boot and once on
       one event. That is the whole fix for "shows this but cast still
       ongoing": the SDK's rejoin lands at a moment nobody can predict, so
       the banner has to look at the session each time it is drawn rather
       than trust that some earlier handler already did. */
    var v = window.CBResume.view(restored, castSession(), nameOf);
    if (v.adopt) adoptIfRejoined();

    if (!v.show || !restored) { el.hidden = true; return; }

    $('resumeTitle').textContent = v.head;
    $('resumeSub').textContent = v.sub;
    $('resumeGo').textContent = v.action;
    el.hidden = false;
  }

  function resumeSession() {
    if (!restored) return;
    var row = restored;

    /* Try the rejoin first: if the set is still on the session, this is a
       reconnect and not a re-cast, and the film does not restart. */
    if (adoptIfRejoined()) return;

    current = row.url;
    currentTitle = row.title || nameOf(row.url);
    if (row.subs_id) {
      subsProxy = new URL('/api/subs?id=' + encodeURIComponent(row.subs_id), location.origin).toString();
      subsName = row.subs_name || 'Subtitles';
    }
    restored = null;
    renderResume();

    var s = castSession();
    if (s) {
      stallRetried = false;
      castLoad(current, { at: row.resume_at });
      startBeating();
      return;
    }

    /* No session to rejoin. Ask for a device; the SESSION_STARTED handler
       casts what `current` now holds, from where it left off. */
    pendingResumeAt = row.resume_at;
    setStatus('Pick a TV to carry on from ' + clock(row.resume_at) + '.', '');
    try {
      askedForSession = true;
      window.cast.framework.CastContext.getInstance().requestSession().catch(function () { askedForSession = false; });
    } catch (e) {
      askedForSession = false;
      setStatus('Cast is not available in this browser.', 'bad');
    }
  }

  function dismissResume() {
    restored = null;
    renderResume();
    /* Dismissing is "I am done with this", so the row goes too — otherwise
       it comes straight back on the next open and the × means nothing. */
    sessionClear();
  }

  /* The on-air panel used to appear only once loadMedia had resolved, so
     the whole "the TV is thinking about it" window had no panel — and
     therefore no Stop, since the only one lived inside the remote, which
     itself stays hidden until the TV reports media loaded. A stalled cast
     was consequently impossible to cancel from this screen. It opens on
     connect now, and says which stage it is at. */
  function showSending() {
    var name = deviceName();
    /* Rejoining a session that is already playing is not "sending" — say
       what is actually on the screen in the other room. */
    if (remotePlayer && remotePlayer.isMediaLoaded) {
      $('onairTitle').textContent = 'Playing on ' + name;
      $('onairSub').textContent = currentTitle || (current ? nameOf(current) : '');
      screenEl.classList.add('is-onair');
      return;
    }
    $('onairTitle').textContent = 'Connected to ' + name;
    $('onairSub').textContent = current
      ? 'Sending ' + (currentTitle || nameOf(current)) + '\u2026'
      : 'Nothing sent yet — pick something to play.';
    screenEl.classList.add('is-onair');
  }

  /* ------------------------------------------------------------------ *
   * Stopping, and why the order of these two calls is the whole fix.
   *
   * Rj, 2026-09-08: *"stop button pauses the cast."*
   *
   * It used to call `remoteCtl.stop()` FIRST and `endSession(true)` second,
   * with both wrapped in catches that threw the answer away. `stop()` is a
   * MEDIA command: the receiver goes idle and the television sits on the
   * Default Media Receiver's backdrop, still connected. `endSession(true)` is
   * the SESSION command and it is the one that actually lets go — and it was
   * the one whose failure nobody could see, because its catch says "already
   * gone" about an exception that has not been read.
   *
   * So a refused or failed endSession left the television connected and
   * showing a stopped film, while this app said "Stopped casting." From the
   * sofa that is a Stop button that paused it. The app could not tell the
   * difference because it never asked.
   *
   * Now: end the SESSION first — which stops the receiver as a consequence,
   * that is what the `true` argument means — then verify by re-reading the
   * session, and only fall back to the media-level stop where there was no
   * session to end. And the sentence on screen follows what actually
   * happened rather than what was attempted.
   * ------------------------------------------------------------------ */
  function stopCasting(why) {
    disarmStallWatch();
    logCast('Stop casting' + (why ? ' (' + why + ')' : '') + '.');

    var s = castSession();
    var refusal = null;

    if (s) {
      try {
        s.endSession(true);
      } catch (e) {
        refusal = (e && e.message) || String(e);
      }
      /* The verification. `getCurrentSession()` answering null is the only
         evidence the television let go; everything above it is a request. */
      if (castSession()) {
        logCast('Session did not end on the first ask', refusal || 'no error reported');
        try {
          if (remoteCtl) remoteCtl.stop();
        } catch (e2) { /* nothing loaded to stop */ }
        try {
          var again = castSession();
          if (again) again.endSession(true);
        } catch (e3) {
          refusal = refusal || (e3 && e3.message) || String(e3);
        }
      }
    } else {
      /* No session, but the remote may still hold loaded media — that is the
         state a rejoin can leave behind. */
      try { if (remoteCtl) remoteCtl.stop(); } catch (e4) { /* nothing loaded */ }
    }

    var stillOn = !!castSession();
    lastPlayerState = null;
    notify.close('cast');

    if (stillOn) {
      /* SAY SO. An app reporting a stop it did not make is what turned one
         defect into a report about the wrong button. */
      logCast('Still connected after stopping', refusal || 'the receiver kept the session');
      setStatus(deviceName() + ' has not let go. Stop it from the TV, or from the ' +
                'Cast menu in Chrome.', 'bad');
      toast({ text: 'The TV kept the connection. Stop it from the TV itself.', ms: 8000 });
      openCastLog(true);
      return;
    }

    screenEl.classList.remove('is-onair');
    setStatus('Stopped casting.', '');
    toast({ text: 'Stopped. Tap Cast to TV to send it back.' });
  }

  $('castCancel').addEventListener('click', function () { stopCasting('you asked'); });

  /* The banner's two buttons. Guarded because index.html and app.js are
     deployed as separate files and a cached shell can be one build behind. */
  var resumeGo = $('resumeGo');
  if (resumeGo) resumeGo.addEventListener('click', resumeSession);
  var resumeX = $('resumeDismiss');
  if (resumeX) resumeX.addEventListener('click', dismissResume);

  /* A receiver that accepts a load and then never starts is the one failure
     that reports nothing at all: loadMedia has already resolved, so there is
     no error to catch, and the television just holds its spinner. Give it a
     fixed window to reach PLAYING, then say so — and, if it was fetching
     from the host directly, put the same media through the bridge once
     before giving up. Fifteen seconds is well past a normal start, even on
     a cold CDN. */
  var STALL_MS = 15000;
  var stallTimer = null;
  var stallRetried = false;

  function disarmStallWatch() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  }

  /* The receiver's own reason for going idle is the single most useful
     thing it reports, and it is not on the remote player. */
  function idleTail() {
    try {
      var s = castSession();
      var ms = s && s.getMediaSession();
      if (ms && ms.idleReason) return ' · idle reason: ' + ms.idleReason;
    } catch (e) { /* no media session yet */ }
    return '';
  }

  function armStallWatch(u, at, opts) {
    disarmStallWatch();
    stallTimer = setTimeout(function () {
      stallTimer = null;
      var PS = window.chrome.cast.media.PlayerState;
      if (remotePlayer && remotePlayer.playerState === PS.PLAYING) return;

      var name = deviceName();
      logCast('Still not playing after ' + Math.round(STALL_MS / 1000) + 's',
              'TV reports: ' + ((remotePlayer && remotePlayer.playerState) || 'no state at all') + idleTail());

      if (!opts.viaProxy && !stallRetried) {
        stallRetried = true;
        setStatus(name + ' hasn\'t started it — sending the same file through the bridge.', '');
        logCast('Retrying through the bridge.');
        castLoad(u, { at: at, viaProxy: true });
        return;
      }

      /* Already going through a bridge and still not playing. That is as
         likely to be the bridge as the film, so try the other one before
         calling it dead — the two are different machines in different
         places, and the log records which was in use. */
      if (opts.viaProxy && nextStreamHost()) {
        setStatus(name + ' still isn\'t starting — trying the backup bridge.', '');
        logCast('Switching bridge', 'now serving from ' + (STREAM_HOSTS[streamHostIndex] || location.origin));
        castLoad(u, { at: at, viaProxy: true });
        return;
      }

      setStatus(name + ' took the link but never started playing. The cast log below has what it reported.', 'bad');
      openCastLog(true);
      toast({
        text: name + ' isn\'t starting it.',
        actionLabel: 'Stop casting',
        onAction: function () { stopCasting('stalled'); },
        ms: 12000
      });
    }, STALL_MS);
  }

  function castLoad(u, opts) {
    var s = castSession();
    if (!s) return;
    opts = opts || {};
    var M = window.chrome.cast.media;

    var mime = mimeOf(u);
    /* HLS only. A DASH manifest's segment paths are relative to where the
       manifest itself was served, and serving it from /api/stream?u=... 
      resolves them against our query string rather than the CDN — so
       proxying one eagerly would break a stream that might have worked.
       DASH takes the direct-then-retry path below with everything else. */
    var adaptive = mime === 'application/x-mpegURL';

    /* An address already on this origin is one of ours, and ours are served
       cross-origin-open with whatever referer the media needs already
       forwarded. Sending it through /api/stream would be a second hop to the
       same box — and for the DASH manifest specifically it would be the one
       thing the note above warns about, since /api/stream relays an .mpd
       without rewriting it. The manifest's own segment URLs are absolute and
       already point back at /api/stream, so they are not affected. */
    var ours = String(u).indexOf(location.origin + '/api/') === 0;

    /* Cast's own media documentation requires HLS and DASH to be served
       cross-origin-open, and a CDN that never expected a television is not.
       So an adaptive stream goes through our origin from the start rather
       than failing once and being retried — a direct attempt here is a
       spinner on the TV, not a fast path. A progressive mp4 has no such
       requirement, so that one is tried direct and only proxied if the
       receiver comes back unhappy. */
    var src = (!ours && (adaptive || opts.viaProxy)) ? streamUrl(u, true) : u;

    var info = new M.MediaInfo(src, mime);
    info.streamType = M.StreamType.BUFFERED;
    if (mime === 'application/x-mpegURL') {
      info.hlsSegmentFormat = M.HlsSegmentFormat.TS;
      info.hlsVideoSegmentFormat = M.HlsVideoSegmentFormat.MPEG2_TS;
    }
    info.metadata = new M.GenericMediaMetadata();
    info.metadata.title = currentTitle || nameOf(u);
    /* The television draws this behind the film while it is paused and on
       the idle screen after it ends, and it fetches the picture itself —
       so only an address it can reach is any use. A frame captured from
       this phone is a data: URL and would be a broken image on the wall. */
    var remoteArt = artwork.remote();
    if (remoteArt) {
      try { info.metadata.images = [new chrome.cast.Image(remoteArt)]; } catch (e) { /* older sender */ }
    }

    /* A text track has to be declared when the media loads — there is no
       way to bolt one on afterwards, which is why turning subtitles on
       mid-film reloads and seeks back rather than doing nothing. */
    if (subsProxy) {
      var track = new M.Track(1, M.TrackType.TEXT);
      track.trackContentId = subsProxy;
      track.trackContentType = 'text/vtt';
      track.subtype = M.TextTrackType.SUBTITLES;
      track.name = subsName || 'Subtitles';
      track.language = navigator.language || 'en';
      info.tracks = [track];

      /* Television-sized, and legible over a bright frame. */
      var style = new M.TextTrackStyle();
      style.foregroundColor = '#FFFFFFFF';
      style.backgroundColor = '#000000A6';
      style.edgeType = M.TextTrackEdgeType.OUTLINE;
      style.edgeColor = '#000000FF';
      info.textTrackStyle = style;
    }

    var req = new M.LoadRequest(info);
    if (subsProxy) req.activeTrackIds = [1];

    /* Where to pick up. Once something is on the TV, the TV holds the
       position — the local element has been paused at the start all along,
       so reading it here would silently restart the film. */
    var at = opts.at;
    if (at === undefined) {
      at = (remotePlayer && remotePlayer.isMediaLoaded && remotePlayer.currentTime) ||
           video.currentTime || 0;
    }
    req.currentTime = at;

    var name = deviceName();
    logCast('Loading on ' + name,
            mime + ' · ' + (src === u ? 'direct from the host' : 'through the bridge') +
            (at ? ' · from ' + clock(at) : ''));
    logCast('Address handed to the TV', src);
    if (subsProxy) logCast('With a subtitle track', subsProxy);

    armStallWatch(u, at, opts);

    s.loadMedia(req).then(function () {
      /* Accepting a load is not playing it, and the two were being said in
         the same breath: the panel read "Playing on the TV" over a set that
         was still showing a spinner. The claim now waits for the receiver to
         report PLAYING, which is where it is upgraded. */
      logCast('The TV accepted it. Waiting for it to start playing\u2026');
      setStatus('Sent to ' + name + ' — waiting for it to start.', 'ready');
      reportCast('Sent to ' + name, 'Waiting for it to start\u2026');
      $('onairTitle').textContent = 'Sent to ' + name;
      $('onairSub').textContent = currentTitle || nameOf(u);
      screenEl.classList.add('is-onair');
    }, function (err) {
      disarmStallWatch();
      logCast('The TV refused it', describeCastError(err) + idleTail());
      /* A receiver that refuses a direct address is usually being refused
         itself — the host wants the page the media was embedded in. Give it
         one go through our origin before saying it cannot be played. */
      if (!opts.viaProxy && src === u) {
        setStatus('The host blocked ' + name + ' — routing it through the bridge.', '');
        logCast('Retrying through the bridge.');
        castLoad(u, { at: at, viaProxy: true });
        return;
      }

      /* Refused while already proxied. The bridge itself is a suspect. */
      if (opts.viaProxy && nextStreamHost()) {
        setStatus('That bridge didn\'t work — trying the backup.', '');
        logCast('Switching bridge', 'now serving from ' + (STREAM_HOSTS[streamHostIndex] || location.origin));
        castLoad(u, { at: at, viaProxy: true });
        return;
      }
      screenEl.classList.remove('is-onair');
      setStatus(name + ' couldn\'t play it (' + ((err && err.code) || 'error') + '). It needs a public https .mp4 or .m3u8 link.', 'bad');
      reportIssue('cast', name + " couldn't play it",
        (currentTitle || nameOf(u)) + ' — open Cast Bridge for the log.');
      openCastLog(true);
    });
  }

  function updateCastUi() {
    var btn = $('btnCast');
    /* Settled: this browser cannot cast, and the button is now the way out
       of that rather than a casualty of it. Leave it alone. */
    if (castImpossible) { offerChromeHandoff(); return; }
    if (!window.cast || !window.cast.framework) { btn.disabled = true; return; }

    /* One noun for one thing. This map used to say "cast device" in the
       status line, "devices" in the pill and "TV" on the button — three
       words for the single object the whole app is about, all visible at
       once on a 390px screen. The button's word wins because it is the one
       being tapped: it is a TV everywhere now. Sentence case throughout,
       which is also what a device name arrives in. */
    var map = {
      NO_DEVICES_AVAILABLE: ['No TV found on this Wi‑Fi.', '', true, 'No TV found', ''],
      NOT_CONNECTED: ['A TV is ready — tap Cast to TV.', 'ready', false, 'TV ready', 'ready'],
      CONNECTING: ['Connecting…', 'ready', true, 'Connecting…', 'ready'],
      CONNECTED: ['Connected to ' + deviceName() + '.', 'live', false, deviceName(), 'live']
    };
    var m = map[castState] || map.NO_DEVICES_AVAILABLE;

    /* Don't stomp a live "Playing on …" or a real error with a generic line. */
    if (!(castState === 'CONNECTED' && screenEl.classList.contains('is-onair'))) {
      setStatus(m[0], m[1]);
    }
    btn.disabled = m[2];
    setPill(m[3], m[4]);

    /* Connected is the app's one live state — let the accent carry it. */
    btn.classList.toggle('btn-secondary', castState === 'CONNECTED');
    btn.classList.toggle('btn-primary', castState !== 'CONNECTED');
    btn.querySelector('span').textContent = castState === 'CONNECTED' ? 'Send to ' + deviceName() : 'Cast to TV';

    if (castState !== 'CONNECTED') screenEl.classList.remove('is-onair');

    /* "No TV found" used to end the sentence with a disabled button. The
       explainer appears with it and leaves with it — folded shut, because
       most of the time the search succeeds a second later. */
    var help = $('castHelp');
    if (help) {
      var stuck = castState === 'NO_DEVICES_AVAILABLE';
      help.hidden = !stuck;
      if (!stuck) help.open = false;
    }
  }

  $('btnCast').addEventListener('click', function () {
    if (castImpossible) { handOffToChrome(); return; }
    if (!window.cast || !window.cast.framework) return;
    if (castState === 'CONNECTED') {
      stallRetried = false;
      if (current) castLoad(current, { viaProxy: forceProxy });
      else toast({ text: 'Connected — now pick something to play.' });
      return;
    }
    askedForSession = true;
    window.cast.framework.CastContext.getInstance().requestSession().catch(function () { askedForSession = false; });
  });

  /* ------------------------------------------------------------------ *
   * The remote
   *
   * Once a film is on the television the phone has one job, and the panel
   * used to only claim it: "Your phone is the remote now" over a dead
   * screen with no controls on it. RemotePlayerController is the thing
   * that makes the sentence true — position, transport, volume and stop,
   * all reported back by the TV rather than guessed at here.
   * ------------------------------------------------------------------ */

  var remoteEl = $('remote');

  function initRemote() {
    if (remoteCtl || !window.cast || !window.cast.framework) return;

    remotePlayer = new window.cast.framework.RemotePlayer();
    remoteCtl = new window.cast.framework.RemotePlayerController(remotePlayer);

    /* One listener rather than nine. The controller fires this for every
       property it owns, which is exactly the set the panel draws from. */
    remoteCtl.addEventListener(
      window.cast.framework.RemotePlayerEventType.ANY_CHANGE, function () {
        syncRemote();
        /* Unforced: this fires about once a second, and sessionBeat only
           posts when the film or the receiver's state has actually moved. */
        sessionBeat();
      });

    /* Seeking: the thumb owns the value while it is held. Redrawing from
       the TV's clock mid-drag drags the thumb back out from under it. */
    var seek = $('rSeek');
    var startScrub = function () { if (!seek.disabled) scrubbing = true; };
    seek.addEventListener('pointerdown', startScrub);
    seek.addEventListener('keydown', startScrub);
    seek.addEventListener('input', function () {
      $('rNow').textContent = clock(Number(seek.value));
      paintRange(seek);
    });
    var commitSeek = function () {
      if (!scrubbing) return;
      scrubbing = false;
      if (!remotePlayer || !remotePlayer.isMediaLoaded) return;
      remotePlayer.currentTime = Number(seek.value);
      remoteCtl.seek();
    };
    seek.addEventListener('change', commitSeek);
    seek.addEventListener('pointerup', commitSeek);
    seek.addEventListener('pointercancel', function () { scrubbing = false; syncRemote(); });

    $('rPlay').addEventListener('click', function () {
      if (!transportReady()) {
        logCast('Play/pause ignored',
                'TV reports: ' + ((remotePlayer && remotePlayer.playerState) || 'no state at all'));
        toast({ text: 'Nothing is playing on ' + deviceName() + ' to pause.' });
        return;
      }
      remoteCtl.playOrPause();
    });
    $('rBack').addEventListener('click', function () { nudge(-10); });
    $('rFwd').addEventListener('click', function () { nudge(10); });

    var vol = $('rVol');
    vol.addEventListener('input', function () {
      $('rVolNum').textContent = vol.value;
      paintRange(vol);
    });
    vol.addEventListener('change', function () {
      if (!remotePlayer) return;
      remotePlayer.volumeLevel = Number(vol.value) / 100;
      remoteCtl.setVolumeLevel();
    });
    $('rMute').addEventListener('click', function () {
      if (remotePlayer) remoteCtl.muteOrUnmute();
    });

    /* Stopping is one tap back from where it was, so it gets distance
       from the transport rather than a dialog in front of it. */
    $('rStop').addEventListener('click', function () { stopCasting('you asked'); });
  }

  /* ------------------------------------------------------------------ *
   * Can this receiver be paused RIGHT NOW?
   *
   * Rj, 2026-09-08: *"pause buttons stop everything."*
   *
   * Every transport control used to gate on `remotePlayer.isMediaLoaded`, and
   * that is not the question. `isMediaLoaded` stays TRUE after the receiver
   * has gone IDLE — a film that reached its end, a stall, a load the
   * television accepted and abandoned. `playOrPause()` toggles from whatever
   * state the player reports, so into an idle receiver it sends PLAY for
   * media that is finished, and the Default Media Receiver's answer to that
   * is to end the session. The button labelled Pause takes the cast down.
   *
   * So the gate is the STATE and not the flag: there has to be something
   * actually playing, paused or buffering for a pause to mean anything. An
   * idle receiver is told about rather than commanded — a control that
   * silently does nothing is the same dead button by another road.
   * ------------------------------------------------------------------ */
  function transportReady() {
    if (!remoteCtl || !remotePlayer || !remotePlayer.isMediaLoaded) return false;
    var PS = window.chrome && window.chrome.cast && window.chrome.cast.media.PlayerState;
    if (!PS) return false;
    var st = remotePlayer.playerState;
    return st === PS.PLAYING || st === PS.PAUSED || st === PS.BUFFERING;
  }

  function nudge(by) {
    if (!remotePlayer || !remotePlayer.isMediaLoaded) return;
    var dur = remotePlayer.duration || 0;
    var next = (remotePlayer.currentTime || 0) + by;
    remotePlayer.currentTime = Math.max(0, dur ? Math.min(next, dur - 1) : next);
    remoteCtl.seek();
  }

  /* WebKit gives a range no fill of its own, so the track is painted from
     a percentage the element carries. Firefox uses ::-moz-range-progress
     and ignores this — both end up filled. */
  function paintRange(el) {
    var max = Number(el.max) || 100;
    var pct = max ? (Number(el.value) / max) * 100 : 0;
    el.style.setProperty('--p', Math.max(0, Math.min(100, pct)) + '%');
  }

  function syncRemote() {
    if (!remotePlayer || !remoteEl) return;

    /* Every state the television moves through, once each. This is the part
       that was invisible: a receiver going BUFFERING → IDLE has failed, and
       used to say nothing whatsoever to the phone. */
    if (remotePlayer.playerState !== lastPlayerState) {
      lastPlayerState = remotePlayer.playerState;
      logCast('TV player state: ' + (lastPlayerState || 'idle') + idleTail());
      /* The lock screen is drawing a Play or a Pause for this same film.
         It follows the television now, so it has to be told when the
         television changes its mind. */
      mediaSession.update();
      var PSx = window.chrome.cast.media.PlayerState;
      if (lastPlayerState === PSx.PLAYING) {
        disarmStallWatch();
        var playingOn = deviceName();
        setStatus('Playing on ' + playingOn + '.', 'live');
        $('onairTitle').textContent = 'Playing on ' + playingOn;
        reportCast('Playing on ' + playingOn);
      } else if (lastPlayerState === PSx.PAUSED) {
        reportCast('Paused on ' + deviceName());
      } else if (lastPlayerState === PSx.BUFFERING) {
        reportCast('Buffering on ' + deviceName());
      }
    }

    var loaded = !!remotePlayer.isMediaLoaded && castState === 'CONNECTED';
    remoteEl.hidden = !loaded;
    if (!loaded) return;
    mediaSession.position();

    var seek = $('rSeek');
    var dur = Number(remotePlayer.duration) || 0;
    var now = Number(remotePlayer.currentTime) || 0;

    /* A live stream has no end to scrub towards. Saying so is better than
       a bar pinned at 100% that does nothing when it is dragged. */
    var seekable = dur > 0 && isFinite(dur);
    seek.disabled = !seekable;
    $('rBack').disabled = !seekable;
    $('rFwd').disabled = !seekable;

    if (seekable) {
      seek.max = String(Math.floor(dur));
      if (!scrubbing) {
        seek.value = String(Math.floor(now));
        $('rNow').textContent = clock(now);
        paintRange(seek);
      }
      $('rEnd').textContent = clock(dur);
    } else {
      seek.max = '100';
      seek.value = '0';
      paintRange(seek);
      $('rNow').textContent = clock(now);
      $('rEnd').textContent = '';
    }

    var state = remotePlayer.playerState;
    var PS = window.chrome.cast.media.PlayerState;
    var paused = state === PS.PAUSED;
    var label = state === PS.BUFFERING ? 'Buffering…' : (seekable ? '' : 'Live');
    var stateEl = $('rState');
    stateEl.textContent = label;
    stateEl.classList.toggle('is-live', label === 'Live');

    /* The button shows what it will do, so its icon and its label have to
       move together — a "Pause" button drawn as a play triangle is the
       single easiest way to make someone stop the film they wanted. */
    var btn = $('rPlay');
    btn.setAttribute('aria-label', paused ? 'Play on the TV' : 'Pause on the TV');
    $('rPlayIcon').innerHTML = paused
      ? '<path d="M8 5v14l11-7z"/>'
      : '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';

    var muted = !!remotePlayer.isMuted;
    var mute = $('rMute');
    mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    mute.setAttribute('aria-label', muted ? 'Unmute the TV' : 'Mute the TV');
    $('rMuteIcon').innerHTML = muted
      ? '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m17 9 4 6M21 9l-4 6"/>'
      : '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>';

    var vol = $('rVol');
    if (document.activeElement !== vol) {
      var level = Math.round((Number(remotePlayer.volumeLevel) || 0) * 100);
      vol.value = String(muted ? 0 : level);
      $('rVolNum').textContent = vol.value;
      paintRange(vol);
    }
  }

  /* ------------------------------------------------------------------ *
   * Media Session — the lock screen and the notification shade
   *
   * This is the other half of "controls while the app is in the background",
   * and it is a different mechanism from the notifications above rather than
   * a duplicate of them. The operating system draws this one itself, from
   * the audio the tab is producing: album art, a scrubber, and the same
   * transport keys as Spotify — on the lock screen, in the shade, on
   * headphone buttons, on a car stereo.
   *
   * Which means it has a hard boundary that has to be said plainly rather
   * than papered over: THE OS WIDGET ONLY EXISTS WHILE THIS TAB IS PLAYING
   * AUDIO. Once a film is on the television the local element is paused on
   * purpose — two soundtracks a few seconds apart in one room — so there is
   * no audio, and no amount of metadata will make Android draw the widget.
   * That case is exactly what the Pause/Stop buttons on the cast
   * notification above are for. Two surfaces, one for each situation, and
   * neither pretending to cover the other.
   *
   * The handlers are still routed through the cast check, because a session
   * can start while the widget is on screen and the keys should keep
   * working for the second or two before it goes away.
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Artwork — the cover, and what to do when there isn't one
   *
   * The rules live in assets/js/artwork.js so they can be proven without a
   * phone; what is decided here is only which pieces of this page it is
   * allowed to look at. See that file for why a poster is loaded before it
   * is trusted and why a captured frame is never offered to a television.
   * ------------------------------------------------------------------ */

  var artwork = window.CBArtwork.create({
    document: document,
    Image: window.Image,
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    video: video,
    cover: window.CBCover,
    /* Absolute on purpose. This address is handed to a Chromecast as well
       as to this page, and a receiver on the other side of the room has
       nothing to resolve a leading slash against. */
    proxy: function (u) {
      return location.origin + '/api/img?u=' + encodeURIComponent(u);
    },
    coverUrl: function (title, from) {
      return location.origin + '/api/cover?t=' + encodeURIComponent(title) +
             '&f=' + encodeURIComponent(from || '');
    }
  });

  var mediaSession = (function () {
    var ms = navigator.mediaSession;
    if (!ms || typeof window.MediaMetadata !== 'function') {
      return { update: function () {}, position: function () {}, clear: function () {} };
    }

    var casting = function () {
      return castState === 'CONNECTED' && remoteCtl && remotePlayer && remotePlayer.isMediaLoaded;
    };

    function handle(name, fn) {
      /* An unimplemented action is not an error — Chrome supports seekto,
         Safari did not for years, and setting an unknown one throws. */
      try { ms.setActionHandler(name, fn); } catch (e) { /* not on this browser */ }
    }

    handle('play', function () {
      if (casting()) { if (transportReady()) remoteCtl.playOrPause(); return; }
      video.play().catch(function () { /* policy */ });
    });
    handle('pause', function () {
      /* `casting()` says a session exists; `transportReady()` says there is
         something to pause. Sending a toggle into an idle receiver is what
         made this key end the cast. */
      if (casting()) { if (transportReady()) remoteCtl.playOrPause(); return; }
      video.pause();
    });
    handle('stop', function () {
      if (casting()) { stopCasting('from the lock screen'); return; }
      video.pause();
    });
    handle('seekbackward', function (d) {
      var by = (d && d.seekOffset) || 10;
      if (casting()) { nudge(-by); return; }
      try { video.currentTime = Math.max(0, video.currentTime - by); } catch (e) {}
    });
    handle('seekforward', function (d) {
      var by = (d && d.seekOffset) || 10;
      if (casting()) { nudge(by); return; }
      try { video.currentTime = video.currentTime + by; } catch (e) {}
    });
    handle('seekto', function (d) {
      if (!d || typeof d.seekTime !== 'number') return;
      if (casting()) {
        remotePlayer.currentTime = d.seekTime;
        remoteCtl.seek();
        return;
      }
      try { video.currentTime = d.seekTime; } catch (e) {}
    });

    /* Nulled deliberately. There is no playlist here, and an OS that is
       given no handler draws no button — whereas a handler that does
       nothing draws a Next that visibly ignores you. */
    handle('previoustrack', null);
    handle('nexttrack', null);

    function update(opts) {
      opts = opts || {};
      if (!current) { clear(); return; }
      var art = artwork.current();
      try {
        ms.metadata = new window.MediaMetadata({
          title: currentTitle || nameOf(current),
          /* Where it came from, in the line the OS labels "artist". A host
             name is the honest answer for a link and "this phone" is the
             honest answer for a file, and both are more use on a lock
             screen than a repeat of the filename. */
          artist: currentFrom || hostOf(current) || 'Cast Bridge',
          album: 'Cast Bridge',
          /* The film's own cover first, when there is one. `sizes` is
             deliberately omitted for it: the OS treats that list as a
             promise and a poster whose real dimensions are not 192x192
             gets picked for a slot it does not fit. The icons keep their
             sizes because those are measured. */
          artwork: (art ? [{ src: art }] : []).concat([
            { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' }
          ])
        });
      } catch (e) { /* an older MediaMetadata — the transport still works */ }
      /* Whose "paused" is being reported matters. While a film is on the
         television this element is deliberately paused — it is not a second
         speaker in the same room — so reading the state off it puts a Play
         button on the lock screen over a film that is playing on the wall.
         The television owns the state; the element only owns it when the
         television is not involved. */
      if (casting()) {
        var PS = window.chrome.cast.media.PlayerState;
        ms.playbackState = remotePlayer.playerState === PS.PAUSED ? 'paused' : 'playing';
      } else {
        ms.playbackState = opts.state || (video.paused ? 'paused' : 'playing');
      }
      position();
    }

    /* setPositionState throws on anything it considers impossible — a NaN
       duration before metadata lands, a live stream's Infinity, or a
       position past the end after a seek. All three are ordinary here, so
       they are filtered rather than caught after the fact. */
    function position() {
      if (typeof ms.setPositionState !== 'function') return;
      var live = casting();
      var dur = live ? Number(remotePlayer.duration) : Number(video.duration);
      var at = live ? Number(remotePlayer.currentTime) : Number(video.currentTime);
      if (!isFinite(dur) || dur <= 0 || !isFinite(at) || at < 0) {
        try { ms.setPositionState(); } catch (e) {}
        return;
      }
      try {
        ms.setPositionState({
          duration: dur,
          position: Math.min(at, dur),
          /* A television plays at 1x and knows nothing of this element's
             rate; using it here would draw a scrubber that runs at the
             wrong speed against the film on the wall. */
          playbackRate: live ? 1 : (video.playbackRate || 1)
        });
      } catch (e) { /* refused — the transport keys still work */ }
    }

    function clear() {
      ms.metadata = null;
      ms.playbackState = 'none';
      try { if (ms.setPositionState) ms.setPositionState(); } catch (e) {}
    }

    return { update: update, position: position, clear: clear };
  })();

  /* The cover usually arrives a moment after the film does — a probe over
     the network, or a frame that had not decoded yet. Everything already
     showing is told, rather than waiting for the next cast event.
     Registered HERE, below both modules it calls: the video listeners above
     are wired at boot, and `artwork` does not exist yet at that line. */
  artwork.onChange(function (art) {
    mediaSession.update();
    notify.update('cast', { art: art });
  });

  /* ------------------------------------------------------------------ *
   * Reporting — the same events, said out loud when nobody is watching
   *
   * Every function below is a thin translation of something the app was
   * already doing into one sentence for the notification shade. They are
   * gathered here rather than sprinkled through the player because the
   * decision "is this worth interrupting someone for" is a single decision
   * and it should be readable in one place.
   *
   * What gets a notification: a television that started, stopped, or
   * refused; an upload's progress and its ending; a scan that finished
   * while the phone was in a pocket. What does not: anything you can see,
   * anything you asked for a second ago, and every intermediate percent —
   * the tag makes those one notification that changes, not a queue.
   * ------------------------------------------------------------------ */

  /* Two buttons, no more: Android shows at most two and silently drops the
     rest, and a control you can see on one phone and not another is worse
     than a control that is never there. */
  function castActions() {
    if (!remotePlayer || !remotePlayer.isMediaLoaded) return [];
    var PS = window.chrome && window.chrome.cast && window.chrome.cast.media.PlayerState;
    var paused = PS && remotePlayer.playerState === PS.PAUSED;
    return [
      { action: 'toggle', title: paused ? 'Play' : 'Pause' },
      { action: 'stop', title: 'Stop' }
    ];
  }

  /* The offer to turn notifications on, made once, at the only moment it
   * means anything.
   *
   * Permission is never asked for on boot — a prompt at second one is how an
   * app earns a permanent "Blocked". But the opposite failure is the one that
   * actually happened: permission was never granted, so nothing was ever
   * shown, and the app said nothing about it either. Silence that looks
   * identical to a broken feature IS a broken feature. The first cast is the
   * moment the app has earned the question and the person has a reason to say
   * yes, so it is asked here, once, and never again whatever the answer.
   *
   * An iPhone in a Safari tab gets a different sentence, because there the
   * answer is not a permission at all — `Notification` does not exist outside
   * an installed copy, and "allow notifications" is advice that cannot be
   * followed. */
  var OFFER_KEY = 'cb.notify.offered';
  function offerNotifications() {
    var state;
    try { state = notify.state(); } catch (e) { return; }
    if (state !== 'ask' && state !== 'needs-install') return;
    try {
      if (localStorage.getItem(OFFER_KEY)) return;
      localStorage.setItem(OFFER_KEY, '1');
    } catch (e) { /* private mode: offer once per session rather than never */ }

    if (state === 'needs-install') {
      toast({
        text: 'Add Cast Bridge to your Home Screen and it can keep you posted ' +
              'while you are out of the app. Share → Add to Home Screen.',
        ms: 9000
      });
      return;
    }
    toast({
      text: 'Want the film in your notification shade, with Pause and Stop, ' +
            'while you are doing something else?',
      actionLabel: 'Yes',
      ms: 12000,
      onAction: function () { notify.ask(); }
    });
  }

  function reportCast(headline, detail, opts) {
    opts = opts || {};
    if (!opts.urgent) offerNotifications();
    notify.show('cast', {
      title: headline,
      body: detail || currentTitle || (current ? nameOf(current) : ''),
      art: artwork.current(),
      actions: opts.urgent ? [] : castActions(),
      ongoing: !opts.urgent,
      urgent: Boolean(opts.urgent)
    });
  }

  function reportUpload(pct, line) {
    notify.show('upload', {
      title: 'Sending to the stream host — ' + Math.round(pct) + '%',
      body: line || '',
      actions: [{ action: 'cancel', title: 'Cancel' }],
      ongoing: true
    });
  }

  /* A failure is the one thing allowed to make a sound. Everything else is
     silent by construction — see notify.options(). */
  function reportIssue(tag, headline, detail) {
    notify.show(tag, { title: headline, body: detail || '', urgent: true });
  }

  /* The buttons in the shade, performed here because the worker has no
     Cast session and no <video> — it only knows which button was tapped. */
  function castReady() {
    return castState === 'CONNECTED' && remoteCtl && remotePlayer && remotePlayer.isMediaLoaded;
  }

  /* Wait for the remote, or give up and say so — never a third thing. The
     rule, and why the version that fell back to this phone's own <video>
     was the whole of "the button does nothing", is in castaction.js. */
  var castWait = (window.CBCastAction || { create: function () { return null; } })
    .create({ setInterval: setInterval, clearInterval: clearInterval });

  function withCast(tap, act) {
    /* Guarded because index.html and the assets are deployed as separate
       files and a cached shell can be one build behind — the same guard the
       resume banner's buttons carry. Acting on the television without the
       wait is still better than a button that throws. */
    if (!castWait) { if (castReady()) act(); return; }

    castWait.wait(tap, castReady, act, function () {
      castActionFailed(tap, 'no-session',
        'That film is no longer on a television this phone can see.');
    });
  }

  /* Failure said in the shade, because the shade is where the person is.
     The whole premise of these buttons is that the app is in the background,
     so a failure that only raises a toast is a failure nobody is ever told
     about — the film keeps playing and the phone keeps its own counsel.
     The notification is rewritten in place, keeps its tag so it replaces
     rather than stacks, and drops its buttons: there is nothing left for
     them to act on. `urgent` is what lets it make a sound, which is the one
     case this app allows one. */
  function castActionFailed(tap, outcome, sentence) {
    notify.result(tap.id, outcome);
    notify.show('cast', {
      title: 'That did not reach the television',
      body: sentence,
      actions: [],
      ongoing: false,
      urgent: true
    });
    toast({ text: sentence });
  }

  notify.onAction(function (action, tag, how) {
    /* Carried through every branch rather than held in a shared variable:
       withCast()'s timer answers long after this handler has returned, and
       a second tap arriving in that gap would otherwise take the answer
       meant for the first. */
    var tap = { id: (how && how.id) || null, replayed: Boolean(how && how.replayed) };

    if (tag === 'upload' && action === 'cancel') {
      /* An upload does not survive the app being closed, so a cancel that
         arrives after a restart has nothing to cancel — and saying
         "stopped" about something that stopped on its own is a lie. */
      if (uploadXhr) uploadXhr.abort();
      notify.result(tap.id, uploadXhr ? 'performed' : 'nothing-to-do');
      notify.close('upload');
      return;
    }
    if (tag !== 'cast') return;

    if (action === 'stop') {
      withCast(tap, function () {
        try { stopCasting('from the notification'); }
        catch (e) {
          castActionFailed(tap, 'refused',
            'The television would not let go. Open the app and stop it there.');
          return;
        }
        notify.result(tap.id, 'performed');
        notify.close('cast');
      });
      return;
    }
    if (action !== 'toggle') return;

    withCast(tap, function () {
      /* The television owns the position, so the phone asks it — and a
         throw here used to be swallowed by the caller and told to nobody,
         which is the same dead button by another road. */
      if (!transportReady()) {
        /* Said in the shade, because that is where the person is — and NOT by
           toggling anyway, which is what ended the cast from a Pause button. */
        castActionFailed(tap, 'nothing-to-do',
          'Nothing is playing on ' + deviceName() + ' to pause.');
        return;
      }
      try { remoteCtl.playOrPause(); }
      catch (e) {
        castActionFailed(tap, 'refused',
          'The television would not take that. Open the app and try there.');
        return;
      }
      notify.result(tap.id, 'performed');
      /* Redraw with the button's new word rather than waiting for the TV's
         next ANY_CHANGE — a Pause that still says "Pause" afterwards reads
         as a tap that did nothing. */
      setTimeout(syncRemote, 0);
    });
  });

  /* ------------------------------------------------------------------ *
   * Subtitles
   *
   * The file goes through /api/subs and never straight to the TV: a
   * television fetches the track itself and takes only WebVTT served
   * cross-origin-open, while what people actually have is an SRT on a host
   * that sends no CORS header. The same converted copy feeds the phone's
   * own <track>, so both screens read from one file.
   * ------------------------------------------------------------------ */

  var subsBox = $('subsBox');
  var subsTrackEl = null;

  function subsProxyUrl(u) {
    return '/api/subs?u=' + encodeURIComponent(u);
  }

  function clearSubs(opts) {
    opts = opts || {};
    subsProxy = '';
    subsName = '';
    if (subsTrackEl) {
      try { video.removeChild(subsTrackEl); } catch (e) { /* already gone */ }
      subsTrackEl = null;
    }
    subsBox.classList.remove('is-on');
    $('subsSummary').textContent = 'Subtitles';
    $('subsOff').hidden = true;
    $('subsKeepNote').hidden = true;
    if (opts.resetField !== false) $('subsUrl').value = '';
    fieldError($('subsUrl'), $('subsError'), null);
  }

  function attachLocalTrack(proxy, label) {
    if (subsTrackEl) {
      try { video.removeChild(subsTrackEl); } catch (e) { /* already gone */ }
    }
    subsTrackEl = document.createElement('track');
    subsTrackEl.kind = 'subtitles';
    subsTrackEl.label = label || 'Subtitles';
    subsTrackEl.srclang = (navigator.language || 'en').slice(0, 2);
    subsTrackEl.src = proxy;
    subsTrackEl.default = true;
    video.appendChild(subsTrackEl);
    try { subsTrackEl.track.mode = 'showing'; } catch (e) { /* not ready yet */ }
    subsTrackEl.addEventListener('load', function () {
      try { subsTrackEl.track.mode = 'showing'; } catch (e) { /* gone */ }
    });
  }

  $('subsForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var raw = $('subsUrl').value.trim();
    if (!raw) {
      fieldError($('subsUrl'), $('subsError'), 'Paste the address of an .srt or .vtt file.');
      return;
    }
    if (!current) {
      fieldError($('subsUrl'), $('subsError'), 'Load a video first — subtitles attach to what is playing.');
      return;
    }
    fieldError($('subsUrl'), $('subsError'), null);

    var btn = $('btnSubs');
    busy(btn, true, 'Adding…');
    btn.disabled = true;

    var proxy = subsProxyUrl(raw);
    try {
      /* Fetched here first on purpose. The alternative is handing the TV an
         address and watching nothing appear, with no way to say why. */
      var res = await fetch(proxy, { headers: { accept: 'text/vtt' } });
      if (!res.ok) {
        var why = 'That subtitle file could not be read.';
        try { var j = await res.json(); if (j && j.error) why = j.error; } catch (e2) { /* not json */ }
        fieldError($('subsUrl'), $('subsError'), why);
        return;
      }
      var cues = res.headers.get('X-Subtitle-Cues') || '';

      subsProxy = new URL(proxy, location.origin).toString();
      subsName = nameOf(raw);
      attachLocalTrack(subsProxy, subsName);

      subsBox.classList.add('is-on');
      $('subsSummary').textContent = 'Subtitles on' + (cues ? ' · ' + cues + ' lines' : '');
      $('subsOff').hidden = false;

      /* On the TV a track can only arrive with the media, so this reloads
         and seeks straight back — announced, because the film visibly
         blinks and an unexplained blink reads as a fault. */
      if (castState === 'CONNECTED' && remotePlayer && remotePlayer.isMediaLoaded) {
        var at = remotePlayer.currentTime || 0;
        castLoad(current, { at: at });
        toast({ text: 'Subtitles on — picking the TV back up at ' + clock(at) + '.' });
      } else {
        toast({ text: 'Subtitles on' + (cues ? ' — ' + cues + ' lines.' : '.') });
      }
    } catch (err) {
      fieldError($('subsUrl'), $('subsError'), "That subtitle file couldn't be reached.");
    } finally {
      busy(btn, false);
      btn.disabled = false;
    }
  });

  /* An .srt off the phone.
   *
   * A television fetches its own text track over the network, so a file
   * sitting in a phone's Downloads folder is not reachable by it at any
   * price — which is why the address field alone left most subtitle files
   * unusable. The file goes up, comes back as an address, and from there it
   * is the same path a pasted link takes.
   */

  /* Subtitle files are the last place on the web where legacy encodings are
     still normal: a Malay, Spanish or Polish .srt is very often Windows-1252
     rather than UTF-8, and decoding one as UTF-8 replaces every accented
     character with a black diamond. Strict mode is what makes the difference
     detectable rather than silently wrong — it throws instead of
     substituting, and that throw is the signal to try the other one. */
  function decodeSubtitleBytes(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try {
        return new TextDecoder('windows-1252').decode(buf);
      } catch (e2) {
        return new TextDecoder().decode(buf);   // last resort: lossy, but readable
      }
    }
  }

  function readFileText(file) {
    if (file.arrayBuffer) {
      return file.arrayBuffer().then(decodeSubtitleBytes);
    }
    return new Promise(function (done, fail) {
      var fr = new FileReader();
      fr.onload = function () { done(decodeSubtitleBytes(fr.result)); };
      fr.onerror = function () { fail(new Error('That file could not be read.')); };
      fr.readAsArrayBuffer(file);
    });
  }

  $('btnSubsFile').addEventListener('click', function () { $('subsFile').click(); });

  $('subsFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    /* Cleared straight away so choosing the SAME file twice fires again —
       a change event compares values, and a re-pick of one file is not a
       change. Someone re-adding a subtitle after turning it off would
       otherwise tap and watch nothing happen. */
    this.value = '';
    if (!file) return;

    if (!current) {
      fieldError($('subsUrl'), $('subsError'),
        'Load a video first — subtitles attach to what is playing.');
      return;
    }

    var btn = $('btnSubsFile');
    busy(btn, true, 'Uploading…');
    btn.disabled = true;
    fieldError($('subsUrl'), $('subsError'), null);

    readFileText(file).then(function (text) {
      return fetch('/api/subs?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', accept: 'application/json' },
        body: text
      });
    }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      if (r.status === 401) { handleAuthLapse(); return; }
      if (r.status !== 201 || !r.body || r.body.ok !== true) {
        fieldError($('subsUrl'), $('subsError'),
          (r.body && r.body.error) || 'That subtitle file could not be used.');
        return;
      }

      subsProxy = new URL(r.body.url, location.origin).toString();
      subsName = r.body.name || file.name;
      attachLocalTrack(subsProxy, subsName);

      subsBox.classList.add('is-on');
      $('subsSummary').textContent = 'Subtitles on' +
        (r.body.cues ? ' · ' + r.body.cues + ' lines' : '');
      $('subsOff').hidden = false;

      /* Said, not assumed. The address has to be reachable without a
         sign-in because the thing fetching it is a television, so the id is
         the only thing protecting it — the same bargain the Library makes,
         and it is stated in the same plain words there. */
      var keep = $('subsKeepNote');
      keep.textContent = 'Kept for 30 days at a link of its own. Anyone with that ' +
        'exact link can read it — that is how the television gets it.';
      keep.hidden = false;

      if (castState === 'CONNECTED' && remotePlayer && remotePlayer.isMediaLoaded) {
        var at = remotePlayer.currentTime || 0;
        castLoad(current, { at: at });
        toast({ text: 'Subtitles on — picking the TV back up at ' + clock(at) + '.' });
      } else {
        toast({ text: 'Subtitles on' + (r.body.cues ? ' — ' + r.body.cues + ' lines.' : '.') });
      }
    }).catch(function () {
      fieldError($('subsUrl'), $('subsError'), 'That subtitle file could not be sent.');
    }).then(function () {
      busy(btn, false);
      btn.disabled = false;
    });
  });

  $('subsOff').addEventListener('click', function () {
    clearSubs();
    if (castState === 'CONNECTED' && remotePlayer && remotePlayer.isMediaLoaded && current) {
      var at = remotePlayer.currentTime || 0;
      castLoad(current, { at: at });
    }
    toast({ text: 'Subtitles off.' });
  });

  /* ------------------------------------------------------------------ *
   * AirPlay / Remote Playback
   * ------------------------------------------------------------------ */

  var btnRemote = $('btnRemote');
  if ('remote' in video && video.remote && video.remote.watchAvailability) {
    btnRemote.hidden = false;
    video.remote.watchAvailability(function (available) {
      btnRemote.disabled = !available;
    }).catch(function () { btnRemote.disabled = false; });
    btnRemote.addEventListener('click', function () {
      if (!current) { toast({ text: 'Load something first, then AirPlay it.' }); return; }
      video.remote.prompt().catch(function () {});
    });
  } else if (video.webkitShowPlaybackTargetPicker) {
    btnRemote.hidden = false;
    btnRemote.disabled = false;
    /* Safari's own answer to "is there anything to AirPlay to". Without it
       the button is always live and a tap on a network with no Apple TV
       opens an empty picker, which is the same dead end the Cast button had
       before it learned to say "No TV found". */
    video.addEventListener('webkitplaybacktargetavailabilitychanged', function (e) {
      var there = e.availability === 'available';
      btnRemote.disabled = !there;
      if (castImpossible) setPill(there ? 'AirPlay ready' : 'No AirPlay device', there ? 'ready' : '');
    });
    btnRemote.addEventListener('click', function () {
      if (!current) { toast({ text: 'Load something first, then AirPlay it.' }); return; }
      video.webkitShowPlaybackTargetPicker();
    });
  }

  /* The SDK's verdict can land either side of this block, so whichever runs
     second does the promotion. Idempotent by construction. */
  if (castImpossible && isApple()) offerAirplayInstead();

  /* ------------------------------------------------------------------ *
   * Hand-off — VLC and clipboard
   * ------------------------------------------------------------------ */

  /* A custom scheme nothing is registered for does exactly nothing: no
     error, no navigation, no way to tell it failed. That was the whole of
     "Open in VLC does nothing" — desktop VLC registers no vlc:// handler on
     Windows, macOS or Linux, so the old branch below was a tap into the
     void, and on a phone the intent is equally silent when VLC is not
     installed. So the tap now always lands somewhere: it either leaves this
     page, or it copies the address and says exactly where to paste it. */

  function copyForVlc(why) {
    var say = function () { toast({ text: why, ms: 9000 }); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(current).then(say, function () {
        try { $('url').select(); } catch (e) {}
        toast({
          text: 'Couldn\'t reach the clipboard — the link is in the box above, copy it from there.',
          ms: 9000
        });
      });
    } else {
      try { $('url').select(); } catch (e) {}
      say();
    }
  }

  /* Try a scheme, and find out whether anything answered. Leaving the page
     is the only signal a handler exists, so the fallback is armed first and
     cancelled only if we actually go. */
  function tryScheme(target, ifNothing) {
    var left = false;
    var onLeave = function () { left = true; };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onLeave);

    try { window.location.href = target; } catch (e) { /* unregistered scheme */ }

    setTimeout(function () {
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onLeave);
      if (left || document.visibilityState === 'hidden') return;
      ifNothing();
    }, 1400);
  }

  var VLC_DESKTOP = 'Link copied. In VLC: Media \u25b8 Open Network Stream (Ctrl+N), then paste it there.';
  var VLC_MISSING = 'VLC didn\'t open — link copied instead. Paste it into VLC \u25b8 Open Network Stream. If VLC isn\'t installed, that is why.';

  function handoffVlc() {
    if (!current) {
      toast({ text: 'Load something first, then hand it to VLC.' });
      return;
    }

    var ua = navigator.userAgent;
    var android = /android/i.test(ua);
    /* An iPad on iPadOS 13+ reports itself as a Mac and is the one desktop
       string that really does have a vlc-x-callback handler. */
    var ios = /iphone|ipad|ipod/i.test(ua) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (android) {
      var intent;
      try {
        var u = new URL(current);
        intent = 'intent://' + u.host + u.pathname + u.search +
          '#Intent;scheme=' + u.protocol.replace(':', '') +
          ';package=org.videolan.vlc;type=' + encodeURIComponent(mimeOf(current)) +
          ';S.title=' + encodeURIComponent(currentTitle || nameOf(current)) + ';end';
      } catch (e) {
        copyForVlc(VLC_DESKTOP);
        return;
      }
      tryScheme(intent, function () { copyForVlc(VLC_MISSING); });
      return;
    }

    if (ios) {
      tryScheme(
        'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(current),
        function () { copyForVlc(VLC_MISSING); }
      );
      return;
    }

    /* Desktop. There is no scheme to try, so don't pretend there is. */
    copyForVlc(VLC_DESKTOP);
  }
  $('btnVlc').addEventListener('click', handoffVlc);

  $('btnCopy').addEventListener('click', function () {
    if (!current) return;
    var label = this.querySelector('.cb-label');
    var done = function () {
      label.textContent = 'Copied';
      setTimeout(function () { label.textContent = 'Copy link'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(current).then(done, function () {
        toast({ text: 'Couldn\'t reach the clipboard. The link is in the box above.' });
      });
    } else {
      $('url').select();
      toast({ text: 'The link is selected above — copy it from there.' });
    }
  });

  /* ------------------------------------------------------------------ *
   * Paste-a-link form
   * ------------------------------------------------------------------ */

  /* Mirror of the server's walled list, for the paste box. Pasting a
     Netflix address here would otherwise fail as "that isn't a media
     link", which is true and useless — the real answer is that it never
     can be one. The server stays the authority; this is only so the
     answer arrives without a round trip. */
  var WALLED_CLIENT = [
    [/(^|\.)netflix\.com$/i, 'Netflix'], [/(^|\.)disneyplus\.com$/i, 'Disney+'],
    [/(^|\.)hotstar\.com$/i, 'Disney+ Hotstar'], [/(^|\.)primevideo\.com$/i, 'Prime Video'],
    [/(^|\.)hulu\.com$/i, 'Hulu'], [/(^|\.)(hbo)?max\.com$/i, 'Max'],
    [/(^|\.)paramountplus\.com$/i, 'Paramount+'], [/(^|\.)peacocktv\.com$/i, 'Peacock'],
    [/(^|\.)crunchyroll\.com$/i, 'Crunchyroll'], [/(^|\.)tv\.apple\.com$/i, 'Apple TV+'],
    [/(^|\.)open\.spotify\.com$/i, 'Spotify'], [/(^|\.)mubi\.com$/i, 'MUBI'],
    [/(^|\.)viu\.com$/i, 'Viu'], [/(^|\.)iq\.com$/i, 'iQIYI'],
    [/(^|\.)wetv\.vip$/i, 'WeTV'], [/(^|\.)sooka\.my$/i, 'sooka'],
    [/(^|\.)astrogo\.astro\.com\.my$/i, 'Astro GO']
  ];

  function walledName(u) {
    var h;
    try { h = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname; }
    catch (e) { return null; }
    for (var i = 0; i < WALLED_CLIENT.length; i++) {
      if (WALLED_CLIENT[i][0].test(h)) return WALLED_CLIENT[i][1];
    }
    if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(h)) return 'YouTube';
    return null;
  }

  var playInFlight = false;

  /* Is this an address the player can be handed as-is?
   *
   * Deliberately narrow: a media extension, or a share link whose direct
   * form is a fixed rewrite. Everything else goes to the scanner — which
   * includes the signed CDN links that carry no extension. That costs them
   * one round trip, and buys the guarantee that a name is never the reason
   * an address is refused: /api/extract identifies those by what the server
   * actually answers with and hands the file straight back as a single hit,
   * which then plays. Guessing "page" from a bare path would break exactly
   * the addresses that are hardest to come by. */
  function looksDirect(u) {
    return MEDIA_EXT.test(u) || resolveShare(u) !== u;
  }

  /* An address the player can't take is not a mistake to report. It is a
   * page, and the scanner reads pages — so read it. One hit plays on the
   * spot; anything else hands over to Browse, which already has the words
   * for a wall, an empty page, and a deep scan worth running. */
  function resolveThenPlay(rawUrl) {
    var u = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (scanInFlight) return;

    var btn = $('btnPlay');
    scanInFlight = true;
    playInFlight = true;
    busy(btn, true, 'Reading…');
    fieldError($('url'), $('urlError'), null);

    /* The Play button is the path almost everything takes, and until now it
       was the one path with nothing to look at: .is-busy hides the label, so
       a twenty-second read of a slow page was a blank button and no other
       sign of life. Browse had the stage/clock/bar panel all along. Same
       panel, same stages — this is a page being read either way. */
    $('linkHint').hidden = true;
    scanStop = startScanProgress($('linkResult'), 'quick');

    fetch('/api/extract?url=' + encodeURIComponent(u), { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (res) {
        if (res.status === 401) { handleAuthLapse(); return; }
        var body = res.body || {};

        /* Handing off means Browse has to look like it was the tab asked:
           its field carries the address, so a retry there retries the same
           thing rather than the last thing it scanned. */
        var handOff = function (render) {
          lastScanUrl = u;
          $('pageUrl').value = u;
          $('browseHint').hidden = true;
          showTab('browse');
          render();
        };

        if (body.walled) { handOff(function () { renderWalled(body); }); return; }

        if (res.status !== 200 || body.ok !== true) {
          if (body.canDeepScan) { handOff(function () { renderDeepOffer(body, u); }); return; }
          fieldError($('url'), $('urlError'),
            body.error || 'That address couldn\'t be read.');
          return;
        }

        var media = body.media || [];

        /* One result is not a choice, and rendering it as a list to be
           picked from is a tap that says nothing. */
        if (media.length === 1) {
          var only = media[0];
          load(only.url, {
            title: only.label || body.title || nameOf(only.url),
            label: only.label || '',
            from: body.direct ? '' : body.finalUrl,
            poster: body.poster || '',
            proxy: Boolean(only.viaProxy)
          });
          $('linkHint').hidden = true;
          if (!body.direct) toast({ text: 'That was a page — playing the video on it.' });
          return;
        }

        handOff(function () { renderScan(body); });
      })
      .catch(function () {
        fieldError($('url'), $('urlError'), 'No connection to the scanner.');
      })
      .then(function () {
        endScanProgress();
        $('linkResult').textContent = '';
        /* The explainer is the empty state, so it comes back only if the
           run ended with the player still empty. A hand-off to Browse or a
           film now playing has already said what happened. */
        if (!current) $('linkHint').hidden = false;
        busy(btn, false);
        scanInFlight = false;
        playInFlight = false;
      });
  }

  $('linkForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (playInFlight) return;

    var raw = String($('url').value || '').trim();

    var walled = walledName(raw);
    if (walled) {
      fieldError($('url'), $('urlError'),
        walled === 'YouTube'
          ? 'YouTube has its own cast button — open it in the YouTube app and cast from there. It reaches the TV directly.'
          : walled + ' encrypts its video with DRM, so there is no address on it a TV can play. Use the ' + walled + ' app on the TV instead.');
      return;
    }

    /* Only an address that is already an address gets sent anywhere. A typo
       still earns the same message it always did, from load(). */
    if (isHttp(raw) && !looksDirect(raw)) {
      resolveThenPlay(raw);
      return;
    }

    var btn = $('btnPlay');
    playInFlight = true;
    busy(btn, true, 'Loading…');

    var ok = load(raw);
    if (ok) $('linkHint').hidden = true;

    /* Loading is synchronous from here; release on the next frame so the
       spinner is visible for a beat rather than flickering. */
    setTimeout(function () { busy(btn, false); playInFlight = false; }, 350);
  });

  $('url').addEventListener('input', function () {
    fieldError($('url'), $('urlError'), null);
  });

  $('hintBrowse').addEventListener('click', function () { showTab('browse', { focus: true }); });

  /* ------------------------------------------------------------------ *
   * In-app browser
   *
   * The page is fetched server-side by /api/extract, which reads out every
   * media reference it can find. A preview iframe is attempted too, but most
   * sites refuse to be framed — when that happens the scan result is still
   * the useful half, and we say so rather than showing a blank box.
   * ------------------------------------------------------------------ */

  var scanInFlight = false;
  var lastScanUrl = '';
  var scanStop = null;

  /* ---------- Scan progress ----------
   *
   * A scan is between two and thirty seconds of nothing happening on
   * screen, and a single line reading "Reading the page…" for thirty of
   * them is indistinguishable from a hang. So show the clock: what it is
   * doing now, how long it has been doing it, and roughly how much is
   * left.
   *
   * The remaining figure is an estimate against a typical run and says so.
   * Once a run passes that estimate the app stops predicting rather than
   * counting down towards a zero it is going to sail straight past — the
   * bar goes indeterminate and the line says it is taking longer than
   * usual, which is true and useful. A countdown that reaches 0:00 and
   * keeps spinning is the same lie as no countdown at all.
   */
  var SCAN_STAGES = {
    quick: {
      total: 6,
      steps: [
        [0, 'Fetching the page'],
        [2, 'Following its player frames'],
        [4, 'Checking what those addresses serve']
      ]
    },
    deep: {
      total: 20,
      steps: [
        [0, 'Starting a browser'],
        [3, 'Opening the page'],
        [7, 'Starting its player'],
        [12, 'Watching what it loads'],
        [17, 'Reading the playlists it asked for']
      ]
    }
  };

  function startScanProgress(box, kind) {
    var plan = SCAN_STAGES[kind] || SCAN_STAGES.quick;
    box.textContent = '';

    var wrap = document.createElement('div');
    wrap.className = 'cb-scan';

    var head = document.createElement('div');
    head.className = 'cb-scan-head';
    var stage = document.createElement('span');
    stage.className = 'cb-scan-stage';
    /* Only the stage is announced. The clock changes four times a second
       and would talk over everything else. */
    stage.setAttribute('role', 'status');
    var clock = document.createElement('span');
    clock.className = 'cb-scan-clock';
    clock.setAttribute('aria-hidden', 'true');
    head.appendChild(stage);
    head.appendChild(clock);
    wrap.appendChild(head);

    var track = document.createElement('div');
    track.className = 'cb-scan-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Scan progress');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    var fill = document.createElement('div');
    fill.className = 'cb-scan-fill';
    track.appendChild(fill);
    wrap.appendChild(track);

    var note = document.createElement('p');
    note.className = 'cb-scan-note';
    note.textContent = kind === 'deep'
      ? 'The deep scan runs the page in a real browser, so it takes longer than the quick one.'
      : 'Reading the page as it came off the wire — no browser yet.';
    wrap.appendChild(note);

    box.appendChild(wrap);

    var started = Date.now();
    var overrun = false;

    var tick = function () {
      var elapsed = (Date.now() - started) / 1000;

      var current = plan.steps[0][1];
      for (var i = 0; i < plan.steps.length; i++) {
        if (elapsed >= plan.steps[i][0]) current = plan.steps[i][1];
      }
      if (stage.textContent !== current + '…') stage.textContent = current + '…';

      if (elapsed < plan.total) {
        /* Stops at 95%. The last 5% belongs to the answer arriving, and a
           bar that sits full while nothing has happened is worse than one
           that admits it is not finished. */
        var pct = Math.min(95, (elapsed / plan.total) * 95);
        fill.style.width = pct.toFixed(1) + '%';
        track.setAttribute('aria-valuenow', String(Math.round(pct)));
        track.setAttribute('aria-valuetext',
          fmtLength(elapsed) + ' elapsed, about ' +
          fmtLength(Math.max(1, plan.total - elapsed)) + ' left');
        clock.textContent = fmtLength(elapsed) + ' elapsed · about ' +
          fmtLength(Math.max(1, plan.total - elapsed)) + ' left';
      } else {
        if (!overrun) {
          overrun = true;
          track.classList.add('is-waiting');
          track.removeAttribute('aria-valuenow');
          fill.style.width = '100%';
        }
        track.setAttribute('aria-valuetext',
          fmtLength(elapsed) + ' elapsed, taking longer than usual');
        clock.textContent = fmtLength(elapsed) + ' elapsed · taking longer than usual';
      }
    };

    tick();

    /* Being rendered is not the same as being seen. The panel sits under the
       Scan field, and on a 390x664 phone that put its top edge at y=711 —
       47px past the fold, for the whole run. The button above it is the only
       thing on screen, and .is-busy blanks its label, so the app read as
       frozen while the panel counted away out of sight.
       This runs AFTER the first tick, not after appendChild: an empty panel
       is about 60px and a filled one 95px, and scrolling to fit the empty
       one left the filled one hanging 21px past the fold again — measured.
       `block: 'nearest'` then scrolls the least amount that brings it in,
       and is a no-op on a screen tall enough to have shown it anyway, so the
       desk case is untouched and only the phone case moves. */
    try {
      var reduced = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      wrap.scrollIntoView({
        block: 'nearest',
        behavior: reduced ? 'auto' : 'smooth'
      });
    } catch (e) {
      /* Older Safari takes only the object form's absence seriously. */
      try { wrap.scrollIntoView(false); } catch (e2) {}
    }

    var timer = setInterval(tick, 250);
    return function () { clearInterval(timer); };
  }

  function endScanProgress() {
    if (scanStop) { scanStop(); scanStop = null; }
  }

  function renderBrowseError(message, retry) {
    fieldError($('pageUrl'), $('pageError'), message, retry ? {
      label: 'Try again',
      run: function () { scan(lastScanUrl); }
    } : null);
  }

  /* ------------------------------------------------------------------ *
   * The gate
   *
   * One shared password, checked by /api/auth. This screen is the door;
   * every endpoint checks the cookie for itself, so hiding the UI is a
   * courtesy rather than the security boundary.
   * ------------------------------------------------------------------ */

  var signedIn = false;
  var me = null; // { id, username, role } once signed in

  function isOwner() { return Boolean(me && me.role === 'admin'); }

  /* Covering the app is not the same as taking it out of reach. Left as-is
     the shell keeps its tab stops and stays in the accessibility tree, so a
     keyboard or a screen reader walks straight past the gate into a UI whose
     every button is about to fail on a 401. */
  function sealShell(on) {
    /* The skip link lives outside the shell, so sealing only the shell
       leaves one tab stop pointing into the sealed region. */
    var parts = document.querySelectorAll('.cb-shell, .cb-skip');
    for (var i = 0; i < parts.length; i++) {
      if (on) {
        parts[i].setAttribute('inert', '');
        parts[i].setAttribute('aria-hidden', 'true');
      } else {
        parts[i].removeAttribute('inert');
        parts[i].removeAttribute('aria-hidden');
      }
    }
  }

  function gateError(message) {
    var box = $('gateError');
    var user = $('gateUser');
    var pw = $('gatePw');
    if (!box) return;

    if (!message) {
      box.textContent = '';
      box.classList.remove('is-shown');
      if (user) user.classList.remove('is-bad');
      if (pw) pw.classList.remove('is-bad');
      return;
    }
    box.textContent = message;
    box.classList.add('is-shown');
  }

  function showGate(message) {
    var gate = $('gate');
    if (!gate) return;
    gate.hidden = false;
    sealShell(true);
    var themeBack = $('themeColor');
    if (themeBack) themeBack.setAttribute('content', '#e6e7ee');
    document.body.classList.add('is-gated');
    if (message) gateError(message);

    /* Land on the first empty field, not always the first field — coming
       back from a lapsed session, the username is usually still filled. */
    var user = $('gateUser');
    var pw = $('gatePw');
    var target = (user && !user.value) ? user : (pw || user);
    if (target) { try { target.focus(); } catch (e) { /* not focusable yet */ } }
  }

  function hideGate() {
    var gate = $('gate');
    if (!gate) return;
    gate.hidden = true;
    sealShell(false);
    document.body.classList.remove('is-gated');
    /* Here rather than at boot: the shell is display:none until this line,
       and a button that is not laid out measures 0. Reserving against 0 is
       the same as not reserving at all. */
    reserveBusy($('btnPlay'), ['Reading…', 'Loading…']);
    reserveBusy($('btnScan'), ['Scanning…']);
    reserveBusy($('btnSubs'), ['Adding…']);
    var themeMeta = $('themeColor');
    if (themeMeta) themeMeta.setAttribute('content', '#e6e7ee');
    signedIn = true;
    var out = $('btnSignOut');
    if (out) out.hidden = false;
    reflectIdentity();
  }

  /* The header and the admin tab both depend on who signed in, and both are
     wrong until told. One place decides, so they can never disagree. */
  function reflectIdentity() {
    var who = $('whoami');
    if (who) {
      who.textContent = me ? me.username : '';
      who.hidden = !me;
    }
    /* Two rows inside More are the owner's. What the stream host is holding
       is everybody's files at once, and People is everybody's account — the
       endpoints behind both check the same thing, so this only stops them
       being offered, it is not the gate.

       Library is deliberately NOT here: it is one person's own uploads, and
       the stream host answers it about the uid in the ticket, so everyone
       gets their own and nobody gets anyone else's. */
    var ownerRows = [$('more-people'), $('more-host')];
    ownerRows.forEach(function (row) { if (row) row.hidden = !isOwner(); });
    /* Standing on an owner-only screen when the session drops to a
       non-owner would leave it open with no way back to it. */
    if (!isOwner() && (activeView === 'people' || activeView === 'host')) showView('more');

    var allToggle = $('histScopeRow');
    if (allToggle) allToggle.hidden = !isOwner();
  }

  /* A 401 from anywhere means the session lapsed while the tab sat open.
     Put the door back rather than letting the next tap fail silently. */
  function handleAuthLapse() {
    signedIn = false;
    me = null;
    /* The Library is one account's own files. Left in place, the next person
       to sign in on this phone would open it and see the last person's list
       for as long as it took the fetch to come back. */
    libraryFiles = [];
    libraryStale = true;
    libArmed = null;
    updateLibCount(0);
    reflectIdentity();
    var out = $('btnSignOut');
    if (out) out.hidden = true;
    var pw = $('gatePw');
    if (pw) pw.value = '';
    showGate('That session expired. Sign in again.');
  }

  function wireGate() {
    var form = $('gateForm');
    if (!form) return;

    var user = $('gateUser');
    var pw = $('gatePw');
    var btn = $('gateBtn');

    /* Validation ladder: quiet until blur, then live for that field only,
       so a correction is confirmed as it is typed rather than on the next
       submit. Both fields share one message box — there are only two of
       them, and two stacked errors on a phone push the button off-screen. */
    function markLive(field, label) {
      if (!field) return;
      var live = false;
      function judge() {
        if (!field.value.trim()) {
          field.classList.add('is-bad');
          field.classList.remove('is-good');
          gateError('Enter your ' + label + '.');
          return false;
        }
        field.classList.remove('is-bad');
        field.classList.add('is-good');
        gateError(null);
        return true;
      }
      field.addEventListener('blur', function () {
        /* Blurring an untouched field on the way past should not accuse
           anyone. Only judge a field the person actually left empty after
           entering it, or one already known to be wrong. */
        if (!field.value.trim() && !live) return;
        live = true;
        judge();
      });
      field.addEventListener('input', function () {
        if (live) judge();
      });
    }
    markLive(user, 'username');
    markLive(pw, 'password');

    var reveal = $('gateReveal');
    if (reveal && pw) {
      reveal.addEventListener('click', function () {
        var shown = pw.type === 'text';
        pw.type = shown ? 'password' : 'text';
        reveal.setAttribute('aria-pressed', shown ? 'false' : 'true');
        reveal.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
        /* Keep the caret where it was; toggling type sends it to the end. */
        try { pw.focus(); pw.setSelectionRange(pw.value.length, pw.value.length); }
        catch (e) { /* some browsers refuse setSelectionRange on password */ }
      });
    }

    var submitting = false;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (submitting) return; // double-submit: the second tap is never a second intent

      var username = user ? user.value.trim() : '';
      var password = pw ? pw.value : '';

      if (!username || !password) {
        var missing = !username ? user : pw;
        if (missing) missing.classList.add('is-bad');
        gateError(!username ? 'Enter your username.' : 'Enter your password.');
        if (missing) { try { missing.focus(); } catch (err) { /* ignore */ } }
        return;
      }

      gateError(null);
      submitting = true;
      if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }

      fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      })
        .then(function (r) {
          return r.json().then(function (body) { return { status: r.status, body: body }; });
        })
        .then(function (res) {
          if (res.body && res.body.ok) {
            if (pw) { pw.value = ''; pw.classList.remove('is-good', 'is-bad'); }
            if (user) user.classList.remove('is-good', 'is-bad');
            me = res.body.user || null;
            hideGate();
            toast({ text: 'Signed in as ' + (me ? me.username : 'you') + '.' });
            refreshHistory();
            restoreSession();
            return;
          }
          if (pw) pw.classList.add('is-bad');
          gateError((res.body && res.body.error) || 'That username and password do not match.');
        })
        .catch(function () {
          gateError('No connection to the sign-in service.');
        })
        .then(function () {
          submitting = false;
          if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
        });
    });

    var out = $('btnSignOut');
    if (out) {
      out.addEventListener('click', function () {
        fetch('/api/auth', { method: 'DELETE' })
          .catch(function () { /* the cookie is gone either way */ })
          .then(function () { handleAuthLapse(); });
      });
    }
  }

  function checkSession() {
    return fetch('/api/auth', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (body && body.signedIn) {
          me = body.user || null;
          hideGate();
          refreshHistory();
          /* The reason this app is worth reopening mid-film. Read before the
             Cast SDK has finished settling, deliberately: adoptIfRejoined()
             runs again from the SESSION_RESUMED handler if the SDK hands a
             live session back after this resolves, so whichever lands second
             still finds the other. */
          restoreSession();
          return;
        }
        me = null;
        if (body && body.configured === false) {
          showGate('This app has no accounts connected yet. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CAST_ADMIN_USER and CAST_ADMIN_PASSWORD in the project settings.');
          return;
        }
        showGate(null);
      })
      .catch(function () {
        /* Offline on an installed copy. Don't lock the person out of the
           history they already have — the API will refuse anything new. */
        showGate(null);
      });
  }

  function scan(rawUrl) {
    var u = String(rawUrl || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!isHttp(u)) {
      renderBrowseError('That doesn\'t look like a web address.', false);
      return;
    }
    if (scanInFlight) return;

    lastScanUrl = u;
    scanInFlight = true;
    var btn = $('btnScan');
    busy(btn, true, 'Scanning…');
    fieldError($('pageUrl'), $('pageError'), null);
    $('browseHint').hidden = true;
    scanStop = startScanProgress($('browseResult'), 'quick');

    fetch('/api/extract?url=' + encodeURIComponent(u), { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (res) {
        if (res.status === 401) { handleAuthLapse(); return; }
        if (res.body && res.body.walled) {
          renderWalled(res.body);
          return;
        }
        if (res.status !== 200 || !res.body || res.body.ok !== true) {
          /* The quick scan only reads the HTML that came off the wire. When
             it finds nothing, the deep scan still might — so offer it here
             instead of ending on a dead "couldn't read that". */
          if (res.body && res.body.canDeepScan) {
            renderDeepOffer(res.body, u);
            return;
          }
          var msg = (res.body && res.body.error) || 'That page couldn\'t be read.';
          $('browseResult').innerHTML = '';
          renderBrowseError(msg, true);
          return;
        }
        renderScan(res.body);
      })
      .catch(function () {
        $('browseResult').innerHTML = '';
        renderBrowseError('No connection to the scanner.', true);
      })
      .then(function () {
        endScanProgress();
        busy(btn, false);
        scanInFlight = false;
      });
  }

  /* The quick scan came back empty. Say plainly what it could and couldn't
     see, then put the thing that can still work in reach — one tap, not a
     retry of the same scan that already failed. */
  function renderDeepOffer(data, url) {
    fieldError($('pageUrl'), $('pageError'), null);
    var wrap = $('browseResult');
    wrap.innerHTML = '';

    var box = document.createElement('div');
    box.className = 'cb-empty cb-deepoffer';

    var h = document.createElement('h3');
    h.textContent = 'Nothing on the page itself';
    box.appendChild(h);

    var p = document.createElement('p');
    p.textContent = data.error || 'No video link is written into that page.';
    box.appendChild(p);

    var p2 = document.createElement('p');
    p2.className = 'cb-deepnote';
    p2.textContent = 'The deep scan opens the page in a real browser and watches ' +
      'what it loads. Slower — about ten seconds — but it sees players that build ' +
      'their link in JavaScript.';
    box.appendChild(p2);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-secondary btn-sm';
    go.id = 'btnDeep';
    go.textContent = 'Search harder';
    go.addEventListener('click', function () { deepScan(url); });
    box.appendChild(go);

    wrap.appendChild(box);
  }

  /* The deep scan. Same shape of answer as the quick one, so everything
     downstream — the list, the quality picker, the cast button — is
     unchanged. It just took a browser to get there. */
  function deepScan(rawUrl) {
    var u = String(rawUrl || lastScanUrl || '').trim();
    if (!u || scanInFlight) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

    scanInFlight = true;
    lastScanUrl = u;
    var btn = $('btnScan');
    busy(btn, true, 'Scanning…');
    scanStop = startScanProgress($('browseResult'), 'deep');

    fetch('/api/scan?url=' + encodeURIComponent(u), { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (res) {
        if (res.status === 401) { handleAuthLapse(); return; }
        if (res.body && res.body.walled) { renderWalled(res.body); return; }
        if (res.body && res.body.botWall) { renderBotWall(res.body); return; }
        if (res.status !== 200 || !res.body || res.body.ok !== true) {
          $('browseResult').innerHTML = '';
          renderBrowseError(
            (res.body && res.body.error) || 'The deep scan couldn\'t finish.', false);
          reportIssue('scan', 'Nothing found on that page',
            (res.body && res.body.error) || hostOf(u));
          return;
        }
        renderScan(res.body);
        var found = (res.body.media || []).length;
        notify.show('scan', {
          title: found === 1 ? 'Found 1 stream' : 'Found ' + found + ' streams',
          body: res.body.title || hostOf(u),
          urgent: true
        });
      })
      .catch(function () {
        $('browseResult').innerHTML = '';
        renderBrowseError('No connection to the scanner.', false);
        reportIssue('scan', 'The scan could not finish', 'No connection to the scanner.');
      })
      .then(function () {
        endScanProgress();
        busy(btn, false);
        scanInFlight = false;
      });
  }

  /* A walled service is not a typo and not a failed read — it is a wall,
   * and it has a shape. Saying it in the field-error slot under the input
   * would read as "you typed that wrong", which sends the person back to
   * retype a perfectly good address. It gets its own block, with the one
   * thing they can actually do instead. */
  function renderWalled(data) {
    fieldError($('pageUrl'), $('pageError'), null);
    var wrap = $('browseResult');
    wrap.innerHTML = '';

    var box = document.createElement('div');
    box.className = 'cb-empty cb-walled';

    var h = document.createElement('h3');
    h.textContent = data.why === 'app'
      ? (data.service || 'This service') + ' casts on its own'
      : (data.service || 'This service') + ' is encrypted';
    box.appendChild(h);

    var p = document.createElement('p');
    p.textContent = data.error || '';
    box.appendChild(p);

    if (data.walled === 'drm') {
      var note = document.createElement('p');
      note.className = 'cb-walled-note';
      note.textContent = 'Anything this app did return would be the trailer, not the film.';
      box.appendChild(note);
    }

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary btn-sm';
    go.textContent = 'Scan a different page';
    go.addEventListener('click', function () {
      $('pageUrl').value = '';
      $('pageUrl').focus();
      wrap.innerHTML = '';
      $('browseHint').hidden = false;
    });
    box.appendChild(go);

    wrap.appendChild(box);
  }

  /* A site that recognised the scanner and refused. This is a gated state,
   * not a failed read, so it gets the walled card rather than the red error
   * line under the input — a red line reads as "you typed that wrong" and
   * sends someone back to retype an address that was perfectly correct.
   *
   * The site's own words are quoted. Paraphrasing a refusal invites the
   * reasonable suspicion that we are covering for a bug of our own, and the
   * whole value of this state is that it is checkable: open the page in a
   * normal browser and you will see the same sentence.
   *
   * The way out is honest rather than encouraging. Re-running the scan will
   * fail identically, so there is no "try again" here — the recovery is a
   * different page, which is the only thing that actually works. */
  function renderBotWall(data) {
    fieldError($('pageUrl'), $('pageError'), null);
    var wrap = $('browseResult');
    wrap.innerHTML = '';

    var box = document.createElement('div');
    box.className = 'cb-empty cb-walled';

    var h = document.createElement('h3');
    h.textContent = 'That site blocks automated browsers';
    box.appendChild(h);

    var quote = document.createElement('p');
    quote.className = 'cb-walled-quote';
    quote.textContent = '\u201C' + data.botWall + '\u201D';
    box.appendChild(quote);

    var p = document.createElement('p');
    p.textContent = 'The page recognised the scanner and stopped before it ever ' +
      'asked for the video, so there was nothing on the wire to find. This is ' +
      'not a sign-in and not encryption \u2014 the check is on whether a person ' +
      'is holding the browser, and no scanner running on a server can pass it.';
    box.appendChild(p);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary btn-sm';
    go.textContent = 'Scan a different page';
    go.addEventListener('click', function () {
      $('pageUrl').value = '';
      $('pageUrl').focus();
      wrap.innerHTML = '';
      $('browseHint').hidden = false;
    });
    box.appendChild(go);

    wrap.appendChild(box);
  }

  function renderScan(data) {
    var wrap = $('browseResult');
    wrap.innerHTML = '';
    $('pageUrl').value = data.finalUrl || lastScanUrl;

    /* Page card */
    var card = document.createElement('div');
    card.className = 'card shadow-soft border-light cb-pagecard';
    var body = document.createElement('div');
    body.className = 'card-body';
    var h = document.createElement('p');
    h.className = 'cb-pagetitle';
    h.textContent = data.title || hostOf(data.finalUrl) || 'Untitled page';
    var sub = document.createElement('div');
    sub.className = 'cb-pagehost';
    sub.textContent = hostOf(data.finalUrl) + ' · ' +
      (data.media.length ? data.media.length + (data.media.length === 1 ? ' stream found' : ' streams found') : 'no media found');
    body.appendChild(h);
    body.appendChild(sub);
    card.appendChild(body);
    wrap.appendChild(card);

    /* Media list, or an honest dead-endless empty state */
    if (!data.media.length) {
      var empty = document.createElement('div');
      empty.className = 'cb-empty';
      empty.innerHTML =
        '<h3>No media on that page</h3>' +
        '<p>Either the video loads later from a script this scan can\'t run, or it\'s behind a login. ' +
        'If you can see a direct file address, paste it on the Link tab.</p>';
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-primary btn-sm';
      go.textContent = 'Go to Link';
      go.addEventListener('click', function () { showTab('link', { focus: true }); });
      empty.appendChild(go);
      wrap.appendChild(empty);
    } else {
      wrap.appendChild(mediaTable(data));
    }

    wrap.appendChild(previewBlock(data.finalUrl));
  }

  /* ---------- The stream table ----------
   *
   * A set of streams is a set of records with a name and two numbers, so
   * it is a table: identity left, numbers right-aligned on tabular
   * figures, one line per row, a hairline between rows and no stripes.
   *
   * Six columns do not fit a phone, so below 640px of the CONTAINER — not
   * the viewport, because this same table also has to survive inside a
   * narrow panel — each row stacks: identity and the size on line one,
   * type, quality and length on line two, each labelled. Nothing is
   * dropped and nothing scrolls sideways, so there is no row of numbers
   * with its name scrolled off.
   *
   * Every measured cell has three states and they are drawn differently
   * on purpose. Loading is a shimmer, missing is an em-dash with the
   * reason on hover, and a value is a value. A blank cell would be
   * indistinguishable from a bug, which is the whole reason the rule
   * exists.
   */

  function cell(row, cls, label) {
    var td = document.createElement('td');
    td.className = cls;
    if (label) td.setAttribute('data-label', label);
    row.appendChild(td);
    return td;
  }

  function setLoading(td) {
    td.classList.remove('is-missing');
    td.classList.add('is-loading');
    td.textContent = '';
    td.removeAttribute('title');
    var bar = document.createElement('span');
    bar.className = 'cb-skel';
    bar.setAttribute('aria-hidden', 'true');
    td.appendChild(bar);
    var sr = document.createElement('span');
    sr.className = 'cb-sr';
    sr.textContent = 'Reading…';
    td.appendChild(sr);
  }

  function setValue(td, text, note) {
    td.classList.remove('is-loading', 'is-missing');
    td.textContent = text;
    if (note) td.title = note; else td.removeAttribute('title');
  }

  /* Missing is not blank and not zero. It is an em-dash that says why. */
  function setMissing(td, why) {
    td.classList.remove('is-loading');
    td.classList.add('is-missing');
    td.textContent = '—';
    td.title = why || 'That host did not report it.';
  }

  function fmtLength(sec) {
    var s = Math.round(Number(sec) || 0);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }

  /* Decimal units, because "2.1 GB" is what a person means by two
     gigabytes and what their data plan bills them in. */
  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(n / 1e9 >= 10 ? 0 : 1) + ' GB';
    if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
    if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
    return n + ' B';
  }

  function fmtRate(bps) {
    var n = Number(bps) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' Mbps';
    if (n >= 1e3) return Math.round(n / 1e3) + ' kbps';
    return n + ' bps';
  }

  var HEADS = [
    ['Stream', 'cb-t-name'],
    ['Type', 'cb-t-type'],
    ['Quality', 'cb-t-q'],
    ['Length', 'cb-t-num'],
    ['Size', 'cb-t-num'],
    ['Action', 'cb-t-act']
  ];

  function mediaTable(page) {
    var box = document.createElement('div');
    box.className = 'cb-tablewrap';

    var table = document.createElement('table');
    table.className = 'cb-table';

    var caption = document.createElement('caption');
    caption.className = 'cb-sr';
    caption.textContent = 'Streams found on ' + hostOf(page.finalUrl);
    table.appendChild(caption);

    var thead = document.createElement('thead');
    var hrow = document.createElement('tr');
    HEADS.forEach(function (h, i) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.className = h[1];
      /* The action column's heading is for a screen reader only — a
         visible "Action" over a column of buttons is a label on a label. */
      if (i === HEADS.length - 1) {
        var sr = document.createElement('span');
        sr.className = 'cb-sr';
        sr.textContent = h[0];
        th.appendChild(sr);
      } else {
        th.textContent = h[0];
      }
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var jobs = page.media.map(function (m, i) {
      return mediaRow(tbody, m, page, i);
    });
    table.appendChild(tbody);
    box.appendChild(table);

    /* Three at a time. Forty rows firing at once would queue behind each
       other anyway and spend the browser's whole connection budget on
       measurements nobody has scrolled to yet. */
    runQueue(jobs, 3);
    return box;
  }

  function runQueue(jobs, width) {
    var next = 0;
    var step = function () {
      if (next >= jobs.length) return;
      var job = jobs[next++];
      Promise.resolve()
        .then(job)
        .catch(function () { /* a row that failed already says so */ })
        .then(step);
    };
    for (var i = 0; i < Math.min(width, jobs.length); i++) step();
  }

  function mediaRow(tbody, m, page, index) {
    var detailId = 'streamDetail' + index;

    var tr = document.createElement('tr');
    tr.className = 'cb-t-row';

    var name = cell(tr, 'cb-t-name');
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cb-t-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', detailId);
    var label = document.createElement('span');
    label.className = 'cb-t-label';
    label.textContent = m.label || nameOf(m.url);
    label.title = m.url;
    toggle.appendChild(label);
    var chev = document.createElement('span');
    chev.className = 'cb-t-chev';
    chev.setAttribute('aria-hidden', 'true');
    toggle.appendChild(chev);
    name.appendChild(toggle);

    var sub = document.createElement('span');
    sub.className = 'cb-t-sub';
    sub.textContent = m.detail || hostOf(m.url);
    name.appendChild(sub);

    var type = cell(tr, 'cb-t-type', 'Type');
    var badge = document.createElement('span');
    badge.className = 'badge badge-secondary';
    badge.textContent = m.kind || kindOf(m.url);
    type.appendChild(badge);

    var cells = {
      quality: cell(tr, 'cb-t-q', 'Quality'),
      length: cell(tr, 'cb-t-num', 'Length'),
      size: cell(tr, 'cb-t-num', 'Size')
    };
    setLoading(cells.quality);
    setLoading(cells.length);
    setLoading(cells.size);

    var act = cell(tr, 'cb-t-act');
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn-secondary btn-sm';
    play.textContent = 'Play';
    play.addEventListener('click', function () {
      load(m.url, {
        title: m.label || page.title || nameOf(m.url),
        label: m.label || '',
        from: page.finalUrl,
        poster: page.poster || '',
        proxy: Boolean(m.viaProxy),
        /* Picking one stream keeps the rest. They cost a scan to find and
           nothing to carry, and which of them plays is the one thing the
           scan could not tell anybody. */
        sources: page.media,
        sourceIndex: index
      });
      showTab('link');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    act.appendChild(play);
    tbody.appendChild(tr);

    /* The rest of what the probe learns — the address itself, the segment
       count, the bitrate — lives one tap away rather than nowhere. */
    var drow = document.createElement('tr');
    drow.className = 'cb-t-detailrow';
    drow.hidden = true;
    var dcell = document.createElement('td');
    dcell.colSpan = HEADS.length;
    dcell.id = detailId;
    dcell.className = 'cb-t-detail';
    drow.appendChild(dcell);
    tbody.appendChild(drow);
    renderStreamDetail(dcell, m, null);

    toggle.addEventListener('click', function () {
      var opening = drow.hidden;
      drow.hidden = !opening;
      toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
      tr.classList.toggle('is-open', opening);
    });

    return function () { return probeRow(m, page, cells, dcell); };
  }

  /* Resolves to whether the address actually reached the clipboard, so the
     button can say "press and hold" rather than a "Copied" that lied. */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return false; }
      );
    }
    return Promise.resolve(false);
  }

  function defRow(dl, term, value, note) {
    var dt = document.createElement('dt');
    dt.textContent = term;
    var dd = document.createElement('dd');
    dd.textContent = value;
    if (note) dd.title = note;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderStreamDetail(box, m, info) {
    box.textContent = '';
    var dl = document.createElement('dl');
    dl.className = 'cb-t-defs';

    defRow(dl, 'Address', m.url, m.url);
    defRow(dl, 'Found', m.detail || 'on the page');

    if (info && info.ok) {
      if (info.variants) defRow(dl, 'Qualities', String(info.variants));
      if (info.segments) defRow(dl, 'Segments', String(info.segments));
      if (info.bandwidth) defRow(dl, 'Bitrate', fmtRate(info.bandwidth));
      if (info.bytesBasis === 'sampled') {
        defRow(dl, 'Size read', 'Estimated from three sampled segments');
      } else if (info.bytesBasis === 'bitrate') {
        defRow(dl, 'Size read', 'Estimated from the declared bitrate');
      } else if (info.bytesBasis === 'measured') {
        defRow(dl, 'Size read', 'Measured from the file itself');
      }
    } else if (info && info.error) {
      defRow(dl, 'Details', info.error);
    } else if (info === null) {
      defRow(dl, 'Details', 'Reading…');
    }

    box.appendChild(dl);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-secondary btn-sm';
    copy.textContent = 'Copy address';
    copy.addEventListener('click', function () {
      copyText(m.url).then(function (ok) {
        copy.textContent = ok ? 'Copied' : 'Press and hold to copy';
        setTimeout(function () { copy.textContent = 'Copy address'; }, 1500);
      });
    });
    box.appendChild(copy);
  }

  function probeFailed(cells, why) {
    setMissing(cells.quality, why);
    setMissing(cells.length, why);
    setMissing(cells.size, why);
  }

  function probeRow(m, page, cells, dcell) {
    var q = '/api/probe?url=' + encodeURIComponent(m.url);
    if (page.finalUrl) q += '&from=' + encodeURIComponent(page.finalUrl);

    return fetch(q, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (!info || info.ok !== true) {
          var why = (info && info.error) ||
            'That host would not answer a request for its details.';
          probeFailed(cells, why);
          renderStreamDetail(dcell, m, info || { error: why });
          return;
        }

        if (info.height) {
          setValue(cells.quality, info.height + 'p',
            info.width ? info.width + ' × ' + info.height : null);
        } else {
          setMissing(cells.quality, 'That stream declares no resolution.');
        }

        if (info.live) {
          setValue(cells.length, 'Live', 'A live stream has no fixed length.');
          setMissing(cells.size, 'A live stream has no fixed size.');
          renderStreamDetail(dcell, m, info);
          return;
        }

        if (info.duration) setValue(cells.length, fmtLength(info.duration));
        else setMissing(cells.length, 'That stream does not state its length.');

        if (info.bytes) {
          var exact = info.bytesBasis === 'measured';
          setValue(cells.size, (exact ? '' : '≈ ') + fmtSize(info.bytes),
            exact ? 'Measured from the file.'
              : info.bytesBasis === 'sampled'
                ? 'Estimated from three sampled segments — expect a few percent either way.'
                : 'Estimated from the declared bitrate — a ceiling, so likely high.');
        } else {
          setMissing(cells.size, 'That host does not report a size for it.');
        }

        renderStreamDetail(dcell, m, info);
      })
      .catch(function () {
        probeFailed(cells, 'The details could not be read from here.');
        renderStreamDetail(dcell, m,
          { error: 'The details could not be read from here.' });
      });
  }

  function previewBlock(url) {
    var wrap = document.createElement('div');
    wrap.className = 'cb-frame-wrap';

    var note = document.createElement('div');
    note.className = 'cb-frame-note';
    note.innerHTML = '<b>Loading a preview…</b>';
    wrap.appendChild(note);

    var frame = document.createElement('iframe');
    frame.className = 'cb-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('title', 'Page preview');
    frame.hidden = true;
    frame.src = url;
    wrap.appendChild(frame);

    var settled = false;
    frame.addEventListener('load', function () {
      if (settled) return;
      settled = true;
      frame.hidden = false;
      note.remove();
    });

    /* Most sites send X-Frame-Options or frame-ancestors and simply never
       fire load. Say that plainly instead of leaving a white rectangle. */
    setTimeout(function () {
      if (settled) return;
      settled = true;
      frame.remove();
      note.innerHTML =
        '<b>This site won\'t open inside another app.</b><br>' +
        'That\'s the site\'s choice, not a fault here — the scan above still read it.';
      var openWrap = document.createElement('div');
      var open = document.createElement('a');
      open.className = 'btn btn-primary btn-sm mt-3';
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Open in a new tab';
      openWrap.appendChild(open);   // its own line — inline it collides with the note
      note.appendChild(openWrap);
    }, 4000);

    return wrap;
  }

  $('browseForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (browseMode === 'episodes') crawl($('pageUrl').value);
    else scan($('pageUrl').value);
  });
  $('pageUrl').addEventListener('input', function () {
    fieldError($('pageUrl'), $('pageError'), null);
  });

  /* ------------------------------------------------------------------ *
   * Episodes — the crawl, and the series you have opened before
   *
   * Rj's words: "if I put a season page in, it should find the child pages,
   * then if I select episode 2, finds links for it, so I don't need to keep
   * finding and pasting links. And store parent page history so I can view
   * again tomorrow."
   *
   * Three parts, and the middle one is the one worth naming:
   *
   *   1. The crawl asks /api/crawl for the CHILD PAGES of an address.
   *   2. Choosing one hands it to the ordinary Play path. Nothing about
   *      resolving a video changed — an episode picked from a list and an
   *      address pasted by hand arrive at the same function, which is why
   *      "two options, parent page or direct url" needed no second scanner.
   *   3. What the crawl found is remembered, per person, keyed on the
   *      season's address. Opening it tomorrow paints from that memory in
   *      one frame and re-crawls behind the list — so a season is instant
   *      to look at and still correct a few seconds later.
   * ------------------------------------------------------------------ */

  var browseMode = 'page';       // 'page' = find the video · 'episodes' = find the children
  var crawlInFlight = false;
  var lastCrawl = null;          // the answer on screen, for the filter to redraw from
  var seriesItems = [];
  var seriesLoaded = false;

  function setBrowseMode(name) {
    browseMode = name === 'episodes' ? 'episodes' : 'page';
    var page = $('modePage');
    var eps = $('modeEpisodes');
    page.classList.toggle('is-on', browseMode === 'page');
    eps.classList.toggle('is-on', browseMode === 'episodes');
    page.setAttribute('aria-pressed', browseMode === 'page' ? 'true' : 'false');
    eps.setAttribute('aria-pressed', browseMode === 'episodes' ? 'true' : 'false');
    /* The button says what it will do. "Scan" for a page it will read, and
       the other word for the other job — a single label across two modes is
       how someone taps expecting streams and gets a list of links. */
    reserveBusy($('btnScan'), ['Scan', 'Episodes', 'Scanning…', 'Reading…']);
    $('btnScan').querySelector('.cb-label').textContent =
      browseMode === 'episodes' ? 'Episodes' : 'Scan';
  }

  $('modePage').addEventListener('click', function () { setBrowseMode('page'); });
  $('modeEpisodes').addEventListener('click', function () { setBrowseMode('episodes'); });

  /* An episode is just an address, so it goes where every address goes. The
     Link screen is where a video is played from, and sending someone there
     with the box already filled is the difference between "it found it" and
     "now paste this somewhere". */
  function openEpisode(url, title) {
    $('url').value = url;
    $('linkHint').hidden = true;
    showTab('link');
    resolveThenPlay(url);
    if (title) toast({ text: 'Opening ' + title });
  }

  /* "Episode 4" / "S2 · Episode 4" / the label the page gave it. Built here
     rather than in the crawler because it is a sentence for a screen, and
     the crawler's job ends at facts. */
  function episodeWords(ep) {
    var bits = [];
    if (ep.season !== null && ep.season !== undefined) bits.push('S' + ep.season);
    if (ep.num !== null && ep.num !== undefined) bits.push('Episode ' + ep.num);
    return bits.join(' · ');
  }

  function episodeRow(ep) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'cb-eprow';

    var num = document.createElement('span');
    num.className = 'cb-epnum';
    /* Tabular figures, so a column of 1 · 9 · 10 · 100 lines up rather than
       drifting right as the numbers grow. Set in the stylesheet. */
    num.textContent = (ep.num === null || ep.num === undefined) ? '·' : String(ep.num);
    row.appendChild(num);

    var body = document.createElement('span');
    body.className = 'cb-epbody';

    var name = document.createElement('span');
    name.className = 'cb-epname';
    /* The label first, because "Bigg Boss Season 20 Grand Premiere" tells
       you more than "Episode 1" does. The number is already in the gutter. */
    name.textContent = ep.title || episodeWords(ep) || nameOf(ep.url);
    body.appendChild(name);

    var sub = document.createElement('span');
    sub.className = 'cb-epsub';
    var words = episodeWords(ep);
    sub.textContent = ep.title && words ? words : hostOf(ep.url);
    body.appendChild(sub);

    row.appendChild(body);
    row.addEventListener('click', function () { openEpisode(ep.url, ep.title); });
    return row;
  }

  function seasonRow(season) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'cb-eprow is-season';

    var body = document.createElement('span');
    body.className = 'cb-epbody';
    var name = document.createElement('span');
    name.className = 'cb-epname';
    name.textContent = season.title ||
      (season.season !== null ? 'Season ' + season.season : nameOf(season.url));
    body.appendChild(name);
    var sub = document.createElement('span');
    sub.className = 'cb-epsub';
    sub.textContent = 'Open this season';
    body.appendChild(sub);
    row.appendChild(body);

    row.addEventListener('click', function () {
      $('pageUrl').value = season.url;
      crawl(season.url);
    });
    return row;
  }

  /* Where the list came from, said plainly, because it changes how much it
     should be trusted. The alternative — presenting a guess from a repeating
     URL pattern in the same voice as a list read off the page — is the kind
     of quiet confidence that makes someone stop believing the whole screen. */
  function crawlProvenance(data) {
    if (data.via === 'shape') {
      return 'Worked out from the pattern of the addresses — check one before trusting the rest.';
    }
    if (data.via === 'followed' && data.followed && data.followed.length) {
      return 'Read from ' + (data.followed.length === 1
        ? 'the season page this one links to.'
        : data.followed.length + ' season pages this one links to.');
    }
    return '';
  }

  function renderCrawl(data, opts) {
    opts = opts || {};
    lastCrawl = data;
    var wrap = $('browseResult');
    wrap.innerHTML = '';
    fieldError($('pageUrl'), $('pageError'), null);
    $('browseHint').hidden = true;

    var episodes = data.episodes || [];
    var seasons = data.seasons || [];

    var card = document.createElement('div');
    card.className = 'card shadow-soft border-light cb-pagecard';
    var cardBody = document.createElement('div');
    cardBody.className = 'card-body';

    var h = document.createElement('p');
    h.className = 'cb-pagetitle';
    h.textContent = data.title || data.host || 'Untitled page';
    cardBody.appendChild(h);

    var sub = document.createElement('div');
    sub.className = 'cb-pagehost';
    var count = episodes.length
      ? episodes.length + (episodes.length === 1 ? ' episode' : ' episodes')
      : (seasons.length
          ? seasons.length + (seasons.length === 1 ? ' season' : ' seasons')
          : 'nothing to open');
    sub.textContent = (data.host || hostOf(data.finalUrl || data.url)) + ' · ' + count +
      (opts.cached ? ' · from the last time you looked' : '');
    cardBody.appendChild(sub);

    var why = crawlProvenance(data);
    if (why && !opts.cached) {
      var note = document.createElement('div');
      note.className = 'cb-epnote';
      note.textContent = why;
      cardBody.appendChild(note);
    }

    card.appendChild(cardBody);
    wrap.appendChild(card);

    if (!episodes.length && !seasons.length) {
      var empty = document.createElement('div');
      empty.className = 'cb-empty';
      empty.innerHTML =
        '<h3>No episode list on that page</h3>' +
        '<p>Either the page builds its list after loading, or this is already a ' +
        'single episode. Switch to <b>The video</b> and scan it — that runs the ' +
        'page properly and looks for the stream itself.</p>';
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-secondary btn-sm';
      go.textContent = 'Scan it for the video';
      go.addEventListener('click', function () {
        setBrowseMode('page');
        scan(data.finalUrl || data.url);
      });
      empty.appendChild(go);
      wrap.appendChild(empty);
      return;
    }

    if (seasons.length) {
      var sHead = document.createElement('h3');
      sHead.className = 'cb-ephead';
      sHead.textContent = seasons.length === 1 ? 'Season' : 'Seasons';
      wrap.appendChild(sHead);
      var sList = document.createElement('div');
      sList.className = 'cb-list list-group';
      seasons.forEach(function (season) { sList.appendChild(seasonRow(season)); });
      wrap.appendChild(sList);
    }

    if (!episodes.length) return;

    var eHead = document.createElement('h3');
    eHead.className = 'cb-ephead';
    eHead.textContent = 'Episodes';
    wrap.appendChild(eHead);

    var list = document.createElement('div');
    list.className = 'cb-list list-group';

    /* A long season is a scroll, not a page control. Paging a list you
       already have in hand adds a decision per twenty rows and buys nothing;
       a filter answers the actual question, which is "where is 34". It only
       appears once the list is long enough to be worth searching. */
    if (episodes.length > 20) {
      var filterWrap = document.createElement('div');
      filterWrap.className = 'cb-epfilter';
      var label = document.createElement('label');
      label.className = 'cb-sronly';
      label.setAttribute('for', 'epFilter');
      label.textContent = 'Find an episode';
      var input = document.createElement('input');
      input.type = 'search';
      input.id = 'epFilter';
      input.className = 'form-control';
      input.placeholder = 'Find an episode — a number or a name';
      input.autocomplete = 'off';
      var said = document.createElement('p');
      said.className = 'cb-epcount';
      said.setAttribute('role', 'status');

      input.addEventListener('input', function () {
        var q = input.value.trim().toLowerCase();
        var shown = 0;
        Array.prototype.forEach.call(list.children, function (row, i) {
          var ep = episodes[i];
          var hay = ((ep.title || '') + ' ' + episodeWords(ep) + ' ' + ep.url).toLowerCase();
          var hit = !q || hay.indexOf(q) !== -1;
          row.hidden = !hit;
          if (hit) shown += 1;
        });
        said.textContent = q
          ? (shown ? shown + ' of ' + episodes.length + ' shown' : 'Nothing matches “' + input.value.trim() + '”')
          : '';
      });

      filterWrap.appendChild(label);
      filterWrap.appendChild(input);
      filterWrap.appendChild(said);
      wrap.appendChild(filterWrap);
    }

    episodes.forEach(function (ep) { list.appendChild(episodeRow(ep)); });
    wrap.appendChild(list);
  }

  function crawl(rawUrl, opts) {
    opts = opts || {};
    var u = String(rawUrl || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!isHttp(u)) {
      renderBrowseError('That doesn\'t look like a web address.', false);
      return;
    }
    if (crawlInFlight || scanInFlight) return;

    setBrowseMode('episodes');
    lastScanUrl = u;
    crawlInFlight = true;
    var btn = $('btnScan');
    busy(btn, true, 'Reading…');
    fieldError($('pageUrl'), $('pageError'), null);
    $('browseHint').hidden = true;
    /* Only when there is nothing on screen. A re-crawl behind a remembered
       list must not replace it with a progress panel — the whole value of
       remembering it is that the list is there while this runs. */
    if (!opts.quiet) scanStop = startScanProgress($('browseResult'), 'quick');

    fetch('/api/crawl?url=' + encodeURIComponent(u), { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (res) {
        if (res.status === 401) { handleAuthLapse(); return; }
        var body = res.body || {};
        if (body.walled) { renderWalled(body); return; }
        if (body.botWall) { renderBotWall(body); return; }
        if (res.status !== 200 || body.ok !== true) {
          if (opts.quiet) return;   // the remembered list stays; it is still the best answer
          $('browseResult').innerHTML = '';
          renderBrowseError(body.error || 'That page couldn\'t be read.', true);
          return;
        }

        renderCrawl(body);

        /* Remembered only when it found something. A row that opens to an
           empty list is a worse thing to keep than no row. */
        if ((body.episodes && body.episodes.length) || (body.seasons && body.seasons.length)) {
          rememberSeries(body);
        }
      })
      .catch(function () {
        if (opts.quiet) return;
        $('browseResult').innerHTML = '';
        renderBrowseError('No connection to the scanner.', true);
      })
      .then(function () {
        if (!opts.quiet) endScanProgress();
        busy(btn, false);
        setBrowseMode('episodes');
        crawlInFlight = false;
      });
  }

  /* ---------- the shelf ---------- */

  function rememberSeries(data) {
    var url = data.finalUrl || data.url;
    if (!url) return;
    fetch('/api/series', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: url,
        title: data.title || '',
        host: data.host || hostOf(url),
        episodes: data.episodes || []
      })
    }).then(function (r) {
      if (r.status === 401) { handleAuthLapse(); return null; }
      return r.ok ? r.json() : null;
    }).then(function (body) {
      if (!body || !body.ok || !body.item) return;
      /* Replaced in place rather than appended: the server upserts on the
         address, so a second look at the same season is the same row. */
      seriesItems = [body.item].concat(
        seriesItems.filter(function (it) { return it.url !== body.item.url; }));
      renderSeriesList();
    }).catch(function () { /* the crawl still worked; the shelf is a bonus */ });
  }

  function openSeries(item) {
    $('pageUrl').value = item.url;
    setBrowseMode('episodes');

    /* Painted from memory first. This is the whole point of the row: a
       season you looked at yesterday is on screen in one frame instead of
       fifteen seconds, and the fresh read lands behind it. */
    if (item.episodes && item.episodes.length) {
      renderCrawl({
        url: item.url,
        finalUrl: item.url,
        title: item.title,
        host: item.host,
        via: 'words',
        episodes: item.episodes,
        seasons: []
      }, { cached: true });
      crawl(item.url, { quiet: true });
      return;
    }
    crawl(item.url);
  }

  function forgetSeries(item, row) {
    fetch('/api/series?id=' + encodeURIComponent(item.id), { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return; }
        if (!r.ok) { $('seriesError').textContent = 'That could not be removed.'; return; }
        seriesItems = seriesItems.filter(function (it) { return it.id !== item.id; });
        renderSeriesList();
        toast({
          text: 'Removed ' + (item.title || item.host || 'that series') + '.',
          actionLabel: 'Undo',
          onAction: function () { rememberSeries(item); },
          ms: 8000
        });
      })
      .catch(function () { $('seriesError').textContent = 'That could not be removed.'; });
  }

  function seriesRow(item) {
    var row = document.createElement('div');
    row.className = 'cb-seriesrow';

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'cb-seriesopen';

    var name = document.createElement('span');
    name.className = 'cb-seriesname';
    name.textContent = item.title || item.host || nameOf(item.url);
    open.appendChild(name);

    var sub = document.createElement('span');
    sub.className = 'cb-seriessub';
    var n = (item.episodes || []).length;
    sub.textContent = (item.host || hostOf(item.url)) +
      (n ? ' · ' + n + (n === 1 ? ' episode' : ' episodes') : '') +
      (item.at ? ' · ' + ago(Date.parse(item.at)) : '');
    open.appendChild(sub);

    open.addEventListener('click', function () { openSeries(item); });
    row.appendChild(open);

    /* One row, one way out. Undo rather than a confirm — nothing is
       destroyed here that a crawl cannot rebuild in ten seconds, so a
       dialog would cost more than the mistake does. */
    var forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'cb-seriesforget';
    forget.setAttribute('aria-label', 'Forget ' + (item.title || item.host || 'this series'));
    forget.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6 6 18"/></svg>';
    forget.addEventListener('click', function () { forgetSeries(item, row); });
    row.appendChild(forget);

    return row;
  }

  function renderSeriesList() {
    var box = $('seriesBox');
    var list = $('seriesList');
    list.innerHTML = '';
    $('seriesError').textContent = '';

    if (!seriesItems.length) { box.hidden = true; return; }
    box.hidden = false;
    seriesItems.forEach(function (item) { list.appendChild(seriesRow(item)); });
  }

  function refreshSeries(force) {
    if (seriesLoaded && !force) return;
    seriesLoaded = true;
    fetch('/api/series', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (body) {
        if (!body || !body.ok) return;
        seriesItems = body.items || [];
        renderSeriesList();
      })
      .catch(function () { /* offline: the shelf is simply not shown */ });
  }

  $('btnSeriesClear').addEventListener('click', function () {
    var kept = seriesItems.slice();
    fetch('/api/series?all=1', { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return; }
        if (!r.ok) { $('seriesError').textContent = 'That could not be cleared.'; return; }
        seriesItems = [];
        renderSeriesList();
        toast({
          text: 'Cleared ' + kept.length + (kept.length === 1 ? ' series.' : ' series.'),
          actionLabel: 'Undo',
          onAction: function () { kept.forEach(rememberSeries); },
          ms: 10000
        });
      })
      .catch(function () { $('seriesError').textContent = 'That could not be cleared.'; });
  });

  setBrowseMode('page');

  /* ------------------------------------------------------------------ *
   * History view
   * ------------------------------------------------------------------ */

  var histQuery = '';
  var starredOnly = false;

  function updateHistCount() {
    var n = store.count();
    var badge = $('histCount');
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  function visibleItems() {
    var q = histQuery.trim().toLowerCase();
    return store.all().filter(function (it) {
      if (starredOnly && !it.fav) return false;
      if (!q) return true;
      return (it.title || '').toLowerCase().indexOf(q) !== -1 ||
             (it.url || '').toLowerCase().indexOf(q) !== -1 ||
             (it.from || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function historyRow(it) {
    var row = document.createElement('div');
    row.className = 'list-group-item';

    var body = document.createElement('div');
    body.className = 'cb-item-body';

    var title = document.createElement('span');
    title.className = 'cb-item-title';
    title.textContent = it.title || nameOf(it.url);
    title.title = it.url;
    body.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'cb-item-meta';

    var badge = document.createElement('span');
    badge.className = 'badge badge-secondary';
    badge.textContent = it.kind || kindOf(it.url);
    meta.appendChild(badge);

    var when = document.createElement('span');
    when.textContent = ago(it.lastAt || it.addedAt);
    meta.appendChild(when);

    if (it.from) {
      var src = document.createElement('span');
      src.textContent = 'from ' + hostOf(it.from);
      meta.appendChild(src);
    }

    if (it.pos > 30 && (!it.dur || it.pos < it.dur - 20)) {
      var res = document.createElement('span');
      res.className = 'cb-resume';
      res.textContent = '↻ ' + clock(it.pos) + (it.dur ? ' of ' + clock(it.dur) : '');
      meta.appendChild(res);
    }

    body.appendChild(meta);

    if (it.dur && it.pos) {
      var bar = document.createElement('div');
      bar.className = 'cb-progress';
      var fill = document.createElement('i');
      fill.style.width = Math.min(100, Math.round((it.pos / it.dur) * 100)) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }

    row.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'cb-item-actions';

    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'btn btn-primary btn-sm cb-star' + (it.fav ? ' is-on' : '');
    star.setAttribute('aria-label', it.fav ? 'Remove star from ' + (it.title || 'this item') : 'Star ' + (it.title || 'this item'));
    star.setAttribute('aria-pressed', it.fav ? 'true' : 'false');
    star.textContent = it.fav ? '★' : '☆';
    star.addEventListener('click', function () {
      store.star(it.id);
      renderHistory();
    });
    actions.appendChild(star);

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn-secondary btn-sm';
    play.textContent = 'Play';
    play.addEventListener('click', function () {
      load(it.url, {
        title: it.title, from: it.from, poster: it.poster || '',
        /* Remembered from the scan that first played it, so a film reopened
           a week later still has somewhere to go when its host has changed
           its mind. */
        sources: it.sources || []
      });
      $('linkHint').hidden = true;
      showTab('link');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    actions.appendChild(play);

    /* Remove runs immediately and hands back ten seconds — a confirm dialog
       here would be friction without recovery. */
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-primary btn-sm';
    del.setAttribute('aria-label', 'Remove ' + (it.title || 'this item') + ' from history');
    del.textContent = '×';
    del.addEventListener('click', function () {
      var gone = store.remove(it.id);
      renderHistory();
      updateHistCount();
      if (!gone) return;
      store.bury(gone.item.url);
      forgetOnServer(gone.item.url);
      toast({
        text: 'Removed “' + (gone.item.title || nameOf(gone.item.url)) + '”.',
        actionLabel: 'Undo',
        onAction: function () {
          store.insertAt(gone.item, gone.at);
          store.revive(gone.item.url);
          recordPlay(gone.item.url, { title: gone.item.title, kind: gone.item.kind });
          renderHistory();
          updateHistCount();
        }
      });
    });
    actions.appendChild(del);

    row.appendChild(actions);
    return row;
  }

  function renderHistory() {
    var list = $('histList');
    var items = visibleItems();
    var total = store.count();

    list.innerHTML = '';
    items.forEach(function (it) { list.appendChild(historyRow(it)); });

    $('histEmpty').hidden = total !== 0;
    $('histDanger').hidden = total === 0;

    /* An active filter with no hits is a different state from an empty
       history, and it must not read as "you have nothing". */
    var noMatch = $('histNoMatch');
    if (total > 0 && items.length === 0) {
      noMatch.innerHTML = '';
      var span = document.createElement('span');
      span.textContent = starredOnly && histQuery
        ? 'Nothing starred matches “' + histQuery + '”.'
        : starredOnly ? 'Nothing starred yet.' : 'Nothing matches “' + histQuery + '”.';
      noMatch.appendChild(span);
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear the filter';
      clearBtn.addEventListener('click', function () {
        histQuery = '';
        starredOnly = false;
        $('histSearch').value = '';
        $('chipStarred').setAttribute('aria-pressed', 'false');
        renderHistory();
      });
      noMatch.appendChild(clearBtn);
      noMatch.classList.add('is-shown');
    } else {
      noMatch.classList.remove('is-shown');
      noMatch.innerHTML = '';
    }

    updateHistCount();
  }

  $('histSearch').addEventListener('input', function () {
    histQuery = this.value;
    renderHistory();
  });

  $('chipStarred').addEventListener('click', function () {
    starredOnly = this.getAttribute('aria-pressed') !== 'true';
    this.setAttribute('aria-pressed', starredOnly ? 'true' : 'false');
    renderHistory();
  });

  $('emptyGoLink').addEventListener('click', function () {
    showTab('link', { focus: true });
    $('url').focus();
  });

  $('btnClearHist').addEventListener('click', function () {
    var n = store.count();
    if (!n) return;
    var snapshot = store.clear();
    snapshot.forEach(function (it) { store.bury(it.url); });
    forgetAllOnServer();
    renderHistory();
    toast({
      text: n + (n === 1 ? ' entry cleared.' : ' entries cleared.'),
      actionLabel: 'Undo',
      onAction: function () {
        store.restore(snapshot);
        snapshot.forEach(function (it) {
          store.revive(it.url);
          recordPlay(it.url, { title: it.title, kind: it.kind });
        });
        renderHistory();
      }
    });
  });

  $('btnExportHist').addEventListener('click', function () {
    var blob = new Blob([store.exportJson()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cast-bridge-history.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    toast({ text: 'History saved as cast-bridge-history.json.' });
  });

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  updateHistCount();
  renderHistory();

  var params = new URLSearchParams(location.search);
  var deepLink = params.get('u');
  var deepPage = params.get('p');

  /* Share target: anything shared into the installed app arrives as ?s=.
     A share is often "look at this: <url>" prose, so pull the address out,
     then route it by shape — a media file plays, a page gets scanned. */
  var shared = params.get('s');
  if (shared && !deepLink && !deepPage) {
    var hit = shared.match(/https?:\/\/[^\s]+/);
    var addr = hit ? hit[0] : shared.trim();
    if (isHttp(addr)) {
      if (MEDIA_EXT.test(addr) || /drive\.google\.com|dropbox\.com|res\.cloudinary\.com/.test(addr)) {
        deepLink = addr;
      } else {
        deepPage = addr;
      }
    }
  }

  if (deepLink) {
    load(deepLink);
    $('linkHint').hidden = true;
  } else if (deepPage) {
    showTab('browse');
    $('pageUrl').value = deepPage;
    scan(deepPage);
  }

  if (store.count() && !deepLink && !deepPage) $('linkHint').hidden = false;

  /* ------------------------------------------------------------------ *
   * Build stamp and updates
   *
   * An installed copy keeps serving the shell it cached. Without a visible
   * build there is no way to tell a deploy that didn't happen from one that
   * did and hasn't reached this phone yet — so print it, and offer the
   * reload the moment a newer worker is waiting.
   * ------------------------------------------------------------------ */

  function showBuild(id) {
    var el = $('buildStamp');
    if (el) el.textContent = 'build ' + (id || '—');
  }

  function offerUpdate(worker) {
    toast({
      text: 'A newer version is ready.',
      actionLabel: 'Reload',
      onAction: function () {
        if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
        setTimeout(function () { location.reload(); }, 120);
      }
    });
  }

  /* Registering the worker is allowed to fail, and on this host it does.
     A bot wall or a captive portal answers `/sw.js` with an HTML page, and
     the browser refuses it — `SecurityError: unsupported MIME type
     ('text/html')`. That is a transient state: the challenge is solved a
     moment later and the very same URL then serves the script.

     The old `.catch(function () {})` turned that moment into a permanent
     one. No worker meant no notifications, no push and no offline copy, for
     the life of the page, with nothing on screen to say so — and reloading
     is not an obvious thing to try when nothing looks broken.

     So: try again, three times, backing off. If it still will not take,
     say which error it was rather than swallowing it. */
  function registerWorker(attempt) {
    return navigator.serviceWorker.register('sw.js')
      .then(function (reg) {
        /* The worker is what draws notifications, so nothing can be said
           until it exists. Anything the app wanted to report before this
           point is already held in `wanted` and paints on the next tick. */
        notify.setReg(reg);
        /* A button tapped while this app was not running is performed here,
           once the worker is known and the player is wired. */
        notify.drainPending();
        if (reg.waiting) offerUpdate(reg.waiting);

        reg.addEventListener('updatefound', function () {
          var next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', function () {
            /* A fresh install with no controller is the first visit, not
               an update — don't ask someone to reload a page they just
               opened for the first time. */
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              offerUpdate(next);
            }
          });
        });

        /* Ask the worker what it is, so the footer shows the build actually
           being served rather than the one that was deployed. On a first
           visit there is no controller yet — reg.active is already the
           activated worker, and that is exactly the visit where someone
           most wants to know which build they just landed on. */
        function askBuild(worker) {
          if (!worker) return;
          var ch = new MessageChannel();
          ch.port1.onmessage = function (e) {
            if (e.data && e.data.build) showBuild(e.data.build);
          };
          worker.postMessage({ type: 'GET_BUILD' }, [ch.port2]);
        }

        askBuild(navigator.serviceWorker.controller || reg.active);

        navigator.serviceWorker.addEventListener('controllerchange', function () {
          askBuild(navigator.serviceWorker.controller);
        });

        /* Check on every foreground — an installed app can sit for weeks. */
        reg.update().catch(function () {});
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) reg.update().catch(function () {});
        });
      })
      .catch(function (err) {
        var why = (err && (err.name + ': ' + err.message)) || 'unknown';
        if (attempt < 3) {
          /* 3s, then 9s. Long enough for a challenge to be solved and short
             enough that someone still has the app open when it lands. */
          setTimeout(function () { registerWorker(attempt + 1); }, attempt === 1 ? 3000 : 9000);
          return;
        }
        notify.setRegFailed(why);
      });
  }

  if ('serviceWorker' in navigator) {
    registerWorker(1);

    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.build) showBuild(e.data.build);
    });
  } else {
    showBuild('no offline copy');
  }

  /* ------------------------------------------------------------------ *
   * History sync
   *
   * The server is the record; localStorage is a cache so an installed copy
   * still renders offline. A row the server has never heard of is a row that
   * survives a reinstall only by luck, so every play is posted up and every
   * boot pulls down.
   * ------------------------------------------------------------------ */

  var histScope = 'mine';
  var everyone = [];   // owner's cross-account view, server-shaped

  function recordPlay(url, meta) {
    if (!signedIn || !url) return;
    fetch('/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: url,
        title: (meta && meta.title) || null,
        kind: (meta && meta.kind) || null
      })
    })
      .then(function (r) { if (r.status === 401) handleAuthLapse(); })
      .catch(function () { /* offline: the local copy already has it */ });
  }

  /* The server is the record, so a removal has to reach it. Until it does,
     the tombstone is what keeps the row out of the merge below — and a
     refresh retries the delete, so one made offline settles by itself. */
  function forgetOnServer(url) {
    if (!signedIn || !url) return Promise.resolve(false);
    return fetch('/api/history?url=' + encodeURIComponent(url), { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return false; }
        /* 404 is the server saying it never had it — forgotten either way. */
        if (r.ok || r.status === 404) { store.revive(url); return true; }
        return false;
      })
      .catch(function () { return false; });   // offline: the tombstone holds
  }

  function forgetAllOnServer() {
    if (!signedIn) return Promise.resolve(false);
    return fetch('/api/history?all=1', { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return false; }
        return r.ok;
      })
      .catch(function () { return false; });
  }

  function refreshHistory() {
    if (!signedIn) return Promise.resolve();

    var url = '/api/history' + (histScope === 'all' && isOwner() ? '?scope=all' : '');
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return null; }
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.ok) return;

        if (body.scope === 'all') {
          everyone = body.items || [];
          renderHistory();
          return;
        }

        /* Fold the server's rows into the local store so the richer local
           fields — position, star, play count — survive the merge. A row
           the server does not have is left alone rather than deleted: it is
           usually a play recorded while offline, waiting to go up. */
        (body.items || []).forEach(function (row) {
          /* A row deleted here that the server has not forgotten yet must
             not be added back. Retry the delete instead. */
          if (store.isBuried(row.url)) { forgetOnServer(row.url); return; }
          if (!store.find(row.url)) {
            store.touch(row.url, { title: row.title || '', from: 'server' });
          }
        });
        everyone = [];
        renderHistory();
      })
      .catch(function () { /* keep whatever is cached */ });
  }

  function wireHistoryScope() {
    var mine = $('scopeMine');
    var all = $('scopeAll');
    if (!mine || !all) return;

    function pick(next) {
      histScope = next;
      mine.classList.toggle('is-on', next === 'mine');
      all.classList.toggle('is-on', next === 'all');
      mine.setAttribute('aria-pressed', String(next === 'mine'));
      all.setAttribute('aria-pressed', String(next === 'all'));
      refreshHistory();
    }
    mine.addEventListener('click', function () { pick('mine'); });
    all.addEventListener('click', function () { pick('all'); });
  }

  /* ------------------------------------------------------------------ *
   * People (owner only)
   * ------------------------------------------------------------------ */

  var USERNAME_OK = /^[a-zA-Z0-9._-]{3,32}$/;

  function wireUsers() {
    var form = $('userForm');
    if (!form) return;

    var name = $('newUser');
    var pass = $('newPass');
    var btn = $('btnAddUser');
    var rules = $('newRules');

    /* Prevention, not a post-submit error: the checklist ticks as they type
       and the button is dead until both rules pass. */
    function judge() {
      var okName = USERNAME_OK.test((name.value || '').trim());
      var okPass = (pass.value || '').length >= 8;
      if (rules) {
        var li = rules.querySelectorAll('li');
        for (var i = 0; i < li.length; i++) {
          var r = li[i].getAttribute('data-rule');
          var on = r === 'len' ? okPass : okName;
          li[i].classList.toggle('is-met', on);
        }
      }
      if (btn) btn.disabled = !(okName && okPass);
      return okName && okPass;
    }
    name.addEventListener('input', judge);
    pass.addEventListener('input', judge);
    judge();

    var adding = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (adding || !judge()) return;

      /* Clear the old message first, and only then latch. Latching before the
         last thing that can throw is how this form came to be permanently
         dead: `adding` stayed true, the spinner stayed on, and every later
         tap returned at the line above. */
      fieldError(null, $('userError'), null);
      adding = true;
      busy(btn, true, 'Adding…');

      fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: name.value.trim(),
          password: pass.value,
          role: 'user'
        })
      })
        .then(function (r) {
          return r.json().then(function (b) { return { status: r.status, body: b }; });
        })
        .then(function (res) {
          if (res.status === 401) { handleAuthLapse(); return; }
          if (res.body && res.body.ok) {
            toast({ text: name.value.trim() + ' can sign in now.' });
            name.value = ''; pass.value = '';
            judge();
            renderUsers();
            return;
          }
          fieldError(null, $('userError'),
            (res.body && res.body.error) || 'That did not work.', null);
        })
        .catch(function () {
          fieldError(null, $('userError'), 'No connection.', null);
        })
        .then(function () { adding = false; busy(btn, false); });
    });
  }

  function userRow(u, meId) {
    var row = document.createElement('div');
    row.className = 'cb-userrow' + (u.active ? '' : ' is-off');

    var main = document.createElement('div');
    main.className = 'cb-userrow-main';

    var nm = document.createElement('span');
    nm.className = 'cb-userrow-name';
    nm.textContent = u.username;
    main.appendChild(nm);

    var tag = document.createElement('span');
    tag.className = 'cb-userrow-tag' + (u.role === 'admin' ? ' is-owner' : '');
    tag.textContent = u.role === 'admin' ? 'Owner' : (u.active ? 'Member' : 'Switched off');
    main.appendChild(tag);

    row.appendChild(main);

    /* You are not offered a way to lock yourself out — there is no second
       owner to let you back in. */
    if (u.id === meId) {
      var you = document.createElement('span');
      you.className = 'cb-userrow-you';
      you.textContent = 'You';
      row.appendChild(you);
      return row;
    }

    var acts = document.createElement('div');
    acts.className = 'cb-userrow-acts';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cb-linkbtn';
    toggle.textContent = u.active ? 'Switch off' : 'Switch on';
    toggle.addEventListener('click', function () {
      fetch('/api/users?id=' + encodeURIComponent(u.id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: !u.active })
      })
        .then(function () { renderUsers(); })
        .catch(function () { toast({ text: 'That did not go through.' }); });
    });
    acts.appendChild(toggle);

    /* Delete names what goes and who it belongs to, then asks again in
       place. No "Are you sure? Yes/No". */
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'cb-linkbtn is-danger';
    del.textContent = 'Remove';
    del.addEventListener('click', function () {
      if (del.dataset.armed === '1') {
        fetch('/api/users?id=' + encodeURIComponent(u.id), { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (b && b.ok) {
              toast({ text: 'Removed ' + u.username + ' and their history.' });
              renderUsers();
            } else {
              toast({ text: (b && b.error) || 'That did not work.' });
            }
          })
          .catch(function () { toast({ text: 'No connection.' }); });
        return;
      }
      del.dataset.armed = '1';
      del.textContent = 'Remove ' + u.username + ' for good?';
      setTimeout(function () {
        if (!del.isConnected) return;
        del.dataset.armed = '';
        del.textContent = 'Remove';
      }, 5000);
    });
    acts.appendChild(del);

    row.appendChild(acts);
    return row;
  }

  function renderUsers() {
    var list = $('userList');
    if (!list || !isOwner()) return;

    return fetch('/api/users', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { handleAuthLapse(); return null; }
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.ok) return;
        list.innerHTML = '';
        (body.users || []).forEach(function (u) {
          list.appendChild(userRow(u, body.me));
        });
      })
      .catch(function () { /* leave the last good list on screen */ });
  }

  /* ------------------------------------------------------------------ *
   * Pull to refresh
   *
   * Rules, in order: never fire below the threshold; resist with a decaying
   * curve so the sheet moves less than the finger; one continuous element
   * from stretch to spinner; a haptic tick at the threshold BEFORE release
   * so it can still be cancelled; overshoot and settle; and the list stays
   * scrollable the whole time.
   * ------------------------------------------------------------------ */

  /* A pull on the gate is a reload, and a reload that leaves a superseded
     worker in charge is not one. Ask for the update first, give it a beat to
     take over, then go — but never hang on it, because offline the update
     never resolves and the reload still has to happen. */
  /* Throw away every cache this origin holds.
   *
   * Rj, 2026-09-08, about the helm apps and this one: *"add pull to refresh
   * that clear cache."* Asking for a newer WORKER fixes the ordinary case and
   * does nothing for the case somebody actually pulls in — the build has not
   * changed and a stored response is what is wrong. The asset caches here are
   * read cache-first and never revalidated, so anything wrong in one is
   * permanent and every reload re-reads it.
   *
   * ONLINE ONLY, and that guard is the whole safety argument: the cached
   * shell is the only reason this app opens with no signal, so dropping it
   * offline turns the gesture that gets somebody unstuck into the one that
   * bricks the app until they find signal. `navigator.onLine` is only trusted
   * in the direction it is reliable — a definite false means definitely
   * offline. */
  function dropCaches() {
    if (typeof caches === 'undefined') return Promise.resolve(false);
    if (navigator.onLine === false) return Promise.resolve(false);
    return caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function reloadShell() {
    var updated = dropCaches().then(function () {
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return null;
      return navigator.serviceWorker.getRegistration()
        .then(function (reg) {
          if (!reg) return null;
          return reg.update().then(function () {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          });
        })
        .catch(function () {});
    });
    /* 2500, not 1500: the cache drop is now inside the race and a full asset
       cache takes longer to clear than an update check takes to answer. The
       cap still exists for the same reason it always did — offline the update
       never resolves and the reload still has to happen. */
    var cap = new Promise(function (r) { setTimeout(r, 2500); });
    return Promise.race([updated, cap]).then(function () {
      location.reload();
    });
  }

  function wirePullToRefresh() {
    /* Listening on .cb-shell meant the gesture died on the login screen: the
       shell carries `inert` while the gate is up, so no touch inside it ever
       dispatched. The document hears both surfaces; the scroll guards below
       are what keep a normal scroll from being read as a pull. */
    var host = document;
    var ind = $('ptr');
    if (!ind) return;

    /* A pull that starts inside a list which is itself scrolled down is a
       scroll, not a refresh — window.scrollY alone cannot see that. */
    function scrolledInner(node) {
      for (var el = node; el && el !== document.body; el = el.parentElement) {
        if (el.scrollTop > 0) return true;
      }
      return false;
    }

    var ring = ind.querySelector('.cb-ptr-ring');
    var THRESHOLD = 72;    // px of travel, after resistance
    var MAX = 108;         // nothing moves past this
    var startY = 0;
    var pull = 0;
    var tracking = false;
    var armed = false;     // past the threshold, haptic already spent
    var running = false;

    var reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* Content moves less than the finger, and less and less the further it
       goes. Linear travel is what makes a pull feel weightless and cheap. */
    function resist(raw) {
      return MAX * (1 - Math.exp(-raw / 140));
    }

    function paint(y) {
      ind.style.transform = 'translate3d(-50%,' + y + 'px,0)';
      ind.style.opacity = String(Math.min(1, y / 34));
      if (ring) {
        var pct = Math.min(1, y / THRESHOLD);
        /* Stretch and ring are the same element: the arc grows with the
           pull and becomes the spinner, it does not pop in. */
        ring.style.setProperty('--cb-ptr-sweep', (pct * 360).toFixed(1) + 'deg');
        ring.style.transform = 'rotate(' + (pct * 210).toFixed(1) + 'deg)';
      }
      ind.classList.toggle('is-armed', y >= THRESHOLD);
    }

    function settle() {
      ind.style.transition = 'transform .34s cubic-bezier(.22,1.2,.36,1), opacity .2s ease';
      ind.style.transform = 'translate3d(-50%,0,0)';
      ind.style.opacity = '0';
      setTimeout(function () { ind.style.transition = ''; }, 360);
    }

    function fire() {
      running = true;
      ind.classList.add('is-running');
      ind.style.transition = 'transform .2s ease';
      ind.style.transform = 'translate3d(-50%,' + THRESHOLD + 'px,0)';

      /* Signed in, there is data to re-read. On the gate there is none, so
         "pull to reload" means what it says — take the newest build. */
      var gated = document.body.classList.contains('is-gated');
      /* SIGNED IN THE CACHES GO AND THE PAGE DOES NOT. Reloading here would
         throw away whatever is half-typed in the paste box and lose the
         player's position; dropping the stale assets is the part a data
         re-read cannot do, and it is the part that was asked for. The gate,
         where there is nothing to lose, is the one that reloads. */
      var work = gated
        ? reloadShell()
        : Promise.all([dropCaches(), refreshHistory(), restoreSession(),
                       isOwner() ? renderUsers() : null]);

      /* A refresh that resolves in 40ms reads as a broken button, so hold
         the ring long enough to be seen finishing. */
      var floor = new Promise(function (r) { setTimeout(r, 480); });

      Promise.all([work, floor])
        .catch(function () { return []; })
        .then(function (res) {
          if (gated) return;          // the page is on its way out
          running = false;
          ind.classList.remove('is-running', 'is-armed');
          settle();
          /* Say WHICH of the two things happened. A pull that cleared the
             caches and one that could not — offline, or no Cache API — both
             reported "Up to date.", so from inside the app there was no way
             to tell whether the clear this gesture exists for had actually
             run. res[0] is `work`'s array; its first entry is dropCaches(). */
          var cleared = !!(res && res[0] && res[0][0]);
          toast({ text: cleared ? 'Cache cleared \u2014 up to date.' : 'Up to date.' });
        });
    }

    host.addEventListener('touchstart', function (e) {
      if (running) return;
      /* Only from a genuine top. Starting a pull mid-list is a scroll. */
      if (window.scrollY > 0) return;
      if (e.touches.length !== 1) return;
      if (scrolledInner(e.target)) return;
      startY = e.touches[0].clientY;
      tracking = true;
      armed = false;
      pull = 0;
    }, { passive: true });

    host.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      var raw = e.touches[0].clientY - startY;
      if (raw <= 0) {
        /* They went back up — hand the gesture back to the scroller. */
        if (pull === 0) { tracking = false; return; }
        raw = 0;
      }
      if (window.scrollY > 0) { tracking = false; settle(); return; }

      pull = resist(raw);
      paint(pull);

      if (pull >= THRESHOLD && !armed) {
        armed = true;
        /* The tick fires at the threshold, not on release, so the user
           learns it will fire while they can still cancel by sliding back.
           iOS Safari has no vibration API; this is Android-only by nature. */
        if (!reduced && navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
      }
      if (pull < THRESHOLD) armed = false;

      /* Only claim the gesture once it is unambiguously a pull, so a normal
         downward scroll is never swallowed. */
      if (pull > 6 && e.cancelable) e.preventDefault();
    }, { passive: false });

    function release() {
      if (!tracking) return;
      tracking = false;
      if (pull >= THRESHOLD) fire();
      else settle();          // below the line: snap back, no reload
      pull = 0;
      armed = false;
    }
    host.addEventListener('touchend', release, { passive: true });
    host.addEventListener('touchcancel', release, { passive: true });
  }

  /* ------------------------------------------------------------------ *
   * A file on this phone
   *
   * The honest constraint first: a Chromecast fetches over the network, and
   * a phone is not a server, so there is no address on the handset a
   * television can reach. blob: is local to this document; file: is local to
   * the device; neither leaves the browser. That is not a gap in this app,
   * it is what the platform is.
   *
   * So there are two halves and they are told apart on screen. Playing here
   * is instant and costs nothing — a blob URL into the same <video>. Sending
   * it to the television means the bytes have to exist somewhere the
   * television can fetch from, which is the stream host, which means an
   * upload and a wait. The panel says which one is happening and what it
   * costs before either starts.
   * ------------------------------------------------------------------ */

  var localPick = null;        // { file, blobUrl, remote, share }
  var uploadXhr = null;

  /* How long an upload is kept, in hours, with 0 meaning until it is deleted
     by hand. Chosen at the point of sending rather than in a settings screen,
     because it is a property of the thing being sent: a clip for the TV
     tonight and a file somebody will open next week are the same button and
     different answers. The default is the day it has always been. */
  var KEEP_CHOICES = [
    { hours: 24, label: '1 day' },
    { hours: 24 * 7, label: '7 days' },
    { hours: 24 * 30, label: '30 days' },
    { hours: 0, label: 'Until I delete it' }
  ];
  var keepChoice = 24;

  function keepWords(hours) {
    if (hours === 0) return 'kept until you delete it';
    if (hours < 48) return 'deleted after ' + hours + ' hours';
    return 'deleted after ' + Math.round(hours / 24) + ' days';
  }

  /* Trades this origin's session for a short signed ticket the stream host
     will accept. Every call to that host goes through here. */
  function streamTicket(scope) {
    return fetch('/api/ticket?scope=' + encodeURIComponent(scope), {
      headers: { accept: 'application/json' }
    }).then(function (r) {
      return r.json().then(function (b) {
        if (r.status === 401) { handleAuthLapse(); throw new Error('signed out'); }
        if (!r.ok || !b || !b.ok) throw new Error((b && b.error) || 'No ticket.');
        return b;
      });
    });
  }

  function releaseLocal() {
    if (localPick && localPick.blobUrl) {
      try { URL.revokeObjectURL(localPick.blobUrl); } catch (e) { /* already gone */ }
    }
    localPick = null;
  }

  $('btnPickFile').addEventListener('click', function () { $('fileInput').click(); });

  $('fileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    /* Picking, then cancelling, must not wipe what is already playing. */
    if (!file) return;
    /* Chrome keeps the same file selected, so re-picking the same video
       would not fire change again without this. */
    this.value = '';
    playLocalFile(file);
  });

  function playLocalFile(file) {
    releaseLocal();
    var url = URL.createObjectURL(file);
    localPick = { file: file, blobUrl: url, remote: null };

    teardownHls();
    teardownDash();
    clearSubs();
    current = url;
    currentTitle = file.name;
    currentFrom = 'this phone';
    hlsProxied = false;
    video.src = url;
    screenEl.classList.remove('is-idle');
    screenEl.classList.add('is-live');
    $('linkHint').hidden = true;
    /* Nothing else may act on a blob: the TV cannot fetch it, VLC cannot
       open it and there is nothing worth copying. Send to TV is the only
       way out, and it is in the panel below. */
    $('btnVlc').disabled = true;
    $('btnCopy').disabled = true;
    setStatus('Playing from this phone. It is not on the television yet.', '');
    renderLocalPick();
    video.play().catch(function () { /* autoplay refused; the controls are there */ });
  }

  function renderLocalPick(state) {
    var box = $('deviceResult');
    box.textContent = '';
    if (!localPick) return;

    var wrap = document.createElement('div');
    wrap.className = 'cb-pick';

    var head = document.createElement('p');
    head.className = 'cb-pick-name';
    head.textContent = localPick.file.name;
    head.title = localPick.file.name;   // it truncates; the whole name stays reachable
    wrap.appendChild(head);

    var sub = document.createElement('p');
    sub.className = 'cb-pick-sub';
    wrap.appendChild(sub);

    if (localPick.remote) {
      sub.textContent = fmtSize(localPick.file.size) +
        ' — on the stream host and playing from there. Cast to TV will work now.';

      var done = document.createElement('p');
      done.className = 'cb-pick-note';
      done.textContent = 'It is ' + keepWords(localPick.keep) +
        ', and it is in your Library until then.';
      wrap.appendChild(done);

      if (localPick.share) {
        /* The address a person gets, rather than the raw file: it opens a
           page with a player, so a link sent to somebody who is not signed
           in to anything still just plays. */
        var share = document.createElement('p');
        share.className = 'cb-pick-share';
        share.textContent = localPick.share;
        wrap.appendChild(share);

        var copyShare = document.createElement('button');
        copyShare.type = 'button';
        copyShare.className = 'btn btn-secondary btn-sm';
        copyShare.textContent = 'Copy the link to share';
        copyShare.addEventListener('click', function () { copyText(localPick.share); });
        wrap.appendChild(copyShare);

        var toLib = document.createElement('button');
        toLib.type = 'button';
        toLib.className = 'cb-linkbtn';
        toLib.textContent = 'Open Library';
        toLib.addEventListener('click', function () { showView('library', { focus: true, push: true }); });
        wrap.appendChild(toLib);
      }

      box.appendChild(wrap);
      return;
    }

    if (state && state.uploading) {
      sub.textContent = 'Sending to the stream host so the television can fetch it.';

      var track = document.createElement('div');
      track.className = 'cb-scan-track';
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', 'Upload progress');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      var fill = document.createElement('div');
      fill.className = 'cb-scan-fill';
      fill.style.width = (state.pct || 0) + '%';
      track.setAttribute('aria-valuenow', String(Math.round(state.pct || 0)));
      track.appendChild(fill);
      wrap.appendChild(track);

      var clock = document.createElement('p');
      clock.className = 'cb-pick-clock';
      clock.textContent = state.line || '';
      wrap.appendChild(clock);

      var stop = document.createElement('button');
      stop.type = 'button';
      /* Not is-danger. Cancelling an upload destroys nothing — the file is
         still on the phone and the host deletes the part. Red spent here is
         red that no longer means anything at the Delete below it. */
      stop.className = 'cb-linkbtn';
      stop.textContent = 'Stop sending';
      stop.addEventListener('click', function () {
        if (uploadXhr) { uploadXhr.abort(); uploadXhr = null; }
      });
      wrap.appendChild(stop);

      box.appendChild(wrap);
      return;
    }

    sub.textContent = fmtSize(localPick.file.size) +
      ' — playing here. The television cannot reach a file on a phone, so ' +
      'sending it copies it to the stream host first.';

    /* Asked before the upload, not after, because it is what the upload
       does — and because a file already on a disk is a decision you have
       already made. Re-datable afterwards from the Library either way. */
    var keepWrap = document.createElement('div');
    keepWrap.className = 'cb-keep';
    var keepLabel = document.createElement('p');
    keepLabel.className = 'cb-keep-label';
    keepLabel.id = 'keepLabel';
    keepLabel.textContent = 'Keep it on the host for';
    keepWrap.appendChild(keepLabel);

    var seg = document.createElement('div');
    seg.className = 'cb-segment';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-labelledby', 'keepLabel');
    KEEP_CHOICES.forEach(function (choice) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cb-segment-btn' + (choice.hours === keepChoice ? ' is-on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', choice.hours === keepChoice ? 'true' : 'false');
      b.textContent = choice.label;
      b.addEventListener('click', function () {
        keepChoice = choice.hours;
        renderLocalPick(state);
      });
      seg.appendChild(b);
    });
    keepWrap.appendChild(seg);

    var keepNote = document.createElement('p');
    keepNote.className = 'cb-keep-note';
    keepNote.textContent = keepChoice === 0
      ? 'It stays until you delete it from the Library. Your disk, your call.'
      : 'The link stops working when it goes. You can extend it from the Library.';
    keepWrap.appendChild(keepNote);
    wrap.appendChild(keepWrap);

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-secondary btn-sm';
    go.innerHTML = '<span class="cb-label">Send to the TV</span>' +
      '<span class="cb-spin" aria-hidden="true"></span>';
    go.addEventListener('click', function () { uploadLocal(); });
    wrap.appendChild(go);

    if (state && state.error) {
      var err = document.createElement('p');
      err.className = 'cb-pick-error';
      err.setAttribute('role', 'alert');
      err.textContent = state.error;
      wrap.appendChild(err);
    }

    box.appendChild(wrap);
  }

  function uploadLocal() {
    if (!localPick || uploadXhr) return;
    var file = localPick.file;

    renderLocalPick({ uploading: true, pct: 0, line: 'Asking for a ticket…' });

    streamTicket('upload').then(function (t) {
      var started = Date.now();
      var xhr = new XMLHttpRequest();
      uploadXhr = xhr;

      xhr.open('POST', t.host + '/api/upload' +
        '?name=' + encodeURIComponent(file.name) +
        '&size=' + encodeURIComponent(file.size) +
        '&keep=' + encodeURIComponent(keepChoice));
      xhr.setRequestHeader('Authorization', 'Bearer ' + t.token);

      xhr.upload.addEventListener('progress', function (e) {
        if (!e.lengthComputable) return;
        var pct = (e.loaded / e.total) * 100;
        var secs = (Date.now() - started) / 1000;
        var rate = secs > 0.5 ? e.loaded / secs : 0;
        /* An estimate is only offered once there is enough of a run to base
           one on. A number that swings between four minutes and forty in the
           first second is worse than no number. */
        var left = rate > 0 ? (e.total - e.loaded) / rate : 0;
        var line = fmtSize(e.loaded) + ' of ' + fmtSize(e.total) +
          (rate ? ' · ' + fmtRate(rate * 8) : '') +
          (rate && left > 2 ? ' · about ' + fmtLength(left) + ' left' : '');
        renderLocalPick({ uploading: true, pct: pct, line: line });
        reportUpload(pct, file.name + ' · ' + line);
      });

      xhr.addEventListener('load', function () {
        uploadXhr = null;
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
        if (xhr.status === 201 && body && body.ok) {
          localPick.remote = body.url;
          localPick.share = body.share || null;
          /* What the host actually recorded, not what was asked for — it
             clamps, and a note claiming 30 days against a meta saying 30
             days is only true because they are read from the same answer. */
          localPick.keep = body.file && typeof body.file.keepHours === 'number'
            ? body.file.keepHours : keepChoice;
          libraryStale = true;
          /* From here it is an ordinary address, so everything an address
             can do comes back: cast, VLC, copy, history. */
          load(body.url, { title: file.name, from: 'this phone' });
          renderLocalPick();
          toast({ text: 'On the stream host. Tap Cast to TV.' });
          notify.close('upload');
          notify.show('upload-done', {
            title: 'Uploaded — ready for the TV',
            body: file.name,
            urgent: true
          });
          return;
        }
        var why = (body && body.error) ||
          'The stream host refused that file (' + xhr.status + ').';
        renderLocalPick({ error: why });
        notify.close('upload');
        reportIssue('upload-done', 'Upload failed', why);
      });

      xhr.addEventListener('error', function () {
        uploadXhr = null;
        renderLocalPick({ error: 'Could not reach the stream host.' });
        notify.close('upload');
        reportIssue('upload-done', 'Upload failed', 'Could not reach the stream host.');
      });
      xhr.addEventListener('abort', function () {
        uploadXhr = null;
        renderLocalPick({ error: 'Stopped. Nothing was left on the host.' });
        /* Cancelled on purpose, from the shade or from the screen. Saying
           "upload failed" about something you just stopped is the app
           arguing with you. */
        notify.close('upload');
      });

      xhr.send(file);
    }).catch(function (e) {
      uploadXhr = null;
      if (e && e.message === 'signed out') return;
      renderLocalPick({ error: (e && e.message) || 'Could not get a ticket.' });
    });
  }

  /* ------------------------------------------------------------------ *
   * Library
   *
   * Everything this account has put on the stream host, with the three
   * things you can do about it: send it to the television again, give
   * somebody the link, or take it down.
   *
   * It exists because the upload used to be write-only. A file went up, got
   * cast, and then lived on a disk with no screen anywhere that could name
   * it — the owner's Stream host panel could, but that is everybody's files
   * at once and only the owner can open it. This is one person's own shelf,
   * scoped by the uid inside the ticket rather than by anything the client
   * sends, so there is no id a caller could name to reach someone else's.
   *
   * A row's link is public on purpose: the television fetches it with no
   * headers we control, so the address IS the credential. That is said on
   * the screen in those words rather than assumed to be understood.
   * ------------------------------------------------------------------ */

  var libraryFiles = [];
  var libraryStale = true;
  var libRun = 0;
  /* Which row is one tap from being deleted. One at a time: arming a second
     row disarms the first, so there is never a screen with two live traps. */
  var libArmed = null;

  function libExpiryWords(f) {
    if (!f.expires) return 'Kept until you delete it';
    var left = Date.parse(f.expires) - Date.now();
    if (!isFinite(left)) return 'Kept until you delete it';
    if (left <= 0) return 'Expired — going on the next sweep';
    var h = left / 3600000;
    if (h < 1) return 'Goes in ' + Math.max(1, Math.round(left / 60000)) + ' min';
    if (h < 48) return 'Goes in ' + Math.round(h) + ' h';
    return 'Goes in ' + Math.round(h / 24) + ' days';
  }

  function updateLibCount(n) {
    var badge = $('libCount');
    if (!badge) return;
    badge.textContent = String(n);
    badge.hidden = !n;
  }

  function libSetKeep(file, hours) {
    return streamTicket('library').then(function (t) {
      return fetch(t.host + '/api/library/keep', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + t.token,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ id: file.id, keep: hours })
      }).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok || !b || !b.ok) throw new Error((b && b.error) || 'That could not be changed.');
          return b.file;
        });
      });
    });
  }

  function libDelete(file) {
    return streamTicket('library').then(function (t) {
      return fetch(t.host + '/api/library/delete', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + t.token,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ ids: [file.id] })
      }).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok || !b || !b.ok) throw new Error((b && b.error) || 'That could not be deleted.');
          return b.removed;
        });
      });
    });
  }

  function libRow(f) {
    var row = document.createElement('div');
    row.className = 'cb-librow' + (f.missing ? ' is-missing' : '');

    var head = document.createElement('div');
    head.className = 'cb-librow-head';

    var name = document.createElement('p');
    name.className = 'cb-librow-name';
    name.textContent = f.name;
    name.title = f.name;
    head.appendChild(name);

    /* Size right-aligned in its own slot with tabular figures, so a column
       of them lines up on the last digit instead of wandering. */
    var size = document.createElement('span');
    size.className = 'cb-librow-size';
    size.textContent = f.missing ? '—' : fmtSize(f.bytes);
    head.appendChild(size);
    row.appendChild(head);

    var meta = document.createElement('p');
    meta.className = 'cb-librow-meta';
    meta.textContent = f.missing
      ? 'The bytes are gone from the disk — only the record is left.'
      : ago(Date.parse(f.added)) + ' · ' + libExpiryWords(f);
    row.appendChild(meta);

    var link = document.createElement('p');
    link.className = 'cb-librow-link';
    link.textContent = f.share;
    row.appendChild(link);

    var acts = document.createElement('div');
    acts.className = 'cb-librow-acts';

    var cast = document.createElement('button');
    cast.type = 'button';
    cast.className = 'btn btn-secondary btn-sm';
    cast.textContent = 'Send to the TV';
    cast.disabled = Boolean(f.missing);
    cast.addEventListener('click', function () {
      /* The television is handed /f/<id>, never the watch page — a Cast
         receiver fetches media, and would be handed HTML. */
      load(f.url, { title: f.name, from: 'the stream host' });
      showView('cast', { focus: true, push: true });
      toast({ text: 'Loaded. Tap Cast to TV.' });
    });
    acts.appendChild(cast);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cb-linkbtn';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', function () {
      copyText(f.share).then(function (okCopy) {
        toast({ text: okCopy ? 'Link copied. Anyone with it can watch.' : 'Couldn’t reach the clipboard.' });
      });
    });
    acts.appendChild(copy);

    var keep = document.createElement('select');
    keep.className = 'form-control custom-select cb-librow-keep';
    keep.setAttribute('aria-label', 'How long to keep ' + f.name);
    KEEP_CHOICES.forEach(function (choice) {
      var opt = document.createElement('option');
      opt.value = String(choice.hours);
      opt.textContent = choice.label;
      keep.appendChild(opt);
    });
    /* A stored value that is not one of the four offered — an older upload,
       or a clamp — gets its own option rather than silently showing 1 day
       and lying about what the file is set to. */
    var stored = typeof f.keepHours === 'number' ? f.keepHours : null;
    if (stored !== null && !KEEP_CHOICES.some(function (c) { return c.hours === stored; })) {
      var odd = document.createElement('option');
      odd.value = String(stored);
      odd.textContent = stored + ' h';
      keep.insertBefore(odd, keep.firstChild);
    }
    if (stored !== null) keep.value = String(stored);
    keep.addEventListener('change', function () {
      var hours = Number(keep.value);
      keep.disabled = true;
      libSetKeep(f, hours).then(function (updated) {
        f.expires = updated.expires;
        f.keepHours = updated.keepHours;
        meta.textContent = ago(Date.parse(f.added)) + ' · ' + libExpiryWords(f);
        keep.disabled = false;
        toast({ text: f.name + ' — ' + keepWords(updated.keepHours) + '.' });
      }).catch(function (e) {
        keep.disabled = false;
        if (e && e.message === 'signed out') return;
        libError((e && e.message) || 'That could not be changed.');
      });
    });
    acts.appendChild(keep);

    /* Deleting is the one thing here that cannot be undone: the bytes go and
       every link anybody was given stops working. So it is a text link off
       the primary slot, it arms rather than fires, and the armed label names
       the file and the consequence instead of asking "are you sure". */
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'cb-linkbtn is-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      if (libArmed !== f.id) {
        libArmed = f.id;
        renderLibraryList();
        return;
      }
      del.disabled = true;
      del.textContent = 'Deleting…';
      libDelete(f).then(function () {
        libArmed = null;
        libraryStale = true;
        toast({ text: f.name + ' deleted. Its link no longer works.' });
        renderLibrary();
      }).catch(function (e) {
        del.disabled = false;
        del.textContent = 'Delete';
        if (e && e.message === 'signed out') return;
        libError((e && e.message) || 'That could not be deleted.');
      });
    });

    if (libArmed === f.id) {
      del.textContent = 'Delete for good';
      row.classList.add('is-armed');
      var warn = document.createElement('p');
      warn.className = 'cb-librow-warn';
      warn.setAttribute('role', 'alert');
      warn.textContent = 'Deletes ' + f.name + ' from the stream host. Anyone ' +
        'you sent the link to loses it. This cannot be undone.';
      row.appendChild(warn);

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'cb-linkbtn';
      cancel.textContent = 'Keep it';
      cancel.addEventListener('click', function () { libArmed = null; renderLibraryList(); });
      acts.appendChild(cancel);
    }

    acts.appendChild(del);
    row.appendChild(acts);
    return row;
  }

  function libError(message) {
    var box = $('libError');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('is-shown', Boolean(message));
  }

  function renderLibraryList() {
    var list = $('libList');
    var empty = $('libEmpty');
    if (!list) return;
    list.textContent = '';
    updateLibCount(libraryFiles.length);
    if (!libraryFiles.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    libraryFiles.forEach(function (f) { list.appendChild(libRow(f)); });
  }

  function renderLibrary(opts) {
    var list = $('libList');
    if (!list) return;
    /* Two arrivals in quick succession used to be able to draw twice — the
       same shape of bug the Stream host panel had. The token is what a late
       answer checks itself against. */
    var run = ++libRun;

    if (!libraryStale && !(opts && opts.force)) {
      renderLibraryList();
      return;
    }

    libError(null);
    list.textContent = '';
    var loading = document.createElement('p');
    loading.className = 'cb-host-empty';
    loading.textContent = 'Asking the stream host…';
    list.appendChild(loading);
    var empty = $('libEmpty');
    if (empty) empty.hidden = true;

    streamTicket('library').then(function (t) {
      return fetch(t.host + '/api/library', {
        headers: { Authorization: 'Bearer ' + t.token, accept: 'application/json' }
      }).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok || !b || !b.ok) throw new Error((b && b.error) || 'The stream host would not answer.');
          return b;
        });
      });
    }).then(function (b) {
      if (run !== libRun) return;
      libraryFiles = b.files || [];
      libraryStale = false;
      renderLibraryList();
    }).catch(function (e) {
      if (run !== libRun) return;
      if (e && e.message === 'signed out') return;
      list.textContent = '';
      /* An error rendered as an empty list reads as "you have no files",
         which is a different and much worse sentence than "I could not
         ask". Say which one happened. */
      libError((e && e.message) || 'Could not reach the stream host.');
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary btn-sm';
      retry.textContent = 'Try again';
      retry.addEventListener('click', function () { renderLibrary({ force: true }); });
      list.appendChild(retry);
    });
  }

  if ($('libRefresh')) {
    $('libRefresh').addEventListener('click', function () {
      libArmed = null;
      renderLibrary({ force: true });
    });
  }
  if ($('libGoCast')) {
    $('libGoCast').addEventListener('click', function () {
      showView('cast', { focus: true, push: true });
      $('btnPickFile').click();
    });
  }

  /* ------------------------------------------------------------------ *
   * The stream host — what it is doing and what it is holding
   *
   * Owner only, and closed until opened: this is the one panel that costs a
   * round trip to a second machine to draw, so it is not drawn for people
   * who are not looking at it.
   * ------------------------------------------------------------------ */

  function hostRow(label, value, kind) {
    var row = document.createElement('div');
    row.className = 'cb-host-row' + (kind ? ' is-' + kind : '');
    var k = document.createElement('span');
    k.className = 'cb-host-k';
    k.textContent = label;
    var v = document.createElement('span');
    v.className = 'cb-host-v';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  function setHostDot(kind) {
    $('hostDot').className = 'cb-dot' + (kind ? ' is-' + kind : '');
  }

  /* Two opens in quick succession used to draw the list twice: renderHost
     clears the panel synchronously, but renderHostFiles appends when its
     request comes back, so the first run's answer landed in the second
     run's panel. Measured — the file list and both clear buttons appeared
     in duplicate. The token is what a late answer checks itself against. */
  var hostRun = 0;

  function renderHost() {
    var body = $('hostBody');
    var run = ++hostRun;
    body.textContent = '';
    var loading = document.createElement('p');
    loading.className = 'cb-host-empty';
    loading.textContent = 'Asking the stream host…';
    body.appendChild(loading);

    var host = STREAM_HOSTS[0] || location.origin;

    fetch(host + '/healthz', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (h) {
        body.textContent = '';
        setHostDot('live');
        $('hostSummary').textContent = 'Stream host — up';

        body.appendChild(hostRow('Up for', fmtLength(h.uptime_s || 0)));
        body.appendChild(hostRow('Streams in flight', String(h.in_flight || 0)));
        body.appendChild(hostRow('Read window', (h.window_mb || 0) + ' MiB'));
        /* The service reports to three decimals so a quiet day is not
           rounded to zero. Read down a column, 12.5 next to 340.125 is two
           different kinds of number — so the column picks one shape and the
           small values keep their decimals only while they need them. */
        var gbText = function (v) {
          var n = Number(v) || 0;
          if (n >= 10) return n.toFixed(1) + ' GB';
          if (n >= 0.1) return n.toFixed(2) + ' GB';
          return n ? n.toFixed(3) + ' GB' : '0 GB';
        };
        body.appendChild(hostRow('Served today', gbText(h.served_today_gb)));
        body.appendChild(hostRow('Served this month', gbText(h.served_this_month_gb)));

        var st = h.storage;
        if (!st) {
          body.appendChild(hostRow('Files', 'not reported'));
          return;
        }
        body.appendChild(hostRow('Files held', fmtSize(st.files.bytes) +
          ' in ' + st.files.count + (st.files.count === 1 ? ' item' : ' items')));
        body.appendChild(hostRow('Half-finished uploads', fmtSize(st.tmp.bytes) +
          ' in ' + st.tmp.count + (st.tmp.count === 1 ? ' item' : ' items')));
        body.appendChild(hostRow('Free on the disk',
          st.free_bytes === null ? 'unknown' : fmtSize(st.free_bytes)));
        body.appendChild(hostRow('Deleted after', st.file_ttl_hours + ' hours'));

        var folder = document.createElement('p');
        folder.className = 'cb-host-path';
        folder.textContent = st.root;
        body.appendChild(folder);

        renderHostFiles(body, run);
      })
      .catch(function () {
        body.textContent = '';
        setHostDot('bad');
        $('hostSummary').textContent = 'Stream host — not answering';
        var p = document.createElement('p');
        p.className = 'cb-host-empty';
        p.textContent = 'No answer from ' + host + '. Casting still works — the ' +
          'app falls back to serving the film through this origin.';
        body.appendChild(p);

        /* Every error carries a way out. A box that was rebooting when this
           was opened is the ordinary case, and closing and reopening the
           panel is not an obvious retry. */
        var again = document.createElement('button');
        again.type = 'button';
        again.className = 'cb-linkbtn';
        again.textContent = 'Try again';
        again.addEventListener('click', renderHost);
        body.appendChild(again);
      });
  }

  /* The box itself, not the service on it. "Is the stream host up" is the
     question /healthz answers; "is the box in trouble" is a different one,
     and load, memory and the running commit are how it gets answered from
     a phone without opening a terminal. Owner-only by the same ticket as
     the file list — a viewer has no use for it and a stranger might. */
  function renderHostMachine(body, sys) {
    if (!sys || !sys.ok) return;
    var svc = sys.service || {};
    var m = sys.machine || {};

    var head = document.createElement('p');
    head.className = 'cb-host-head';
    head.textContent = 'The machine';
    body.appendChild(head);

    if (m.uptime_s != null) {
      body.appendChild(hostRow('Box up for', fmtLength(m.uptime_s)));
    }
    if (m.load && m.load.length) {
      /* Per core first, because that is the number with a threshold: 1.0
         is a busy machine whatever its core count, and the raw triple next
         to it says whether it is getting worse or better. */
      var perCore = m.load_per_core == null ? null : m.load_per_core.toFixed(2);
      body.appendChild(hostRow('Load',
        (perCore ? perCore + ' per core' : m.load[0].toFixed(2)) +
        '  (' + m.load.map(function (n) { return n.toFixed(2); }).join(' · ') + ')',
        m.load_per_core != null && m.load_per_core >= 1 ? 'warn' : ''));
    }
    if (m.mem_total) {
      body.appendChild(hostRow('Memory',
        fmtSize(m.mem_total - m.mem_free) + ' of ' + fmtSize(m.mem_total) +
        ' used  (' + m.mem_used_pct + '%)',
        m.mem_used_pct >= 90 ? 'warn' : ''));
    }
    if (m.cpu_count) {
      body.appendChild(hostRow('Processors', m.cpu_count + ' cores'));
    }
    if (svc.pid) {
      body.appendChild(hostRow('Service', 'pid ' + svc.pid + ' · node ' + (svc.node || '?')));
    }
    if (svc.commit) {
      body.appendChild(hostRow('Running commit', svc.commit));
    }
    if (m.platform) {
      var plat = document.createElement('p');
      plat.className = 'cb-host-path';
      plat.textContent = (m.hostname ? m.hostname + ' · ' : '') + m.platform + ' · ' + m.arch;
      body.appendChild(plat);
    }
  }

  /* The list and the buttons that empty it. Separate request from /healthz
     because it needs a ticket and /healthz deliberately does not. */
  function renderHostFiles(body, run) {
    streamTicket('storage').then(function (t) {
      var head = { authorization: 'Bearer ' + t.token, accept: 'application/json' };
      return Promise.all([
        fetch(t.host + '/api/storage', { headers: head }).then(function (r) { return r.json(); }),
        /* The machine's own vitals, on the same ticket. Allowed to fail by
           itself: a stream host that has not been pulled yet has no
           /api/system, and an older box must not cost the file list its
           render. */
        fetch(t.host + '/api/system', { headers: head })
          .then(function (r) { return r.json(); })
          .catch(function () { return null; })
      ]).then(function (both) {
        return { t: t, b: both[0], sys: both[1] };
      });
    }).then(function (res) {
      if (run !== hostRun) return;          // a newer open has already drawn
      var b = res.b;
      if (!b || !b.ok) throw new Error((b && b.error) || 'Could not read the folder.');

      renderHostMachine(body, res.sys);

      var listHead = document.createElement('p');
      listHead.className = 'cb-host-head';
      listHead.textContent = 'On the disk';
      body.appendChild(listHead);

      var list = document.createElement('div');
      list.className = 'cb-host-files';

      if (!b.files.length) {
        var empty = document.createElement('p');
        empty.className = 'cb-host-empty';
        empty.textContent = 'The folder is empty.';
        list.appendChild(empty);
      }

      b.files.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'cb-host-file';

        var name = document.createElement('span');
        name.className = 'cb-host-fname';
        name.textContent = f.name;
        name.title = f.name;

        var size = document.createElement('span');
        size.className = 'cb-host-fsize';
        /* The sidecar says the file exists and the disk says it does not.
           "0 B" would report that as an empty file, which is a different
           and untrue thing; an em-dash reports it as unknown, which is what
           it is. */
        size.textContent = f.missing ? '—' : fmtSize(f.bytes);
        if (f.missing) {
          size.classList.add('is-missing');
          size.title = 'The record is here but the file is not.';
        }

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'cb-linkbtn is-danger';
        del.textContent = 'Delete';
        /* Armed in place, same as removing a person. No modal, and the
           second tap names what goes. */
        del.addEventListener('click', function () {
          if (del.dataset.armed === '1') {
            del.disabled = true;
            hostPost('/api/storage/delete', { ids: [f.id] })
              .then(function () {
                toast({ text: 'Deleted ' + f.name + ' from the stream host.' });
                renderHost();
              })
              .catch(function (e) {
                del.disabled = false;
                del.dataset.armed = '';
                del.textContent = 'Delete';
                toast({ text: e.message || 'That did not work.' });
              });
            return;
          }
          del.dataset.armed = '1';
          del.textContent = 'Delete for good?';
          setTimeout(function () {
            if (!del.isConnected) return;
            del.dataset.armed = '';
            del.textContent = 'Delete';
          }, 5000);
        });

        row.appendChild(name);
        row.appendChild(size);
        row.appendChild(del);
        list.appendChild(row);
      });

      var acts = document.createElement('div');
      acts.className = 'cb-host-acts';
      /* One of these two is red and the other is not, on purpose. Clearing
         half-finished uploads removes files nobody has ever been able to
         play; clearing the folder removes films someone is part-way through.
         Only the second is destruction, and only the second says so — five
         red things in one panel is no red things. */
      acts.appendChild(clearButton('Clear half-finished uploads', 'tmp',
        b.usage && b.usage.tmp && b.usage.tmp.count
          ? 'Clear ' + b.usage.tmp.count + ' half-finished?'
          : 'Clear half-finished uploads?', false));
      /* The armed label names the blast radius rather than the verb alone:
         "every file" is a category, "3 files (1.2 GB)" is a decision. */
      acts.appendChild(clearButton('Clear everything in the folder', 'all',
        b.files.length
          ? 'Delete ' + b.files.length + (b.files.length === 1 ? ' file' : ' files') +
            ' (' + fmtSize(b.files.reduce(function (t, f) { return t + (f.bytes || 0); }, 0)) + ')?'
          : 'Delete everything?', true));
      list.appendChild(acts);

      body.appendChild(list);
    }).catch(function (e) {
      if (run !== hostRun) return;
      if (e && e.message === 'signed out') return;
      var p = document.createElement('p');
      p.className = 'cb-host-empty';
      p.textContent = e && e.message ? e.message : 'Could not read the folder.';
      body.appendChild(p);
    });
  }

  function clearButton(label, what, armedLabel, destructive) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cb-linkbtn' + (destructive ? ' is-danger' : '');
    b.textContent = label;
    b.addEventListener('click', function () {
      if (b.dataset.armed === '1') {
        /* The second tap is the one that spends money on a round trip, so
           it is also the one that has to stop being tappable. Turning the
           button off is not the guard — the endpoint is idempotent — but a
           button that stays live through a request reads as one that did
           nothing. */
        b.disabled = true;
        hostPost('/api/storage/clear', { what: what })
          .then(function (body) {
            var freed = 0;
            var r = body.cleared || {};
            ['files', 'tmp'].forEach(function (k) { if (r[k]) freed += r[k].bytes || 0; });
            toast({ text: freed ? 'Freed ' + fmtSize(freed) + '.' : 'Nothing to clear.' });
            renderHost();
          })
          .catch(function (e) {
            b.disabled = false;
            b.dataset.armed = '';
            b.textContent = label;
            toast({ text: e.message || 'That did not work.' });
          });
        return;
      }
      b.dataset.armed = '1';
      b.textContent = armedLabel;
      setTimeout(function () {
        if (!b.isConnected) return;
        b.dataset.armed = '';
        b.textContent = label;
      }, 5000);
    });
    return b;
  }

  function hostPost(path, payload) {
    return streamTicket('storage').then(function (t) {
      return fetch(t.host + path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + t.token,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); }).then(function (b) {
        if (!b || !b.ok) throw new Error((b && b.error) || 'That did not work.');
        return b;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Record this screen
   *
   * What is left of a panel headed "Put this screen on the TV". It gave a
   * page of instructions for the television's own menu, and they were both
   * correct and useless: a web page cannot mirror a screen, so the panel's
   * whole job was explaining that it could not do its job. Rj's instruction
   * was to remove it if it cannot be used. It is removed.
   *
   * The reason, kept here rather than on screen. The Cast sender API takes a
   * MediaInfo whose contentId is an ADDRESS — there is no overload that
   * accepts a MediaStream. Chrome's own ⋮ → Cast → Cast screen is a browser
   * feature driven by Media Router, not an API a page is handed. The
   * Presentation API presents a URL on a registered receiver, which is a
   * different page on the television rather than this one mirrored. And
   * getDisplayMedia can capture, but nothing can then hand that stream to a
   * Chromecast.
   *
   * What survives is the half that was real: capture, stop, upload, play —
   * which goes down the same path a picked file takes. Not live, and the
   * note says so. It appears only where the browser can actually do it,
   * which is Chrome and Edge on a computer; Android Chrome does not
   * implement getDisplayMedia at all, so a phone never saw a button here,
   * only the instructions that have now gone.
   * ------------------------------------------------------------------ */

  var recorder = null;
  var recChunks = [];
  var recStream = null;
  var REC_NOTE = ($('recNote') && $('recNote').textContent) || '';

  function canCaptureScreen() {
    return Boolean(navigator.mediaDevices &&
      navigator.mediaDevices.getDisplayMedia &&
      window.MediaRecorder);
  }

  function renderRec(state) {
    var box = $('recBox');
    var btn = $('btnRecScreen');
    var note = $('recNote');
    if (!box || !btn || !note) return;

    /* Hidden, not disabled: a disabled button is a promise the browser
       cannot keep, and there is nothing the person could do about it. */
    if (!canCaptureScreen()) { box.hidden = true; return; }
    box.hidden = false;

    state = state || {};
    var label = btn.querySelector('.cb-label');

    if (state.recording) {
      label.textContent = 'Stop and send to the TV';
      btn.classList.add('is-rec');
      /* Assigned, not added: renderRec runs once a second while recording,
         and addEventListener would stack a handler on every tick. */
      btn.onclick = stopScreenRecording;
      note.classList.remove('cb-pick-error');
      note.removeAttribute('role');
      note.textContent = 'Recording — ' + fmtLength(state.seconds || 0) +
        (state.bytes ? ' · ' + fmtSize(state.bytes) : '');
      return;
    }

    label.textContent = 'Record this screen';
    btn.classList.remove('is-rec');
    btn.onclick = startScreenRecording;
    if (state.error) {
      note.classList.add('cb-pick-error');
      note.setAttribute('role', 'alert');
      note.textContent = state.error;
      return;
    }
    note.classList.remove('cb-pick-error');
    note.removeAttribute('role');
    note.textContent = REC_NOTE;
  }

  renderRec();

  function startScreenRecording() {
    if (recorder) return;
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      .then(function (stream) {
        recStream = stream;
        recChunks = [];
        var bytes = 0;
        var started = Date.now();

        /* webm/vp8 is the one thing every Chromium build can record and
           every Chromecast can play. Asking for something better and
           falling back is how a recording ends up in a container the
           television refuses at the last step. */
        var mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          .filter(function (m) { return window.MediaRecorder.isTypeSupported(m); })[0] || '';

        recorder = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        recorder.addEventListener('dataavailable', function (e) {
          if (!e.data || !e.data.size) return;
          recChunks.push(e.data);
          bytes += e.data.size;
        });

        var tick = setInterval(function () {
          if (!recorder) { clearInterval(tick); return; }
          renderRec({
            recording: true,
            seconds: (Date.now() - started) / 1000,
            bytes: bytes
          });
        }, 1000);

        /* Stopping the share from the browser's own bar, rather than from
           the button here, must end the recording too — otherwise the panel
           counts up against a stream that has already gone. */
        stream.getVideoTracks().forEach(function (t) {
          t.addEventListener('ended', stopScreenRecording);
        });

        recorder.addEventListener('stop', function () {
          clearInterval(tick);
          var blob = new Blob(recChunks, { type: mime || 'video/webm' });
          recChunks = [];
          if (recStream) {
            recStream.getTracks().forEach(function (t) { t.stop(); });
            recStream = null;
          }
          recorder = null;
          renderRec({});
          if (!blob.size) {
            renderRec({ error: 'Nothing was recorded.' });
            return;
          }
          /* Straight into the same path a picked file takes — one upload,
             one progress bar, one place it lands. */
          var name = 'screen-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.webm';
          playLocalFile(new File([blob], name, { type: blob.type }));
          toast({ text: 'Recorded. Tap Send to the TV under the player.' });
        });

        recorder.start(1000);
        renderRec({ recording: true, seconds: 0, bytes: 0 });
      })
      .catch(function (e) {
        /* A refused permission prompt is a choice, not a fault, and does not
           get an error message. */
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
          renderRec({});
          return;
        }
        renderRec({ error: 'This browser would not share the screen.' });
      });
  }

  function stopScreenRecording() {
    if (!recorder) return;
    try { recorder.stop(); } catch (e) { /* already stopping */ }
  }

  /* ------------------------------------------------------------------ *
   * Bilibili
   *
   * Signed out, the API still serves an address — 720p, and only for videos
   * that are open to everyone. Signed in it serves the members-only ones
   * too. So this screen is not a gate: the paste box works either way, and
   * it says what signing in would add rather than demanding it first.
   *
   * The sign-in is Bilibili's QR flow, and the code is now DRAWN here.
   * It used to be offered as a link to open, on the theory that a phone
   * would deep-link it into the Bilibili app — Rj opened it and got
   * account.bilibili.com/h5/…/scan-web, a page that does nothing, because
   * that address is the payload a camera is meant to read, not a place to
   * go. assets/js/qr.js encodes it; the SVG below draws it.
   * ------------------------------------------------------------------ */

  /* One path element per run of dark modules in a row. Fewer nodes than a
     rect each, and a `shape-rendering: crispEdges` box around it, because a
     QR that is antialiased at the module edges is a QR a camera hunts for. */
  function qrSvg(text, label) {
    if (!window.CBQR) throw new Error('no encoder');
    var q = window.CBQR.encode(text);
    var quiet = 4;                       /* the spec's margin — a code with no
                                            quiet zone reads as no code */
    var span = q.size + quiet * 2;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + span + ' ' + span);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label || 'QR code');

    var bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(span));
    bg.setAttribute('height', String(span));
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    var d = '';
    for (var r = 0; r < q.size; r++) {
      var run = 0;
      for (var c = 0; c <= q.size; c++) {
        var dark = c < q.size && q.modules[r * q.size + c];
        if (dark) { run++; continue; }
        if (run) {
          d += 'M' + (c - run + quiet) + ' ' + (r + quiet) + 'h' + run + 'v1h-' + run + 'z';
          run = 0;
        }
      }
    }
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000000');
    svg.appendChild(path);
    return svg;
  }

  /* The same code as a PNG, because a QR needs two devices and a person
     often has one. Saved to the phone's own photos it can be fed to
     Bilibili's scanner from the album, which is the only route that works
     when the screen showing the code and the camera reading it are the
     same piece of glass. Twelve pixels a module: big enough that a scanner
     reading a screenshot has no trouble, small enough to stay under a
     couple of hundred kilobytes. */
  function qrCanvas(text, scale) {
    var q = window.CBQR.encode(text);
    var quiet = 4;
    var s = scale || 12;
    var span = (q.size + quiet * 2) * s;
    var c = document.createElement('canvas');
    c.width = span;
    c.height = span;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, span, span);
    g.fillStyle = '#000000';
    for (var r = 0; r < q.size; r++) {
      for (var col = 0; col < q.size; col++) {
        if (q.modules[r * q.size + col]) {
          g.fillRect((col + quiet) * s, (r + quiet) * s, s, s);
        }
      }
    }
    return c;
  }

  /* Share sheet where there is one, a download where there is not. On a
     phone the share sheet is the thing that reaches the photo library;
     a download lands in Files, where Bilibili's album picker cannot see
     it. So share is tried first and the download is the fallback. */
  function saveQrImage(text) {
    var canvas;
    try {
      canvas = qrCanvas(text);
    } catch (e) {
      toast({ text: 'Couldn’t draw that code as an image.' });
      return;
    }
    canvas.toBlob(function (blob) {
      if (!blob) { toast({ text: 'Couldn’t save that code.' }); return; }
      var name = 'bilibili-sign-in.png';

      if (window.File && navigator.canShare) {
        var file = new File([blob], name, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'Bilibili sign-in code' })
            .catch(function () { /* dismissing the sheet is not an error */ });
          return;
        }
      }

      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      toast({ text: 'Saved the code.' });
    }, 'image/png');
  }

  /* Somewhere to paste a sign-in.
   *
   * Rj's words: the sign-in address has nowhere to be pasted. He is right —
   * the Bilibili app has no address bar, so an address copied out of this
   * panel had no destination. This is the destination: a session copied out
   * of a browser that is already signed in. It goes to the server, which
   * asks Bilibili who it belongs to before keeping any of it. */
  function biliPasteForm(parent) {
    var box = document.createElement('details');
    box.className = 'cb-bili-paste';

    var head = document.createElement('summary');
    head.textContent = 'Paste a sign-in instead';
    box.appendChild(head);

    biliSay(box, 'On a computer, sign in at bilibili.com or bilibili.tv — they are ' +
      'separate accounts and this keeps both. Then open the developer tools ' +
      '→ Application → Cookies and copy SESSDATA, or paste a cookies.txt ' +
      'exported from that browser. Only SESSDATA, bili_jct and DedeUserID are ' +
      'read out of it. A cookies.txt names its own site, so it is filed for ' +
      'you; a bare SESSDATA is taken as bilibili.com.', 'cb-bili-small');

    var field = document.createElement('textarea');
    field.className = 'cb-input cb-bili-cookie';
    field.rows = 3;
    field.placeholder = 'SESSDATA=…; bili_jct=…; DedeUserID=…';
    field.setAttribute('aria-label', 'Bilibili session cookie');
    field.autocapitalize = 'off';
    field.autocomplete = 'off';
    field.spellcheck = false;
    box.appendChild(field);

    var note = document.createElement('p');
    note.className = 'cb-bili-small';
    note.hidden = true;

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary btn-sm';
    go.textContent = 'Use this sign-in';
    go.disabled = true;

    /* Checked when the field is left, and live only once it has already
       said something is wrong — the same ladder the rest of the app's
       fields climb. Judging a cookie on every keystroke would call a
       half-pasted SESSDATA wrong while it is still arriving. */
    var live = false;

    /* The tab form is a cookies.txt line, where the name and value are
       separated by a tab rather than an equals — the shape every export
       extension writes, and the one this used to call unrecognisable. */
    function looksLikeSession(t) {
      return /SESSDATA\s*[=:]/i.test(t) || /(^|\s)SESSDATA\s+\S/i.test(t) ||
        (t.match(/%2C/gi) || []).length >= 2;
    }

    /* Which sign-in a paste belongs to, read before the server sees it.
       This used to be `wrongSite`, which refused a bilibili.tv export — the
       two sites are separate accounts and only .com was supported. Both are
       supported now, so the same signal that produced a refusal picks a
       destination instead. A cookies.txt carries its own domains; anything
       else is taken as .com, which is what a bare SESSDATA has always been. */
    function siteOf(t) {
      return (/bilibili\.tv/i.test(t) && !/bilibili\.com/i.test(t)) ? 'tv' : 'com';
    }

    /* Interrupting for a refusal, polite for a confirmation — the same line
       carries both, so the role moves with the message rather than
       shouting every time the field starts to look right. */
    function say(text, bad) {
      note.className = bad ? 'cb-pick-error' : 'cb-bili-small';
      note.setAttribute('role', bad ? 'alert' : 'status');
      note.textContent = text;
      note.hidden = false;
    }

    field.addEventListener('input', function () {
      go.disabled = !field.value.trim();
      if (!live) return;
      /* Confirm right, not only wrong: silence after a correction reads as
         still-wrong. */
      if (looksLikeSession(field.value)) {
        say(siteOf(field.value) === 'tv'
          ? 'That looks like a Bilibili TV session.'
          : 'That looks like a session.', false);
      } else if (siteOf(field.value) === 'tv') {
        say('That is from bilibili.tv but carries no SESSDATA — the export was ' +
          'made signed out, or it skipped HttpOnly cookies.', true);
      } else say('Still no SESSDATA in that.', true);
    });

    field.addEventListener('blur', function () {
      var t = field.value.trim();
      if (!t || looksLikeSession(t)) return;
      live = true;
      if (siteOf(t) === 'tv') {
        say('That is from bilibili.tv but carries no SESSDATA. Sign in there, ' +
          'check your name shows on the page, then export again.', true);
        return;
      }
      say('No SESSDATA in that. It is the long value that starts with letters ' +
        'and has %2C in it twice.', true);
    });

    go.addEventListener('click', function () {
      var text = field.value.trim();
      if (!text) { field.focus(); return; }
      go.disabled = true;
      note.hidden = true;
      var site = siteOf(text);
      fetch('/api/bilibili?action=paste' + (site === 'tv' ? '&site=tv' : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: text })
      })
        .then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); })
        .then(function (res) {
          if (res.s === 401) { handleAuthLapse(); return; }
          if (!res.b || !res.b.ok) {
            go.disabled = false;
            live = true;
            say((res.b && res.b.error) || 'That sign-in was refused.', true);
            return;
          }
          /* Cleared before anything else: a session sitting in a textarea
             is a session sitting in the DOM. */
          field.value = '';
          stopBiliPoll();
          if (site === 'tv') {
            /* Re-read rather than render from this one answer: the .com half
               of the panel is unchanged by a .tv paste and still has to be
               shown. bstar publishes no endpoint that names an account, so
               the toast reports what the session is worth instead — which is
               the reason to have signed in at all. */
            toast({ text: res.b.hd
              ? 'Signed in to Bilibili TV — HD unlocked.'
              : 'Signed in to Bilibili TV.' });
            refreshBili();
            return;
          }
          renderBili({ signedIn: true, name: res.b.name, vip: res.b.vip });
          toast({ text: 'Signed in to Bilibili as ' + res.b.name + '.' });
        })
        .catch(function () {
          go.disabled = false;
          live = true;
          say('No connection to the sign-in service.', true);
        });
    });

    /* The message sits under the field it judges, not under the button.
       Below the action it reads as a verdict on the press; above it, it is
       what it actually is — a note about what was pasted. */
    box.appendChild(note);
    box.appendChild(go);
    parent.appendChild(box);
  }

  var biliPoll = null;

  function stopBiliPoll() {
    if (biliPoll) { clearInterval(biliPoll); biliPoll = null; }
  }

  function setBiliDot(kind) {
    $('biliDot').className = 'cb-dot' + (kind ? ' is-' + kind : '');
  }

  function biliSay(parent, text, cls) {
    var p = document.createElement('p');
    p.className = cls || 'cb-bili-note';
    p.textContent = text;
    parent.appendChild(p);
    return p;
  }

  /* One sign-out control, told which session it ends. Two near-identical
     copies of this drifted the moment .tv arrived — the .com one confirmed
     in place and the .tv one would not have. */
  function biliSignOutButton(label, qs, after) {
    var out = document.createElement('button');
    out.type = 'button';
    /* Signing out destroys nothing — the account is untouched and signing
       back in takes one tap. Red is for destruction. */
    out.className = 'cb-linkbtn';
    out.textContent = 'Sign out of ' + label;
    out.addEventListener('click', function () {
      if (out.dataset.armed === '1') {
        fetch('/api/bilibili?action=signout' + qs, { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function () { toast({ text: 'Signed out of ' + label + '.' }); after(); })
          .catch(function () { toast({ text: 'No connection.' }); });
        return;
      }
      out.dataset.armed = '1';
      out.textContent = 'Sign out of ' + label + '?';
      setTimeout(function () {
        if (!out.isConnected) return;
        out.dataset.armed = '';
        out.textContent = 'Sign out of ' + label;
      }, 5000);
    });
    return out;
  }

  /* The Bilibili TV half of the panel. Appended whichever way the .com half
     went, because the two sessions do not depend on each other. */
  function renderBstarSection(body, tv) {
    if (!tv || !tv.signedIn) return;
    biliSay(body, 'Bilibili TV — signed in.' + (tv.hd
      ? ' HD is unlocked, so a cast goes out at the best rendition the title offers.'
      : ' Nothing above 480p came back on the reference title, so casts may be capped there.'),
      'cb-bili-small');
    body.appendChild(biliSignOutButton('Bilibili TV', '&site=tv', refreshBili));
  }

  function renderBili(state) {
    var body = $('biliBody');
    if (!body) return;
    body.textContent = '';
    state = state || {};

    if (state.loading) {
      setBiliDot('');
      biliSay(body, 'Checking…');
      return;
    }

    if (state.signedIn) {
      setBiliDot('live');
      $('biliSummary').textContent = 'Bilibili — ' + state.name;
      biliSay(body, 'Signed in as ' + state.name +
        (state.vip ? ' (with a membership).' : '.') +
        ' Paste a bilibili.com, b23.tv, bilibili.tv or bili.im link in the box below ' +
        'and it resolves through Bilibili’s API — series and user uploads alike.');
      /* 720p is the bilibili.com ceiling specifically: it is the best that
         site serves as a single progressive file. bilibili.tv is not bound by
         it — it serves DASH, which this app turns into a manifest, so its
         ceiling is whatever the account unlocks. Saying "casting" flatly
         would now be wrong about half the app. */
      biliSay(body, 'Casting from bilibili.com is capped at 720p — that is the ' +
        'best quality it serves as a single file, and a television can only be ' +
        'handed one address.', 'cb-bili-small');

      body.appendChild(biliSignOutButton('Bilibili', '', refreshBili));
      renderBstarSection(body, state.tvState);
      return;
    }

    setBiliDot(state.tvState && state.tvState.signedIn ? 'live' : '');
    $('biliSummary').textContent = (state.tvState && state.tvState.signedIn)
      ? 'Bilibili TV' : 'Bilibili';
    renderBstarSection(body, state.tvState);

    if (state.lapsed) {
      biliSay(body, 'That Bilibili session has expired — Bilibili ended it, ' +
        'not this app. Sign in again to get the members-only videos back.');
    }

    if (state.waiting) {
      if (state.note) biliSay(body, state.note, 'cb-bili-small');

      var line = biliSay(body, state.waiting === 'scanned'
        ? 'Scanned. Now confirm it in the Bilibili app.'
        : 'Point the Bilibili app’s scanner at this code.');
      line.setAttribute('role', 'status');

      /* The code itself. This is the whole fix: what Bilibili hands back is
         the PAYLOAD of a QR, and the app used to offer it as a link to open
         — which lands on account.bilibili.com's scan page, in a browser,
         where it does nothing and says nothing. It is meant to be looked at
         by the Bilibili app's camera, so it is drawn.

         Drawn as an SVG rather than a canvas: it is one path per dark row,
         it scales to whatever the layout gives it with no blur and no
         devicePixelRatio arithmetic, and it survives a screenshot. */
      var frame = document.createElement('div');
      frame.className = 'cb-qr';
      try {
        frame.appendChild(qrSvg(state.url, 'Bilibili sign-in code'));
      } catch (e) {
        /* An encoder that cannot encode says so and offers the address,
           rather than leaving an empty white square that looks like a code
           the camera is failing to read. */
        biliSay(body, 'This sign-in code could not be drawn. Open the address ' +
          'below on a phone with Bilibili installed.', 'cb-pick-error');
      }
      body.appendChild(frame);

      biliSay(body, 'On a second phone: open Bilibili → the scan button, top ' +
        'left of Home → point it here.', 'cb-bili-small');

      /* What used to stand here was an offer to copy the address and open it
         in Bilibili. There is nowhere in the Bilibili app to open an address
         — it has no address bar — so that advice sent people to a dead end.
         The two routes below are the ones that finish. */
      biliSay(body, 'Only one phone? Save the code to your photos, then in ' +
        'Bilibili’s scanner tap the album button and pick it.', 'cb-bili-small');

      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-sm';
      save.textContent = 'Save this code';
      save.addEventListener('click', function () { saveQrImage(state.url); });
      body.appendChild(save);

      var stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'cb-linkbtn';
      stop.textContent = 'Cancel';
      stop.addEventListener('click', function () { stopBiliPoll(); renderBili({ signedIn: false }); });
      body.appendChild(stop);
      biliPasteForm(body);
      return;
    }

    biliSay(body, 'Not signed in. Bilibili links still work — they resolve at ' +
      '720p, for videos that are open to everyone. Signing in reaches the ' +
      'members-only ones.');

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary btn-sm';
    go.textContent = 'Sign in to Bilibili';
    go.addEventListener('click', function () { startBiliLogin(); });
    body.appendChild(go);
    biliPasteForm(body);

    if (state.error) {
      var err = biliSay(body, state.error, 'cb-pick-error');
      err.setAttribute('role', 'alert');
    }
  }

  /* How many lapsed codes are replaced without being asked. Bilibili's key
     is good for something over ten minutes — measured, not assumed: one
     generated here still polled as unscanned at ten and came back
     二维码已失效 by fifteen. This panel used to give up on it at three, wipe
     the code off the screen and say it had expired, which is both wrong and
     the likeliest reason a code ever read as invalid at the scanner: it was
     older than the panel had any way of knowing. Bilibili is now the only
     thing that decides a code is dead, and when it does, the code is
     replaced where it stands. */
  var BILI_REPLACEMENTS = 3;

  /* A ceiling anyway, so a panel left open overnight is not asking Bilibili
     a question every two seconds until morning. */
  var BILI_CODE_CEILING_MS = 20 * 60 * 1000;

  function startBiliLogin(replaced, note) {
    stopBiliPoll();
    renderBili({ loading: true });

    fetch('/api/bilibili?action=start', { method: 'POST' })
      .then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); })
      .then(function (res) {
        if (res.s === 401) { handleAuthLapse(); return; }
        if (!res.b || !res.b.ok) {
          renderBili({ error: (res.b && res.b.error) || 'Bilibili would not start a sign-in.' });
          return;
        }
        var key = res.b.key;
        var url = res.b.url;
        var shown = null;

        /* Painted when the state changes and not on every poll. The old
           code re-rendered the whole panel every two seconds, which redrew
           the QR forty times a minute for no reason — and would wipe out
           anything half-typed into the paste box below it. */
        function paint(state) {
          if (state === shown) return;
          shown = state;
          renderBili({ waiting: state, url: url, note: note });
        }
        paint('waiting');

        var until = Date.now() + BILI_CODE_CEILING_MS;

        biliPoll = setInterval(function () {
          if (Date.now() > until) {
            stopBiliPoll();
            renderBili({ error: 'That sign-in has been sitting here twenty minutes. Start another.' });
            return;
          }
          fetch('/api/bilibili?action=poll&key=' + encodeURIComponent(key))
            .then(function (r) { return r.json(); })
            .then(function (b) {
              if (!b || !b.ok) {
                stopBiliPoll();
                renderBili({ error: (b && b.error) || 'That sign-in stopped working.' });
                return;
              }
              if (b.state === 'ok') {
                stopBiliPoll();
                renderBili({ signedIn: true, name: b.name });
                toast({ text: 'Signed in to Bilibili as ' + b.name + '.' });
                return;
              }
              if (b.state === 'expired') {
                stopBiliPoll();
                var n = (replaced || 0) + 1;
                if (n > BILI_REPLACEMENTS) {
                  renderBili({ error: 'Bilibili keeps letting these codes lapse before ' +
                    'anything scans them. Start another when you have the phone in hand.' });
                  return;
                }
                startBiliLogin(n, 'That code lapsed before it was scanned — here is a fresh one.');
                return;
              }
              paint(b.state);
            })
            .catch(function () { /* one missed poll is not a failure */ });
        }, 2000);
      })
      .catch(function () {
        renderBili({ error: 'No connection to the sign-in service.' });
      });
  }

  /* Two sign-ins, asked for together. bilibili.com and bilibili.tv are
     separate accounts in separate cookies, and either can be present without
     the other — so the panel reads both and shows what it finds. Asking only
     for .com, as this did while .tv was unsupported, would leave a signed-in
     Bilibili TV session invisible and looking like it had not been kept. */
  function refreshBili() {
    renderBili({ loading: true });
    var ask = function (qs) {
      return fetch('/api/bilibili?action=status' + qs)
        .then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); });
    };
    Promise.all([ask(''), ask('&site=tv')])
      .then(function (both) {
        if (both[0].s === 401 || both[1].s === 401) { handleAuthLapse(); return; }
        var state = both[0].b || {};
        state.tvState = both[1].b || {};
        renderBili(state);
      })
      .catch(function () { renderBili({ error: 'Could not reach the sign-in service.' }); });
  }

  /* The door goes up before anything else is usable. The gate is unhidden in
     the markup and the body starts .is-gated, so the app is never painted to
     someone who has not signed in; checkSession() takes it down. */
  sealShell(true);
  wireGate();
  wireHistoryScope();
  wireUsers();
  wirePullToRefresh();
  checkSession();
})();
