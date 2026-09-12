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
    if (on) {
      hideHud();
      drawPaired();
    }
  }

  /* On the idle screen of a TV that already has a phone: the code steps back
     and the way to disconnect that phone comes forward, focused, so one
     press of OK does it. */
  function drawPaired() {
    var btn = $('release');
    btn.hidden = !paired;
    $('pair').className = 'tv-pair' + (paired ? ' is-paired' : '');
    if (paired && !$('pair').hidden && document.activeElement !== btn) {
      try { btn.focus(); } catch (e) {}
    }
  }

  $('release').addEventListener('click', function () {
    if (!room) return;
    var btn = $('release');
    btn.disabled = true;
    api({ action: 'release', code: room.code, tvKey: room.tvKey }).then(function () {
      paired = false;
      drawPaired();
      line('Phone disconnected. Enter the code on a phone to connect again.', 'ok');
    }, function () {
      line('Couldn’t reach Cast Bridge. Try again.', 'bad');
    }).then(function () { btn.disabled = false; });
  });

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
          showHud(true);
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
    showHud(true);
  }

  video.addEventListener('error', function () {
    if (hls || dash) return;  // those report their own
    var e = video.error;
    fail('The TV could not play it' + (e ? ' (media error ' + e.code + ')' : ''));
  });
  ['playing', 'pause', 'waiting', 'seeked'].forEach(function (ev) {
    video.addEventListener(ev, function () {
      drawKeys();
      if (video.paused || ev === 'waiting') showHud(); else poke();
    });
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
        showHud();
        break;
      case 'play': if (loaded) play(); break;
      case 'pause': if (loaded) video.pause(); break;
      case 'seek': if (loaded) { try { video.currentTime = c.to; } catch (e) {} showHud(); } break;
      case 'skip': if (loaded) { skip(c.by); } break;
      case 'stop':
        loaded = null;
        teardown();
        $('start').hidden = true;
        showPairing(true);
        exitFullscreen();
        line('Stopped. Pick another film on your phone.', 'ok');
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
          if (!loaded) line(paired ? 'Phone connected. Pick a film on it.' : 'Waiting for your phone…', paired ? 'ok' : '');
          drawPaired();
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
   * On-screen controls and the TV remote
   *
   * Rj: "need fullscreen, pause, play etc in the browser on the TV". The bar
   * over the film used to be a picture of controls: title, time, a progress
   * line, pointer-events off. It is real now, and built for a D-pad, which is
   * all a TV remote is:
   *
   *   hidden   OK / up / down  show the bar, focus on play-pause
   *            left / right    skip 10 seconds (and show the bar)
   *   shown    left / right    move between buttons; on the bar, seek 10s
   *            up / down       between the progress bar and the buttons
   *            OK              press the focused control
   *            Back            hide the bar
   *
   * Media keys (play, pause, fast-forward, rewind, stop) work either way.
   * A pointer (Samsung's Smart Remote, TV Bro's cursor) can simply click.
   * The bar hides itself five seconds after the last press while playing.
   * ---------------------------------------------------------------- */

  var STATE_TEXT = {
    loading: 'Loading…',
    buffering: 'Buffering…',
    paused: 'Paused',
    playing: 'Playing',
    ended: 'Finished',
    blocked: 'Press OK on the TV remote to start'
  };
  var HIDE_MS = 5000;
  var KEYS = ['kBack', 'kPlay', 'kFwd', 'kFull', 'kStop'];
  var hudEl = $('hud');
  var seekEl = $('hudSeek');

  function drawHud() {
    var d = video.duration;
    var pos = video.currentTime || 0;
    var known = isFinite(d) && d > 0;
    $('hudPos').textContent = clock(pos);
    $('hudDur').textContent = known ? clock(d) : '--:--';
    $('hudBar').style.width = known ? Math.min(100, pos / d * 100) + '%' : '0';
    seekEl.setAttribute('aria-valuenow', String(Math.floor(pos)));
    seekEl.setAttribute('aria-valuetext', clock(pos) + (known ? ' of ' + clock(d) : ''));
    var s = state();
    $('hudState').textContent = s === 'error' ? lastError : (STATE_TEXT[s] || '');
  }

  function drawKeys() {
    var playing = loaded && !video.paused;
    var k = $('kPlay');
    k.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('icoPlay').style.display = playing ? 'none' : '';
    $('icoPause').style.display = playing ? '' : 'none';
    $('kPlayText').textContent = playing ? 'Pause' : 'Play';
    var fs = !!fullscreenElement();
    $('kFullText').textContent = fs ? 'Exit full screen' : 'Full screen';
    $('kFull').hidden = !canFullscreen();
  }

  function hudShown() { return /\bis-on\b/.test(hudEl.className); }

  function inHud(el) {
    while (el) { if (el === hudEl) return true; el = el.parentNode; }
    return false;
  }

  /* Show, and keep it up while nothing is playing. */
  function showHud(focusPlay) {
    drawHud();
    drawKeys();
    hudEl.className = 'tv-hud is-on';
    if (focusPlay || !inHud(document.activeElement)) {
      try { $('kPlay').focus(); } catch (e) {}
    }
    poke();
  }

  function hideHud() {
    clearTimeout(hudTimer);
    hudEl.className = 'tv-hud';
    if (inHud(document.activeElement)) {
      try { document.activeElement.blur(); } catch (e) {}
    }
  }

  /* Every press restarts the countdown; it only runs while playing. */
  function poke() {
    clearTimeout(hudTimer);
    if (!hudShown()) return;
    if (state() === 'playing') hudTimer = setTimeout(hideHud, HIDE_MS);
  }

  function skip(by) {
    if (!loaded) return;
    try { video.currentTime = Math.max(0, (video.currentTime || 0) + by); } catch (e) {}
    showHud();
  }

  function toggle() {
    if (!loaded) return;
    if (video.paused) play(); else video.pause();
    showHud();
  }

  function stopHere() {
    run({ type: 'stop' });
  }

  /* Full screen. Webkit prefixes for the older Chromium in Tizen, and the
     button disappears where the browser has no full-screen API at all. */
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function canFullscreen() {
    var d = document.documentElement;
    return !!(d.requestFullscreen || d.webkitRequestFullscreen);
  }
  function exitFullscreen() {
    if (!fullscreenElement()) return;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    try { var p = exit.call(document); if (p && p['catch']) p['catch'](function () {}); } catch (e) {}
  }
  function toggleFullscreen() {
    if (fullscreenElement()) { exitFullscreen(); return; }
    var d = document.documentElement;
    var req = d.requestFullscreen || d.webkitRequestFullscreen;
    if (!req) return;
    try {
      var p = req.call(d);
      if (p && p['catch']) {
        p['catch'](function () {
          $('hudState').textContent = 'This TV browser won’t go full screen. Use its own menu for full screen.';
        });
      }
    } catch (e) { /* no gesture, or refused */ }
  }
  document.addEventListener('fullscreenchange', drawKeys);
  document.addEventListener('webkitfullscreenchange', drawKeys);

  $('start').addEventListener('click', function () {
    $('start').hidden = true;
    play();
  });

  $('kBack').addEventListener('click', function () { skip(-10); });
  $('kFwd').addEventListener('click', function () { skip(10); });
  $('kPlay').addEventListener('click', toggle);
  $('kFull').addEventListener('click', function () { toggleFullscreen(); showHud(); });
  $('kStop').addEventListener('click', stopHere);

  /* A click on the progress bar seeks to that spot. */
  seekEl.addEventListener('click', function (e) {
    var d = video.duration;
    if (!loaded || !isFinite(d) || d <= 0) return;
    var r = seekEl.getBoundingClientRect();
    var f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    try { video.currentTime = f * d; } catch (x) {}
    showHud();
  });

  /* A pointer moving over the film shows the bar; a click on the film
     shows or hides it. */
  document.addEventListener('mousemove', function () { if (loaded) showHud(); });
  video.addEventListener('click', function () {
    if (!loaded) return;
    if (hudShown()) hideHud(); else showHud(true);
  });

  function moveFocus(step) {
    var visible = [];
    for (var i = 0; i < KEYS.length; i++) if (!$(KEYS[i]).hidden) visible.push(KEYS[i]);
    var at = -1;
    for (var j = 0; j < visible.length; j++) if (document.activeElement === $(visible[j])) at = j;
    var next = at === -1 ? visible.indexOf('kPlay') : Math.max(0, Math.min(visible.length - 1, at + step));
    try { $(visible[next]).focus(); } catch (e) {}
  }

  /* `key` for browsers that report it; keyCode for the older ones and for
     Tizen's media keys (10252 play-pause, 415 play, 19 pause, 413 stop,
     417 fast-forward, 412 rewind, 10009 return). */
  document.addEventListener('keydown', function (e) {
    var k = e.key, c = e.keyCode;
    if (!loaded) return;  // the idle screen is plain buttons; the browser moves focus
    if (!$('start').hidden && document.activeElement === $('start')) return;

    var left = k === 'ArrowLeft' || k === 'Left' || c === 37;
    var right = k === 'ArrowRight' || k === 'Right' || c === 39;
    var up = k === 'ArrowUp' || k === 'Up' || c === 38;
    var down = k === 'ArrowDown' || k === 'Down' || c === 40;
    var ok = k === 'Enter' || c === 13 || c === 29443;
    var back = k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || c === 10009 || c === 461 || c === 27;
    var handled = true;

    if (k === 'MediaPlayPause' || c === 10252 || c === 179) toggle();
    else if (k === 'MediaPlay' || c === 415) { play(); showHud(); }
    else if (k === 'MediaPause' || c === 19) { video.pause(); showHud(); }
    else if (k === 'MediaStop' || c === 413) stopHere();
    else if (k === 'MediaFastForward' || c === 417) skip(10);
    else if (k === 'MediaRewind' || c === 412) skip(-10);
    else if (!hudShown()) {
      if (left) skip(-10);
      else if (right) skip(10);
      else if (ok || up || down || k === ' ') showHud(true);
      else if (back && fullscreenElement()) exitFullscreen();
      else handled = false;
    } else {
      var el = document.activeElement;
      poke();
      if (back) hideHud();
      else if (el === seekEl) {
        if (left) skip(-10);
        else if (right) skip(10);
        else if (down) moveFocus(0);
        else if (ok) toggle();
        else handled = false;
      } else if (inHud(el)) {
        if (left) moveFocus(-1);
        else if (right) moveFocus(1);
        else if (up) { try { seekEl.focus(); } catch (x) {} }
        else if (down) { /* already on the bottom row */ }
        else handled = false;  // OK presses the focused button itself
      } else if (left || right || up || down || ok) {
        showHud(true);
      } else {
        handled = false;
      }
    }
    if (handled) e.preventDefault();
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
