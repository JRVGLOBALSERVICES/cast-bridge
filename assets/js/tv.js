/* TV mode — the television's side.
 *
 * This page runs in the browser ON the television. It shows a pairing code,
 * then plays whatever the paired phone sends and reports back what it is
 * doing. Because the TV fetches the film itself, nothing the phone does
 * afterwards — Instagram, a call, locking it — can take the film away. That
 * is the whole reason this exists: AirPlay from an iPhone cannot promise it.
 *
 * Written in ES5 on purpose. A Samsung TV's built-in browser runs an old
 * Chromium, and a syntax error in a page with no devtools is a black screen
 * nobody can diagnose from a sofa.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var STORE = 'cb-tv-room';
  var POLL_MS = 1000;

  var room = null;          // { code, tvKey }
  var since = 0;            // last command seq run
  var paired = false;
  var hls = null;
  var dash = null;
  var loaded = null;        // the load command now on screen
  var triedFallback = false;
  var lastError = '';
  var blocked = false;
  var failures = 0;
  var hudTimer = null;

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
  }

  function line(text, tone) {
    var el = $('line');
    el.textContent = text;
    el.className = 'tv-line' + (tone ? ' is-' + tone : '');
  }

  function api(body) {
    return fetch('/api/tv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    }).then(function (r) {
      return r.json().then(function (j) { j.httpStatus = r.status; return j; }, function () {
        return { ok: false, httpStatus: r.status, error: 'HTTP ' + r.status };
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Pairing screen
   * ---------------------------------------------------------------- */

  function showCode(code) {
    var el = $('code');
    el.innerHTML = '';
    for (var i = 0; i < code.length; i++) {
      var s = document.createElement('span');
      s.textContent = code.charAt(i);
      if (i === 3) s.className = 'tv-gap';
      el.appendChild(s);
    }
    el.setAttribute('aria-label', 'Pairing code ' + code.split('').join(' '));
    $('cornerCode').textContent = 'TV code ' + code;
    drawQr(location.origin + '/?tv=' + code);
  }

  function drawQr(text) {
    if (!window.CBQR) return;
    var q;
    try { q = window.CBQR.encode(text); } catch (e) { return; }
    var canvas = $('qr');
    var quiet = 2;
    var cells = q.size + quiet * 2;
    var px = Math.floor(canvas.width / cells);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0d0f1a';
    var off = Math.floor((canvas.width - px * cells) / 2) + quiet * px;
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size; x++) {
        if (q.modules[y * q.size + x]) ctx.fillRect(off + x * px, off + y * px, px, px);
      }
    }
    $('qrBox').hidden = false;
    $('qrNote').hidden = false;
  }

  function showPairing(on) {
    $('pair').hidden = !on;
    video.hidden = on;
  }

  function newRoom() {
    since = 0;
    paired = false;
    line('Getting a code…');
    return api({ action: 'create' }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'no code');
      room = { code: j.code, tvKey: j.tvKey };
      try { localStorage.setItem(STORE, JSON.stringify(room)); } catch (e) { /* private mode */ }
      showCode(room.code);
      line('Waiting for your phone…');
    });
  }

  function restore() {
    try {
      var r = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (r && /^[0-9]{6}$/.test(r.code) && r.tvKey) return r;
    } catch (e) { /* nothing stored */ }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Player
   * ---------------------------------------------------------------- */

  var SHAKA_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.16.8/shaka-player.compiled.js';
  var shakaReady = null;
  function loadShaka() {
    if (window.shaka) return Promise.resolve(window.shaka);
    if (shakaReady) return shakaReady;
    shakaReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SHAKA_SRC;
      s.onload = function () {
        if (!window.shaka) { reject(new Error('Shaka missing')); return; }
        window.shaka.polyfill.installAll();
        resolve(window.shaka);
      };
      s.onerror = function () { shakaReady = null; reject(new Error('The DASH player did not download')); };
      document.head.appendChild(s);
    });
    return shakaReady;
  }

  function teardown() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (dash) { try { dash.destroy(); } catch (e) {} dash = null; }
    var tracks = video.querySelectorAll('track');
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].src && tracks[i].src.indexOf('blob:') === 0) URL.revokeObjectURL(tracks[i].src);
      video.removeChild(tracks[i]);
    }
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}
  }

  function isHls(mime) { return /mpegurl/i.test(mime); }

  function start(at) {
    if (at > 0) {
      var seek = function () {
        video.removeEventListener('loadedmetadata', seek);
        try { video.currentTime = at; } catch (e) {}
      };
      if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek);
    }
    play();
  }

  /* A TV browser may refuse to start sound that no one pressed a button for.
     When it does, the film waits under a single focused button — one press
     of OK on the TV remote — and the phone is told why nothing is moving. */
  function play() {
    var p;
    try { p = video.play(); } catch (e) { p = null; }
    if (p && p.then) {
      p.then(function () {
        blocked = false;
        $('start').hidden = true;
      }, function (err) {
        if (err && err.name === 'NotAllowedError') {
          blocked = true;
          $('start').hidden = false;
          $('start').focus();
          hud(true);
        }
      });
    }
  }

  function attach(url, mime, at) {
    teardown();
    lastError = '';
    if (isHls(mime) && !video.canPlayType('application/vnd.apple.mpegurl') &&
        window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true, startPosition: at > 0 ? at : -1 });
      hls.on(window.Hls.Events.ERROR, function (_, data) {
        if (data && data.fatal) fail('Stream error (' + data.details + ')');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { play(); });
      return;
    }
    if (/dash/i.test(mime)) {
      loadShaka().then(function (shaka) {
        if (!shaka.Player.isBrowserSupported()) { fail('This TV browser cannot play this kind of stream.'); return; }
        var player = new shaka.Player();
        dash = player;
        player.configure({ streaming: { bufferingGoal: 60, rebufferingGoal: 4 } });
        player.addEventListener('error', function (ev) {
          var e = ev && ev.detail;
          fail('Stream error (shaka ' + (e ? e.code : '?') + ')');
        });
        return player.attach(video).then(function () {
          return player.load(url, at > 0 ? at : null, 'application/dash+xml');
        }).then(function () {
          if (dash === player) play();
        });
      }).catch(function (e) {
        fail((e && e.code) ? 'Stream error (shaka ' + e.code + ')' : String(e && e.message || e));
      });
      return;
    }
    video.src = url;
    start(at);
  }

  function attachSubs(src, name) {
    if (!src) return;
    /* Fetched and handed over as a blob so a subtitle file on another origin
       needs no crossorigin attribute on the <video> — which would make every
       direct film address that does not answer CORS refuse to play. */
    fetch(src).then(function (r) { return r.ok ? r.text() : ''; }).then(function (vtt) {
      if (!vtt || !loaded || loaded.subs !== src) return;
      var t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = name || 'Subtitles';
      t.srclang = 'en';
      t['default'] = true;
      t.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      video.appendChild(t);
      try { t.track.mode = 'showing'; } catch (e) {}
    }).catch(function () { /* the film still plays without them */ });
  }

  function fail(msg) {
    /* Refused direct: a host that wants its own page as the referer. Once
       through the bridge before calling it — the same retry the Chromecast
       path makes. */
    if (loaded && loaded.fallback && !triedFallback) {
      triedFallback = true;
      var at = video.currentTime || loaded.at || 0;
      attach(loaded.fallback, loaded.mime, at);
      return;
    }
    lastError = msg;
    hud(true);
  }

  video.addEventListener('error', function () {
    if (hls || dash) return;  // those report their own
    var e = video.error;
    fail('The TV could not play it' + (e ? ' (media error ' + e.code + ')' : ''));
  });
  ['playing', 'pause', 'waiting', 'seeked'].forEach(function (ev) {
    video.addEventListener(ev, function () { hud(video.paused || ev === 'waiting'); });
  });
  video.addEventListener('timeupdate', drawHud);

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  function run(c) {
    switch (c.type) {
      case 'load':
        loaded = c;
        triedFallback = false;
        blocked = false;
        $('start').hidden = true;
        showPairing(false);
        $('hudTitle').textContent = c.title || 'Now playing';
        attach(c.url, c.mime, c.at || 0);
        attachSubs(c.subs, c.subsName);
        hud(true);
        break;
      case 'play': if (loaded) play(); break;
      case 'pause': if (loaded) video.pause(); break;
      case 'seek': if (loaded) { try { video.currentTime = c.to; } catch (e) {} hud(true); } break;
      case 'skip': if (loaded) { try { video.currentTime = Math.max(0, video.currentTime + c.by); } catch (e) {} hud(true); } break;
      case 'stop':
        loaded = null;
        teardown();
        hud(false);
        $('start').hidden = true;
        showPairing(true);
        line('Stopped. Play something on your phone.', 'ok');
        break;
    }
  }

  function state() {
    if (!loaded) return 'idle';
    if (lastError) return 'error';
    if (blocked) return 'blocked';
    if (video.ended) return 'ended';
    if (video.readyState < 3 && !video.paused) return video.currentTime > 0 ? 'buffering' : 'loading';
    if (video.readyState < 1) return 'loading';
    return video.paused ? 'paused' : 'playing';
  }

  function report() {
    var d = video.duration;
    return {
      state: state(),
      position: loaded ? video.currentTime || 0 : 0,
      duration: loaded && isFinite(d) ? d : 0,
      title: loaded ? loaded.title : null,
      error: lastError || null,
      seq: since
    };
  }

  function tick() {
    if (!room) return;
    api({ action: 'poll', code: room.code, tvKey: room.tvKey, since: since, status: report() })
      .then(function (j) {
        if (j.gone) {
          try { localStorage.removeItem(STORE); } catch (e) {}
          room = null;
          return newRoom();
        }
        if (!j.ok) throw new Error(j.error || 'poll failed');
        failures = 0;
        if (j.paired !== paired) {
          paired = j.paired;
          if (!loaded) line(paired ? 'Phone paired. Play something on it.' : 'Waiting for your phone…', paired ? 'ok' : '');
        }
        /* A seq that went backwards means the room was made again elsewhere.
           Start from its beginning rather than ignoring every command. */
        if (j.seq < since) since = 0;
        for (var i = 0; i < j.commands.length; i++) {
          var c = j.commands[i];
          if (c.seq <= since) continue;
          since = c.seq;
          try { run(c); } catch (e) { lastError = String(e && e.message || e); }
        }
      })
      .catch(function () {
        failures++;
        if (!loaded && failures > 2) line('Can’t reach Cast Bridge. Check the TV’s internet.', 'bad');
      })
      .then(function () {
        /* Back off while unreachable, so a dropped connection is not a
           request a second for an hour. */
        setTimeout(tick, failures ? Math.min(15000, POLL_MS * Math.pow(2, failures)) : POLL_MS);
      });
  }

  /* ---------------------------------------------------------------- *
   * HUD and the TV remote
   * ---------------------------------------------------------------- */

  var STATE_TEXT = {
    loading: 'Loading…',
    buffering: 'Buffering…',
    paused: 'Paused',
    playing: 'Playing',
    ended: 'Finished',
    blocked: 'Press OK on the TV remote to start'
  };

  function drawHud() {
    var d = video.duration;
    var pos = video.currentTime || 0;
    $('hudPos').textContent = clock(pos);
    $('hudDur').textContent = isFinite(d) && d > 0 ? clock(d) : '--:--';
    $('hudBar').style.width = isFinite(d) && d > 0 ? Math.min(100, pos / d * 100) + '%' : '0';
    var s = state();
    $('hudState').textContent = s === 'error' ? lastError : (STATE_TEXT[s] || '');
  }

  function hud(on) {
    drawHud();
    var el = $('hud');
    clearTimeout(hudTimer);
    if (on || state() !== 'playing') {
      el.className = 'tv-hud is-on';
      if (state() === 'playing') hudTimer = setTimeout(function () { el.className = 'tv-hud'; }, 4000);
    } else {
      el.className = 'tv-hud';
    }
  }

  $('start').addEventListener('click', function () {
    $('start').hidden = true;
    play();
  });

  /* The TV's own remote works too. Key codes cover a browser that reports
     `key` and older ones that only report keyCode (Tizen's media keys). */
  document.addEventListener('keydown', function (e) {
    if (!loaded) return;
    var k = e.key, c = e.keyCode;
    if (document.activeElement === $('start') && (k === 'Enter' || c === 13)) return;
    if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause' || c === 13 || c === 10252) {
      if (video.paused) play(); else video.pause();
    } else if (k === 'MediaPlay' || c === 415) {
      play();
    } else if (k === 'MediaPause' || c === 19) {
      video.pause();
    } else if (k === 'ArrowRight' || k === 'MediaFastForward' || c === 39 || c === 417) {
      try { video.currentTime = video.currentTime + 10; } catch (x) {}
    } else if (k === 'ArrowLeft' || k === 'MediaRewind' || c === 37 || c === 412) {
      try { video.currentTime = Math.max(0, video.currentTime - 10); } catch (x) {}
    } else {
      hud(true);
      return;
    }
    e.preventDefault();
    hud(true);
  });

  /* ---------------------------------------------------------------- */

  room = restore();
  if (room) {
    showCode(room.code);
    line('Waiting for your phone…');
    tick();
  } else {
    newRoom().then(tick, function () {
      line('Can’t reach Cast Bridge. Check the TV’s internet, then reload.', 'bad');
      setTimeout(function () { location.reload(); }, 15000);
    });
  }
}());
