/* TV mode — the phone's side: pairing, sending, and the remote.
 *
 * The television opens cast.jrvsystems.app/tv in its own browser and shows a
 * six-digit code. Entered here, the phone and that TV share a room on the
 * server. From then on a film opened on the phone is sent to the TV, the TV
 * fetches and plays it itself, and this panel is the remote.
 *
 * Why it exists: on an iPhone the only way to a TV from a web page is
 * AirPlay, and AirPlay sends the film FROM the phone. iOS hands that route to
 * whichever app played sound last, so Instagram takes the TV mid-film. A TV
 * that fetches the film itself cannot be taken from.
 *
 * The app's own state (what is loaded, its title, subtitles) lives inside
 * app.js. It hands over what the TV needs through window.CBApp, and asks this
 * module through window.CBTvMode whether a TV is paired.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var STORE = 'cb-tv-remote';
  var STATUS_MS = 2000;

  var remote = null;         // { code, phoneKey }
  var status = null;
  var online = false;
  var timer = null;
  var dragging = false;
  var pendingPlay = null;    // optimistic play/pause until the TV agrees

  var panel = $('tvMode');
  if (!panel) return;

  function clock(sec) {
    return window.CBResume ? window.CBResume.clock(sec) : String(Math.floor(sec || 0));
  }

  function api(body) {
    return fetch('/api/tv', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    }).then(function (r) {
      return r.json().then(function (j) { j.httpStatus = r.status; return j; }, function () {
        return { ok: false, httpStatus: r.status, error: 'Cast Bridge did not answer (' + r.status + ').' };
      });
    });
  }

  function save() {
    try {
      if (remote) localStorage.setItem(STORE, JSON.stringify(remote));
      else localStorage.removeItem(STORE);
    } catch (e) { /* private mode: paired for this visit only */ }
  }

  function restore() {
    try {
      var r = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (r && /^[0-9]{6}$/.test(r.code) && r.phoneKey) return r;
    } catch (e) { /* nothing stored */ }
    return null;
  }

  function spaced(code) { return code.slice(0, 3) + ' ' + code.slice(3); }

  /* ---------------------------------------------------------------- *
   * Pairing
   * ---------------------------------------------------------------- */

  var codeInput = $('tvCode');
  var pairBtn = $('tvPair');
  var pairErr = $('tvPairError');

  function pairError(text) {
    pairErr.textContent = text || '';
    pairErr.hidden = !text;
    codeInput.setAttribute('aria-invalid', text ? 'true' : 'false');
    if (text) {
      codeInput.classList.remove('is-shake');
      void codeInput.offsetWidth;
      codeInput.classList.add('is-shake');
    }
  }

  function digits() { return codeInput.value.replace(/\D/g, '').slice(0, 6); }

  codeInput.addEventListener('input', function () {
    var d = digits();
    if (codeInput.value !== d) codeInput.value = d;
    pairBtn.disabled = d.length !== 6;
    /* Once wrong, the field says so live until it is right — and a full,
       pasted code pairs without a second tap. */
    if (!pairErr.hidden) pairError('');
    if (d.length === 6 && codeInput.dataset.auto === '1') pair();
  });
  codeInput.addEventListener('paste', function () { codeInput.dataset.auto = '1'; });

  $('tvPairForm').addEventListener('submit', function (e) {
    e.preventDefault();
    pair();
  });

  function pair() {
    codeInput.dataset.auto = '';
    var code = digits();
    if (code.length !== 6 || pairBtn.classList.contains('is-busy')) return;
    pairBtn.classList.add('is-busy');
    pairBtn.disabled = true;
    pairError('');
    api({ action: 'pair', code: code }).then(function (j) {
      if (j.httpStatus === 401) throw new Error('Sign in to Cast Bridge first, then enter the code again.');
      if (!j.ok) throw new Error(j.error || 'That code did not work.');
      remote = { code: j.code, phoneKey: j.phoneKey };
      save();
      codeInput.value = '';
      render();
      poll();
      toast('Paired with the TV. Films you play now go to it.');
      /* Something already loaded: offer it straight away rather than making
         them find the film again. */
      var p = window.CBApp && window.CBApp.tvPayload && window.CBApp.tvPayload();
      if (p && !p.expired) sendCurrent();
    }).catch(function (e) {
      pairError(e.message || 'That code did not work.');
      codeInput.value = '';
      codeInput.focus();
    }).then(function () {
      pairBtn.classList.remove('is-busy');
      pairBtn.disabled = digits().length !== 6;
    });
  }

  function unpair(silent) {
    var r = remote;
    remote = null;
    status = null;
    save();
    stopPolling();
    render();
    if (r) api({ action: 'unpair', code: r.code, phoneKey: r.phoneKey }).catch(function () {});
    if (!silent) toast('Unpaired. Films play on this phone again.');
  }

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  function command(c) {
    if (!remote) return Promise.resolve(false);
    return api({ action: 'send', code: remote.code, phoneKey: remote.phoneKey, command: c })
      .then(function (j) {
        if (j.gone) { unpair(true); toast('The TV is no longer paired. Open /tv on the TV and pair again.'); return false; }
        if (!j.ok) { toast(j.error || 'The TV did not get that.'); return false; }
        setTimeout(poll, 700);
        return true;
      }, function () {
        toast('Could not reach Cast Bridge. Check the phone’s connection.');
        return false;
      });
  }

  function sendCurrent(at) {
    var app = window.CBApp;
    var p = app && app.tvPayload && app.tvPayload();
    if (!p) { toast('Open a film first, then send it to the TV.'); return; }
    if (p.expired) {
      /* The signed link has run out. Reading the page again reloads the
         film, and load() sends it here because a TV is paired. */
      toast('Refreshing the link, then sending it to the TV.');
      app.reread();
      return;
    }
    if (typeof at === 'number') p.at = at;
    app.pauseLocal();
    var btn = $('tvSend');
    btn.classList.add('is-busy');
    btn.disabled = true;
    command({
      type: 'load', url: p.url, fallback: p.fallback, mime: p.mime, title: p.title,
      at: p.at, subs: p.subs, subsName: p.subsName
    }).then(function (sent) {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      if (sent) {
        status = { state: 'loading', position: p.at || 0, duration: 0, title: p.title };
        render();
      }
    });
  }

  $('tvSend').addEventListener('click', function () { sendCurrent(); });
  $('tvUnpair').addEventListener('click', function () { unpair(false); });
  $('tvBack').addEventListener('click', function () { command({ type: 'skip', by: -10 }); });
  $('tvFwd').addEventListener('click', function () { command({ type: 'skip', by: 10 }); });
  $('tvStop').addEventListener('click', function () {
    command({ type: 'stop' });
    status = { state: 'idle' };
    render();
  });
  $('tvToggle').addEventListener('click', function () {
    var playing = isPlaying();
    pendingPlay = { playing: !playing, until: Date.now() + 4000 };
    render();
    command({ type: playing ? 'pause' : 'play' });
  });

  var scrub = $('tvScrub');
  scrub.addEventListener('input', function () {
    dragging = true;
    $('tvPos').textContent = clock(Number(scrub.value));
  });
  scrub.addEventListener('change', function () {
    dragging = false;
    command({ type: 'seek', to: Number(scrub.value) });
  });

  /* ---------------------------------------------------------------- *
   * Status
   * ---------------------------------------------------------------- */

  function poll() {
    if (!remote) return;
    clearTimeout(timer);
    api({ action: 'status', code: remote.code, phoneKey: remote.phoneKey }).then(function (j) {
      if (!remote) return;
      if (j.gone) { unpair(true); toast('The TV is no longer paired.'); return; }
      if (j.ok) {
        online = j.online;
        status = j.status;
        render();
      }
    }, function () { online = false; render(); }).then(schedule);
  }

  function schedule() {
    clearTimeout(timer);
    if (remote && document.visibilityState === 'visible') timer = setTimeout(poll, STATUS_MS);
  }

  function stopPolling() { clearTimeout(timer); timer = null; }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') poll(); else stopPolling();
  });

  function isPlaying() {
    if (pendingPlay && Date.now() < pendingPlay.until) return pendingPlay.playing;
    pendingPlay = null;
    return !!status && (status.state === 'playing' || status.state === 'buffering' || status.state === 'loading');
  }

  var STATE_TEXT = {
    idle: 'Nothing playing on the TV',
    loading: 'Loading on the TV…',
    buffering: 'Buffering on the TV…',
    playing: 'Playing on the TV',
    paused: 'Paused',
    ended: 'Finished',
    blocked: 'Press OK on the TV remote once to start it. TV browsers won’t start sound on their own.',
    error: 'The TV couldn’t play it'
  };

  function render() {
    var paired = !!remote;
    $('tvUnpaired').hidden = paired;
    $('tvPaired').hidden = !paired;
    panel.classList.toggle('is-paired', paired);
    $('tvSummary').textContent = paired ? 'TV mode · ' + spaced(remote.code) : 'TV mode';
    if (!paired) return;

    var s = status || { state: 'idle' };
    var loaded = s.state !== 'idle';
    $('tvDot').className = 'cb-tv-dot' + (online ? ' is-live' : '');
    $('tvWhere').textContent = online ? 'TV ' + spaced(remote.code) + ' is on' : 'TV ' + spaced(remote.code) + ' isn’t answering. Is /tv still open on it?';
    $('tvTitle').textContent = loaded ? (s.title || 'Untitled') : '';
    $('tvTitle').hidden = !loaded;
    var line = STATE_TEXT[s.state] || '';
    if (s.state === 'error' && s.error) line += ': ' + s.error;
    $('tvState').textContent = line;
    $('tvState').classList.toggle('is-bad', s.state === 'error' || s.state === 'blocked');

    $('tvControls').hidden = !loaded;
    var dur = s.duration || 0;
    scrub.max = String(Math.max(1, Math.floor(dur)));
    scrub.disabled = !dur;
    if (!dragging) {
      scrub.value = String(Math.floor(s.position || 0));
      $('tvPos').textContent = clock(s.position || 0);
    }
    $('tvDur').textContent = dur ? clock(dur) : '--:--';

    var playing = isPlaying();
    var toggle = $('tvToggle');
    toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    toggle.querySelector('.cb-tv-ico-play').hidden = playing;
    toggle.querySelector('.cb-tv-ico-pause').hidden = !playing;

    var hasFilm = !!(window.CBApp && window.CBApp.tvPayload && window.CBApp.tvPayload());
    $('tvSend').disabled = !hasFilm;
  }

  function toast(text) {
    if (window.CBApp && window.CBApp.toast) window.CBApp.toast(text);
  }

  /* ---------------------------------------------------------------- */

  window.CBTvMode = {
    paired: function () { return !!remote; },
    sendCurrent: sendCurrent,
    refresh: render
  };

  remote = restore();
  render();
  if (remote) poll();

  /* Scanned from the TV's QR: /?tv=123456. Open the panel with the code in
     and pair straight away; drop the code from the address so a reload or a
     shared link does not try again. */
  var fromQr = null;
  try { fromQr = new URLSearchParams(location.search).get('tv'); } catch (e) {}
  if (fromQr && /^[0-9]{6}$/.test(fromQr)) {
    try {
      var u = new URL(location.href);
      u.searchParams.delete('tv');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) {}
    panel.open = true;
    if (!remote || remote.code !== fromQr) {
      if (remote) unpair(true);
      codeInput.value = fromQr;
      pairBtn.disabled = false;
      /* After app.js has set up, and after sign-in: a camera opening this
         link on a signed-out phone lands on the gate, and pairing then
         would only be refused. */
      var whenSignedIn = function () {
        if (!document.body.classList.contains('is-gated')) { pair(); return; }
        var mo = new MutationObserver(function () {
          if (document.body.classList.contains('is-gated')) return;
          mo.disconnect();
          pair();
        });
        mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      };
      if (document.readyState === 'complete') whenSignedIn();
      else window.addEventListener('load', whenSignedIn);
    }
  }
}());
