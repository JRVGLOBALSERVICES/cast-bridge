/* TV mode — the phone's side: pairing, "Watch on", and the remote.
 *
 * The television opens cast.jrvsystems.app/tv in its own browser and shows a
 * six-digit code. Entered here, the phone and that TV share a room on the
 * server. The TV fetches and plays what is sent, and this is the remote.
 *
 * Why it exists: on an iPhone the only way to a TV from a web page is
 * AirPlay, and AirPlay sends the film FROM the phone. iOS hands that route to
 * whichever app played sound last, so Instagram takes the TV mid-film. A TV
 * that fetches the film itself cannot be taken from.
 *
 * Paired and ON are two different things, and conflating them was the bug
 * Rj reported as "can't turn off TV mode, it keeps running again": once
 * paired, every film opened anywhere in the app went straight to the TV, and
 * Stop only stopped one film. Now:
 *
 *   paired   the phone knows a TV and can reach it
 *   onTv     films go to that TV — chosen under "Watch on"
 *
 * "This phone" and "Stop on the TV" both stop the TV and switch onTv off, so
 * the next film plays on the phone. "Disconnect this TV" forgets the TV.
 *
 * The app's own state (what is loaded, its title, subtitles) lives inside
 * app.js. It hands over what the TV needs through window.CBApp, and asks this
 * module through window.CBTvMode whether films should go to the TV.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var STORE = 'cb-tv-remote';
  var STATUS_MS = 2000;
  var IDLE_STATUS_MS = 10000;
  /* A status the TV wrote before it ran our last command says nothing about
     that command. Ignore it for this long, then trust the TV again. */
  var SETTLE_MS = 6000;

  var remote = null;         // { code, phoneKey, onTv }
  var status = null;
  var online = false;
  var timer = null;
  var dragging = false;
  var pendingPlay = null;    // optimistic play/pause until the TV agrees
  var awaitSeq = 0;          // the seq of our last command the TV has not run yet
  var awaitUntil = 0;

  if (!$('tvRemote') || !$('tvPairForm')) return;

  function clock(sec) {
    return window.CBResume ? window.CBResume.clock(sec) : String(Math.floor(sec || 0));
  }

  function app() { return window.CBApp || null; }

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
      /* A pairing saved by the old build has no onTv. It comes back OFF: that
         build is the one that kept sending films to the TV unasked. */
      if (r && /^[0-9]{6}$/.test(r.code) && r.phoneKey) {
        return { code: r.code, phoneKey: r.phoneKey, onTv: r.onTv === true };
      }
    } catch (e) { /* nothing stored */ }
    return null;
  }

  function spaced(code) { return code.slice(0, 3) + ' ' + code.slice(3); }

  function toast(text) {
    var a = app();
    if (a && a.toast) a.toast(text);
  }

  function go(view) {
    var a = app();
    if (a && a.showView) a.showView(view);
  }

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
      /* Connecting IS choosing the TV: that is what the person came here
         to do. */
      remote = { code: j.code, phoneKey: j.phoneKey, onTv: true };
      status = null;
      online = true;
      save();
      codeInput.value = '';
      render();
      poll();
      var a = app();
      if (a && a.hasFilm && a.hasFilm()) {
        toast('Connected. Sending the film to the TV.');
        sendCurrent();
        go('playing');
      } else {
        toast('Connected to the TV. Pick a film and it plays there.');
        go('cast');
      }
    }).catch(function (e) {
      pairError(e.message || 'That code did not work.');
      codeInput.value = '';
      codeInput.focus();
    }).then(function () {
      pairBtn.classList.remove('is-busy');
      pairBtn.disabled = digits().length !== 6;
    });
  }

  /* Forget the TV. The server queues a stop for it on the way, so the TV
     does not carry on playing a film nobody can control any more. */
  function unpair(silent) {
    var r = remote;
    remote = null;
    status = null;
    save();
    stopPolling();
    render();
    if (r) api({ action: 'unpair', code: r.code, phoneKey: r.phoneKey }).catch(function () {});
    if (!silent) toast('TV disconnected. Films play on this phone.');
  }

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  function command(c) {
    if (!remote) return Promise.resolve(false);
    return api({ action: 'send', code: remote.code, phoneKey: remote.phoneKey, command: c })
      .then(function (j) {
        if (j.gone) { unpair(true); toast('That TV is no longer connected. Open /tv on the TV and connect again.'); return false; }
        if (!j.ok) { toast(j.error || 'The TV did not get that.'); return false; }
        if (j.seq) { awaitSeq = j.seq; awaitUntil = Date.now() + SETTLE_MS; }
        setTimeout(poll, 1200);
        return true;
      }, function () {
        toast('Could not reach Cast Bridge. Check the phone’s connection.');
        return false;
      });
  }

  function sendCurrent(at) {
    var a = app();
    var p = a && a.tvPayload && a.tvPayload();
    if (!remote) return;
    if (!p) { toast('Pick a film first, then play it on the TV.'); return; }
    if (p.expired) {
      /* The signed link has run out. Reading the page again reloads the
         film, and load() sends it here because the TV is chosen. */
      toast('Refreshing the link, then sending it to the TV.');
      a.reread();
      return;
    }
    if (typeof at === 'number') p.at = at;
    a.pauseLocal();
    var btn = $('tvSend');
    btn.classList.add('is-busy');
    btn.disabled = true;
    status = { state: 'loading', position: p.at || 0, duration: 0, title: p.title };
    render();
    command({
      type: 'load', url: p.url, fallback: p.fallback, mime: p.mime, title: p.title,
      at: p.at, subs: p.subs, subsName: p.subsName
    }).then(function (sent) {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      if (!sent) { status = { state: 'idle' }; render(); }
    });
  }

  /* Stop the film on the TV and hand films back to the phone. With
     `here`, carry on on the phone from where the TV had got to. */
  function stopOnTv(here) {
    if (!remote) return;
    var at = status && status.position ? status.position : 0;
    var wasLoaded = status && status.state && status.state !== 'idle';
    remote.onTv = false;
    save();
    command({ type: 'stop' });
    status = { state: 'idle' };
    pendingPlay = null;
    render();
    var a = app();
    if (here) {
      if (a && a.hasFilm && a.hasFilm()) {
        if (a.resumeLocal) a.resumeLocal(wasLoaded ? at : undefined);
        toast('Playing on this phone. The TV has stopped.');
      } else {
        toast('Films play on this phone now.');
      }
    } else {
      toast('Stopped on the TV. The next film plays on this phone.');
    }
  }

  function chooseTv() {
    if (!remote) { go('tv'); return; }
    if (remote.onTv) return;
    remote.onTv = true;
    save();
    render();
    poll();
    var a = app();
    if (a && a.hasFilm && a.hasFilm()) sendCurrent();
  }

  $('onTv').addEventListener('click', chooseTv);
  $('onPhone').addEventListener('click', function () {
    if (remote && remote.onTv) stopOnTv(true);
  });

  $('tvSend').addEventListener('click', function () { sendCurrent(); });
  $('tvStop').addEventListener('click', function () { stopOnTv(false); });
  $('tvManage').addEventListener('click', function () { go('tv'); });
  $('tvUnpair').addEventListener('click', function () { unpair(false); });
  $('tvWatchHere').addEventListener('click', function () {
    go('playing');
    chooseTv();
  });
  $('tvBack').addEventListener('click', function () { command({ type: 'skip', by: -10 }); });
  $('tvFwd').addEventListener('click', function () { command({ type: 'skip', by: 10 }); });
  $('tvToggle').addEventListener('click', function () {
    var playing = isPlaying();
    pendingPlay = { playing: !playing, until: Date.now() + SETTLE_MS };
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
      if (j.gone) { unpair(true); toast('That TV is no longer connected.'); return; }
      if (j.ok) {
        online = j.online;
        var s = j.status;
        /* Written before the TV ran our last command: keep what we already
           know (a Stop, a new film) rather than flashing the old state back
           — that flash is what made Stop look like it had not worked. */
        var stale = s && awaitSeq && (s.seq || 0) < awaitSeq && Date.now() < awaitUntil;
        if (s && !stale) { status = s; awaitSeq = 0; }
        render();
      }
    }, function () { online = false; render(); }).then(schedule);
  }

  function schedule() {
    clearTimeout(timer);
    if (remote && document.visibilityState === 'visible') {
      timer = setTimeout(poll, remote.onTv ? STATUS_MS : IDLE_STATUS_MS);
    }
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
    idle: 'Nothing playing on the TV.',
    loading: 'Loading on the TV…',
    buffering: 'Buffering on the TV…',
    playing: 'Playing on the TV',
    paused: 'Paused on the TV',
    ended: 'Finished on the TV',
    blocked: 'Press OK on the TV remote once to start it. TV browsers won’t start sound on their own.',
    error: 'The TV couldn’t play it'
  };

  function render() {
    var paired = !!remote;
    var onTv = paired && remote.onTv;
    var a = app();
    var hasFilm = !!(a && a.hasFilm && a.hasFilm());

    /* Watch on */
    var phoneBtn = $('onPhone');
    var tvBtn = $('onTv');
    phoneBtn.classList.toggle('is-on', !onTv);
    phoneBtn.setAttribute('aria-pressed', onTv ? 'false' : 'true');
    tvBtn.classList.toggle('is-on', !!onTv);
    tvBtn.setAttribute('aria-pressed', onTv ? 'true' : 'false');
    tvBtn.textContent = paired ? 'TV ' + spaced(remote.code) : 'TV browser';
    var playing = $('view-playing');
    if (playing) playing.classList.toggle('is-on-tv', !!onTv);

    /* The TV screen: pair, or manage the paired TV */
    $('tvUnpaired').hidden = paired;
    $('tvPaired').hidden = !paired;
    $('title-tv').textContent = paired ? 'Your TV' : 'Connect a TV';
    if (paired) {
      $('tvLinkedDot').className = 'cb-tv-dot' + (online ? ' is-live' : '');
      $('tvLinkedName').textContent = 'TV ' + spaced(remote.code);
      $('tvLinkedSub').textContent = online
        ? (onTv ? 'Connected. Films play on the TV.' : 'Connected. Films play on this phone right now.')
        : 'Not answering. Is cast.jrvsystems.app/tv still open on the TV?';
      $('tvWatchHere').hidden = onTv || !hasFilm;
    }

    /* The remote */
    $('tvRemote').hidden = !onTv;
    if (!onTv) return;

    var s = status || { state: 'idle' };
    var loaded = s.state !== 'idle';
    $('tvDot').className = 'cb-tv-dot' + (online ? ' is-live' : '');
    $('tvWhere').textContent = online
      ? 'TV ' + spaced(remote.code)
      : 'TV ' + spaced(remote.code) + ' isn’t answering. Is /tv still open on it?';
    var line = STATE_TEXT[s.state] || '';
    if (s.state === 'error' && s.error) line += ': ' + s.error;
    if (s.state === 'playing' && s.title) line = 'Playing on the TV';
    $('tvState').textContent = line;
    $('tvState').classList.toggle('is-bad', s.state === 'error' || s.state === 'blocked');

    var live = loaded && s.state !== 'ended' && s.state !== 'error';
    $('tvControls').hidden = !live;
    $('tvSend').hidden = live || !hasFilm;
    $('tvSend').querySelector('.cb-label').textContent =
      s.state === 'ended' || s.state === 'error' ? 'Play it on the TV again' : 'Play it on the TV';
    $('tvStop').disabled = !loaded;

    var dur = s.duration || 0;
    scrub.max = String(Math.max(1, Math.floor(dur)));
    scrub.disabled = !dur;
    if (!dragging) {
      scrub.value = String(Math.floor(s.position || 0));
      $('tvPos').textContent = clock(s.position || 0);
    }
    $('tvDur').textContent = dur ? clock(dur) : '--:--';

    var on = isPlaying();
    var toggle = $('tvToggle');
    toggle.setAttribute('aria-label', on ? 'Pause on the TV' : 'Play on the TV');
    toggle.querySelector('.cb-tv-ico-play').hidden = on;
    toggle.querySelector('.cb-tv-ico-pause').hidden = !on;
  }

  /* ---------------------------------------------------------------- */

  window.CBTvMode = {
    paired: function () { return !!remote; },
    onTv: function () { return !!(remote && remote.onTv); },
    sendCurrent: sendCurrent,
    refresh: render
  };

  remote = restore();
  /* After app.js has set up: render reads whether a film is loaded. */
  window.addEventListener('load', render);
  render();
  if (remote) poll();

  /* Scanned from the TV's QR: /?tv=123456. Open the TV screen with the code
     in and pair straight away; drop the code from the address so a reload or
     a shared link does not try again. */
  var fromQr = null;
  try { fromQr = new URLSearchParams(location.search).get('tv'); } catch (e) {}
  if (fromQr && /^[0-9]{6}$/.test(fromQr)) {
    try {
      var u = new URL(location.href);
      u.searchParams.delete('tv');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) {}
    if (!remote || remote.code !== fromQr) {
      if (remote) unpair(true);
      codeInput.value = fromQr;
      pairBtn.disabled = false;
      /* After app.js has set up, and after sign-in: a camera opening this
         link on a signed-out phone lands on the gate, and pairing then
         would only be refused. */
      var whenSignedIn = function () {
        go('tv');
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
