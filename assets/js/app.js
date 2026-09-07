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

  var MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;

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
    if (/\.ogg$/.test(p)) return 'video/ogg';
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

  var TABS = ['link', 'browse', 'history'];
  var activeTab = 'link';
  var scrollMemory = {};

  function moveIndicator() {
    var btn = $('tab-' + activeTab);
    var ind = $('tabIndicator');
    if (!btn || !ind) return;
    ind.style.width = btn.offsetWidth + 'px';
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
  var hls = null;
  var castState = 'NO_DEVICES_AVAILABLE';
  var lastSaved = 0;

  function setStatus(text, kind) {
    statusText.textContent = text;
    statusDot.className = 'cb-dot' + (kind ? ' is-' + kind : '');
    statusBox.classList.toggle('is-bad', kind === 'bad');
  }

  function setPill(text, kind) {
    $('devicePillText').textContent = text;
    $('devicePillDot').className = 'cb-dot' + (kind ? ' is-' + kind : '');
  }

  function teardownHls() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    qualitySel.hidden = true;
    qualitySel.innerHTML = '<option value="-1">Auto</option>';
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
    $('url').value = u;

    teardownHls();
    screenEl.classList.remove('is-idle');
    screenEl.classList.add('is-live');

    if (mimeOf(u) === 'application/x-mpegURL' && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        startLevel: -1, capLevelToPlayerSize: false,
        maxBufferLength: 60, maxMaxBufferLength: 120, backBufferLength: 30,
        abrEwmaDefaultEstimate: 5e6, lowLatencyMode: false
      });
      hls.loadSource(u);
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
    } else {
      video.src = u;
    }

    var record = store.touch(u, { title: currentTitle, from: meta.from || '' });
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

  window.__onGCastApiAvailable = function (ok) {
    if (ok) { initCast(); return; }
    setPill('no cast', '');
    setStatus('Casting needs Chrome — on Android, or Chrome on a computer.', '');
  };

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

  function castLoad(u) {
    var s = castSession();
    if (!s) return;
    var info = new window.chrome.cast.media.MediaInfo(u, mimeOf(u));
    info.streamType = window.chrome.cast.media.StreamType.BUFFERED;
    if (mimeOf(u) === 'application/x-mpegURL') {
      info.hlsSegmentFormat = window.chrome.cast.media.HlsSegmentFormat.TS;
      info.hlsVideoSegmentFormat = window.chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS;
    }
    info.metadata = new window.chrome.cast.media.GenericMediaMetadata();
    info.metadata.title = currentTitle || nameOf(u);

    var req = new window.chrome.cast.media.LoadRequest(info);
    req.currentTime = video.currentTime || 0;

    var name = deviceName();
    s.loadMedia(req).then(function () {
      setStatus('Playing on ' + name + '.', 'live');
      $('onairTitle').textContent = 'Playing on ' + name;
      $('onairSub').textContent = currentTitle || nameOf(u);
      screenEl.classList.add('is-onair');
    }, function (err) {
      screenEl.classList.remove('is-onair');
      setStatus(name + ' couldn\'t play it (' + ((err && err.code) || 'error') + '). It needs a public https .mp4 or .m3u8 link.', 'bad');
    });
  }

  function updateCastUi() {
    var btn = $('btnCast');
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
    if (!window.cast || !window.cast.framework) return;
    if (castState === 'CONNECTED') {
      if (current) castLoad(current);
      else toast({ text: 'Connected — now pick something to play.' });
      return;
    }
    window.cast.framework.CastContext.getInstance().requestSession().catch(function () {});
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
  $('linkForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (playInFlight) return;

    var walled = walledName($('url').value);
    if (walled) {
      fieldError($('url'), $('urlError'),
        walled === 'YouTube'
          ? 'YouTube has its own cast button — open it in the YouTube app and cast from there. It reaches the TV directly.'
          : walled + ' encrypts its video with DRM, so there is no address on it a TV can play. Use the ' + walled + ' app on the TV instead.');
      return;
    }

    var btn = $('btnPlay');
    playInFlight = true;
    busy(btn, true);

    var ok = load($('url').value);
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

  function showGate(message) {
    var gate = $('gate');
    if (!gate) return;
    gate.hidden = false;
    sealShell(true);
    document.body.classList.add('is-gated');
    if (message) fieldError($('gatePw'), $('gateError'), message, null);
    var pw = $('gatePw');
    if (pw) { try { pw.focus(); } catch (e) { /* not focusable yet */ } }
  }

  function hideGate() {
    var gate = $('gate');
    if (!gate) return;
    gate.hidden = true;
    sealShell(false);
    document.body.classList.remove('is-gated');
    signedIn = true;
    var out = $('btnSignOut');
    if (out) out.hidden = false;
  }

  /* A 401 from anywhere means the session lapsed while the tab sat open.
     Put the door back rather than letting the next tap fail silently. */
  function handleAuthLapse() {
    signedIn = false;
    var out = $('btnSignOut');
    if (out) out.hidden = true;
    showGate('That session expired. Sign in again.');
  }

  function wireGate() {
    var form = $('gateForm');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = $('gatePw');
      var btn = $('gateBtn');
      var value = pw ? pw.value : '';

      if (!value) {
        fieldError(pw, $('gateError'), 'Enter the password.', null);
        return;
      }

      fieldError(pw, $('gateError'), null);
      busy(btn, true);

      fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: value })
      })
        .then(function (r) {
          return r.json().then(function (body) { return { status: r.status, body: body }; });
        })
        .then(function (res) {
          if (res.body && res.body.ok) {
            pw.value = '';
            hideGate();
            toast({ text: 'Signed in.' });
            return;
          }
          fieldError(pw, $('gateError'),
            (res.body && res.body.error) || 'That password is wrong.', null);
        })
        .catch(function () {
          fieldError(pw, $('gateError'), 'No connection to the sign-in service.', null);
        })
        .then(function () { busy(btn, false); });
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
        if (body && body.signedIn) { hideGate(); return; }
        if (body && body.configured === false) {
          showGate('No password is set for this app yet. Add CAST_PASSWORD in the project settings.');
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

  /* The door goes up before anything else is usable. */
  wireGate();
  checkSession();
})();
