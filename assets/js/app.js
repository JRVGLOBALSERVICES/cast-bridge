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

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

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

  function busy(btn, on) {
    if (on) {
      btn.style.minWidth = btn.offsetWidth + 'px'; // lock width, spinner moves nothing
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
    } else {
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
    }
  }

  /* ------------------------------------------------------------------ *
   * Field errors — inline, under the field, with a way out
   * ------------------------------------------------------------------ */

  function fieldError(input, box, message, action) {
    box.innerHTML = '';
    if (!message) {
      box.classList.remove('is-shown');
      input.removeAttribute('aria-invalid');
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
    input.setAttribute('aria-invalid', 'true');
  }

  /* ------------------------------------------------------------------ *
   * Tabs
   * ------------------------------------------------------------------ */

  var TABS = ['link', 'browse', 'history', 'users'];
  var activeTab = 'link';
  var scrollMemory = {};
  var indicatorPlaced = false;

  /* The pill is drawn from measurements, so it is only ever as right as the
     last thing that measured it. It used to be measured on a tab click and on
     a window resize and nowhere else, which left it wrong in both of the
     states the app actually opens in.

     Cold, nothing had measured it: no width, no offset, so the Link tab
     opened looking unselected. And signing in as the owner reveals the People
     tab, which re-flexes four tabs into the space of three WITHOUT changing
     the strip's own size — so a pill placed while there were three kept that
     width and spilled a third of the way onto Browse. Measured at 412px:
     Link became 22..114, the pill stayed 22..145.

     So place it at first paint, and re-place it whenever the strip moves
     under it, whatever the cause. */
  function moveIndicator() {
    var btn = $('tab-' + activeTab);
    var ind = $('tabIndicator');
    if (!btn || !ind || btn.hidden) return;
    var w = btn.offsetWidth;
    if (!w) return;          /* not laid out yet — an observer will call back */

    /* The first placement is where the pill IS, not somewhere it travelled
       from. Letting it slide in from the left edge is the same wrong-tab
       flash, just in motion. */
    if (!indicatorPlaced) {
      ind.style.transition = 'none';
      ind.style.width = w + 'px';
      ind.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
      void ind.offsetWidth;  /* commit before the transition comes back */
      ind.style.transition = '';
      indicatorPlaced = true;
      return;
    }
    ind.style.width = w + 'px';
    ind.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
  }

  function showTab(name, opts) {
    if (TABS.indexOf(name) === -1) return;
    scrollMemory[activeTab] = window.scrollY;
    activeTab = name;

    TABS.forEach(function (t) {
      var btn = $('tab-' + t), pane = $('pane-' + t);
      var on = t === name;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      pane.classList.toggle('is-active', on);
    });

    moveIndicator();

    /* A tab switch is a route change — put the user back where they were
       rather than at zero. */
    if (opts && opts.focus) $('pane-' + name).focus({ preventScroll: true });
    var y = scrollMemory[name];
    if (typeof y === 'number') window.scrollTo({ top: y, behavior: 'auto' });

    if (name === 'history') renderHistory();
    if (name === 'users') renderUsers();
  }

  TABS.forEach(function (t) {
    $('tab-' + t).addEventListener('click', function () { showTab(t, { focus: true }); });
  });

  /* Arrows walk the tab strip; Home/End jump. */
  $('tab-link').parentNode.addEventListener('keydown', function (e) {
    var i = TABS.indexOf(activeTab);
    var next = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (next) { e.preventDefault(); showTab(next, { focus: true }); $('tab-' + next).focus(); }
  });

  window.addEventListener('resize', moveIndicator);

  /* A window resize is not the only thing that moves these buttons. The strip
     re-flexes when the owner's People tab appears, and every button changes
     width when the webfont replaces the fallback — neither raises a resize.
     Watch the buttons themselves. Only the buttons: the pill is absolutely
     positioned, so resizing it cannot feed back into what we observe. */
  if (window.ResizeObserver) {
    var stripWatch = new ResizeObserver(function () { moveIndicator(); });
    stripWatch.observe($('tab-link').parentNode);
    TABS.forEach(function (t) { var b = $('tab-' + t); if (b) stripWatch.observe(b); });
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(moveIndicator).catch(function () {});
  }
  moveIndicator();

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
  var hls = null;
  /* One proxy retry per load, or a stream that is genuinely gone loops. */
  var hlsProxied = false;
  var castState = 'NO_DEVICES_AVAILABLE';
  var lastSaved = 0;

  /* The Cast remote. Null until the sender library is up; the panel that
     drives it stays hidden until the TV reports media actually loaded. */
  var remotePlayer = null;
  var remoteCtl = null;
  var scrubbing = false;

  /* Subtitles, as the address of our own converted copy — never the file
     the person pasted, which is almost never VTT and almost never CORS. */
  var subsProxy = '';
  var subsName = '';

  function setStatus(text, kind) {
    statusText.textContent = text;
    statusDot.className = 'cb-dot' + (kind ? ' is-' + kind : '');
    statusBox.classList.toggle('is-bad', kind === 'bad');
  }

  function setPill(text, kind) {
    const el = $('devicePillText');
    el.textContent = text;
    /* The pill truncates a long TV name rather than shoving the page
       sideways, so the full name has to stay reachable somewhere. */
    el.title = text;
    $('devicePillDot').className = 'cb-dot' + (kind ? ' is-' + kind : '');
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
        setStatus('This stream won\'t open in a browser tab — the server blocks it. The TV can still fetch it directly.', 'bad');
        toast({
          text: 'Blocked here, but Cast and VLC fetch it themselves.',
          actionLabel: 'Open in VLC',
          onAction: handoffVlc
        });
      } else {
        setStatus('Stream error: ' + data.details, 'bad');
      }
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
  function streamUrl(u) {
    var out = '/api/stream?u=' + encodeURIComponent(u);
    if (currentFrom && /^https?:/i.test(currentFrom)) {
      out += '&r=' + encodeURIComponent(currentFrom);
    }
    return out;
  }

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
    hlsProxied = false;
    $('url').value = u;

    teardownHls();
    screenEl.classList.remove('is-idle');
    screenEl.classList.add('is-live');

    if (mimeOf(u) === 'application/x-mpegURL' && window.Hls && window.Hls.isSupported()) {
      playHls(u);
    } else {
      video.src = u;
    }

    var record = store.touch(u, { title: currentTitle, from: meta.from || '' });
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
      castLoad(u);
    } else {
      video.play().catch(function () { /* autoplay policy — the controls are right there */ });
    }
    return true;
  }

  qualitySel.addEventListener('change', function () {
    if (hls) hls.currentLevel = parseInt(qualitySel.value, 10);
  });

  video.addEventListener('error', function () {
    if (!current) return;
    setStatus('This link won\'t play here. It has to be the media file itself, not a webpage.', 'bad');
    toast({
      text: 'Nothing played. Try scanning the page it came from.',
      actionLabel: 'Browse',
      onAction: function () { showTab('browse', { focus: true }); }
    });
  });

  /* Position tracking — throttled, plus the moments a phone actually leaves. */
  video.addEventListener('timeupdate', function () {
    if (!current) return;
    var now = Date.now();
    if (now - lastSaved < 5000) return;
    lastSaved = now;
    store.progress(current, video.currentTime, video.duration);
  });

  function flushProgress() {
    if (!current) return;
    store.progress(current, video.currentTime, video.duration);
  }
  video.addEventListener('pause', flushProgress);
  video.addEventListener('ended', function () {
    if (current) store.progress(current, 0, video.duration);
  });
  window.addEventListener('pagehide', flushProgress);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushProgress();
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
    setPill('no cast', '');

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
    var ctx = window.cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    ctx.addEventListener(window.cast.framework.CastContextEventType.CAST_STATE_CHANGED, function (e) {
      castState = e.castState;
      updateCastUi();
    });
    ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function (e) {
      if (e.sessionState === window.cast.framework.SessionState.SESSION_STARTED && current) {
        video.pause();
        castLoad(current);
      }
      if (e.sessionState === window.cast.framework.SessionState.SESSION_ENDED) {
        screenEl.classList.remove('is-onair');
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

    /* Cast's own media documentation requires HLS and DASH to be served
       cross-origin-open, and a CDN that never expected a television is not.
       So an adaptive stream goes through our origin from the start rather
       than failing once and being retried — a direct attempt here is a
       spinner on the TV, not a fast path. A progressive mp4 has no such
       requirement, so that one is tried direct and only proxied if the
       receiver comes back unhappy. */
    var src = adaptive || opts.viaProxy ? streamUrl(u) : u;

    var info = new M.MediaInfo(src, mime);
    info.streamType = M.StreamType.BUFFERED;
    if (mime === 'application/x-mpegURL') {
      info.hlsSegmentFormat = M.HlsSegmentFormat.TS;
      info.hlsVideoSegmentFormat = M.HlsVideoSegmentFormat.MPEG2_TS;
    }
    info.metadata = new M.GenericMediaMetadata();
    info.metadata.title = currentTitle || nameOf(u);

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
    s.loadMedia(req).then(function () {
      setStatus('Playing on ' + name + '.', 'live');
      $('onairTitle').textContent = 'Playing on ' + name;
      $('onairSub').textContent = currentTitle || nameOf(u);
      screenEl.classList.add('is-onair');
    }, function (err) {
      /* A receiver that refuses a direct address is usually being refused
         itself — the host wants the page the media was embedded in. Give it
         one go through our origin before saying it cannot be played. */
      if (!opts.viaProxy && src === u) {
        setStatus('The host blocked ' + name + ' — routing it through the bridge.', '');
        castLoad(u, { at: at, viaProxy: true });
        return;
      }
      screenEl.classList.remove('is-onair');
      setStatus(name + ' couldn\'t play it (' + ((err && err.code) || 'error') + '). It needs a public https .mp4 or .m3u8 link.', 'bad');
    });
  }

  function updateCastUi() {
    var btn = $('btnCast');
    /* Settled: this browser cannot cast, and the button is now the way out
       of that rather than a casualty of it. Leave it alone. */
    if (castImpossible) { offerChromeHandoff(); return; }
    if (!window.cast || !window.cast.framework) { btn.disabled = true; return; }

    var map = {
      NO_DEVICES_AVAILABLE: ['No cast devices on this Wi‑Fi.', '', true, 'no devices', ''],
      NOT_CONNECTED: ['A cast device is ready — tap Cast to TV.', 'ready', false, 'device ready', 'ready'],
      CONNECTING: ['Connecting…', 'ready', true, 'connecting', 'ready'],
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
  }

  $('btnCast').addEventListener('click', function () {
    if (castImpossible) { handOffToChrome(); return; }
    if (!window.cast || !window.cast.framework) return;
    if (castState === 'CONNECTED') {
      if (current) castLoad(current);
      else toast({ text: 'Connected — now pick something to play.' });
      return;
    }
    window.cast.framework.CastContext.getInstance().requestSession().catch(function () {});
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
      window.cast.framework.RemotePlayerEventType.ANY_CHANGE, syncRemote);

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
      if (remotePlayer && remotePlayer.isMediaLoaded) remoteCtl.playOrPause();
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
    $('rStop').addEventListener('click', function () {
      if (!remoteCtl) return;
      remoteCtl.stop();
      var s = castSession();
      if (s) s.endSession(true);
      screenEl.classList.remove('is-onair');
      toast({ text: 'Stopped. Tap Cast to TV to send it back.' });
    });
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

    var loaded = !!remotePlayer.isMediaLoaded && castState === 'CONNECTED';
    remoteEl.hidden = !loaded;
    if (!loaded) return;

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
    btn.classList.add('is-busy');
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
      btn.classList.remove('is-busy');
      btn.disabled = false;
    }
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
    btnRemote.addEventListener('click', function () {
      if (!current) { toast({ text: 'Load something first, then AirPlay it.' }); return; }
      video.webkitShowPlaybackTargetPicker();
    });
  }

  /* ------------------------------------------------------------------ *
   * Hand-off — VLC and clipboard
   * ------------------------------------------------------------------ */

  function handoffVlc() {
    if (!current) return;
    var ua = navigator.userAgent;
    if (/android/i.test(ua)) {
      var u = new URL(current);
      window.location.href = 'intent://' + u.host + u.pathname + u.search +
        '#Intent;scheme=' + u.protocol.replace(':', '') +
        ';package=org.videolan.vlc;type=' + encodeURIComponent(mimeOf(current)) +
        ';S.title=' + encodeURIComponent(currentTitle || nameOf(current)) + ';end';
    } else if (/iphone|ipad|ipod/i.test(ua)) {
      window.location.href = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(current);
    } else {
      window.location.href = 'vlc://' + current;
    }
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
    busy(btn, true);
    fieldError($('url'), $('urlError'), null);

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
            from: body.direct ? '' : body.finalUrl
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
    busy(btn, true);

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
    var adminTab = $('tab-users');
    if (adminTab) adminTab.hidden = !isOwner();
    var allToggle = $('histScopeRow');
    if (allToggle) allToggle.hidden = !isOwner();

    /* Revealing People re-flexes the strip. The observer would catch it a
       frame later; a frame of the pill on the wrong tab is the whole bug. */
    moveIndicator();
  }

  /* A 401 from anywhere means the session lapsed while the tab sat open.
     Put the door back rather than letting the next tap fail silently. */
  function handleAuthLapse() {
    signedIn = false;
    me = null;
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
    busy(btn, true);
    fieldError($('pageUrl'), $('pageError'), null);
    $('browseHint').hidden = true;
    $('browseResult').innerHTML = '<div class="cb-empty"><p>Reading the page…</p></div>';

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
    busy(btn, true);
    $('browseResult').innerHTML =
      '<div class="cb-empty"><p>Opening the page in a browser and watching what it loads…</p>' +
      '<p class="cb-deepnote">This takes a few seconds longer than the quick scan.</p></div>';

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
          return;
        }
        renderScan(res.body);
      })
      .catch(function () {
        $('browseResult').innerHTML = '';
        renderBrowseError('No connection to the scanner.', false);
      })
      .then(function () {
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
      var list = document.createElement('div');
      list.className = 'cb-list list-group';
      data.media.forEach(function (m) {
        list.appendChild(mediaRow(m, data));
      });
      wrap.appendChild(list);
    }

    wrap.appendChild(previewBlock(data.finalUrl));
  }

  function mediaRow(m, page) {
    var row = document.createElement('div');
    row.className = 'list-group-item';

    var body = document.createElement('div');
    body.className = 'cb-item-body';

    var title = document.createElement('span');
    title.className = 'cb-item-title';
    title.textContent = m.label || nameOf(m.url);
    title.title = m.url;
    body.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'cb-item-meta';
    var badge = document.createElement('span');
    badge.className = 'badge badge-secondary';
    badge.textContent = m.kind || kindOf(m.url);
    meta.appendChild(badge);
    var detail = document.createElement('span');
    detail.textContent = m.detail || hostOf(m.url);
    meta.appendChild(detail);
    body.appendChild(meta);

    row.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'cb-item-actions';

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn-secondary btn-sm';
    play.textContent = 'Play';
    play.addEventListener('click', function () {
      load(m.url, { title: m.label || page.title || nameOf(m.url), from: page.finalUrl });
      showTab('link');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    actions.appendChild(play);

    row.appendChild(actions);
    return row;
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
    scan($('pageUrl').value);
  });
  $('pageUrl').addEventListener('input', function () {
    fieldError($('pageUrl'), $('pageError'), null);
  });

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
      load(it.url, { title: it.title, from: it.from });
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
      toast({
        text: 'Removed “' + (gone.item.title || nameOf(gone.item.url)) + '”.',
        actionLabel: 'Undo',
        onAction: function () {
          store.insertAt(gone.item, gone.at);
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
    renderHistory();
    toast({
      text: n + (n === 1 ? ' entry cleared.' : ' entries cleared.'),
      actionLabel: 'Undo',
      onAction: function () {
        store.restore(snapshot);
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
  requestAnimationFrame(moveIndicator);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveIndicator);

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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(function (reg) {
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
      .catch(function () {});

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
      adding = true;
      busy(btn, true);
      fieldError(null, $('userError'), null);

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
  function reloadShell() {
    var updated = Promise.resolve();
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistration) {
      updated = navigator.serviceWorker.getRegistration()
        .then(function (reg) {
          if (!reg) return null;
          return reg.update().then(function () {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          });
        })
        .catch(function () {});
    }
    var cap = new Promise(function (r) { setTimeout(r, 1500); });
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
      var work = gated
        ? reloadShell()
        : Promise.all([refreshHistory(), isOwner() ? renderUsers() : null]);

      /* A refresh that resolves in 40ms reads as a broken button, so hold
         the ring long enough to be seen finishing. */
      var floor = new Promise(function (r) { setTimeout(r, 480); });

      Promise.all([work, floor])
        .catch(function () {})
        .then(function () {
          if (gated) return;          // the page is on its way out
          running = false;
          ind.classList.remove('is-running', 'is-armed');
          settle();
          toast({ text: 'Up to date.' });
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
