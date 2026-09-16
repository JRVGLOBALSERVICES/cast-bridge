/* Cast Bridge partner embed.
 *
 *   <script src="https://cast.jrvsystems.app/assets/embed.js" async></script>
 *
 * One line on a partner's page — a church, a school, a gym, a course site, a
 * licensed IPTV service — and every <video> on it that plays from a real
 * address gets a "Send to Cast Bridge" button underneath. Tapping it opens
 * Cast Bridge with that address loaded, where Cast to TV, AirPlay and TV mode
 * already work.
 *
 * What it hands over is the address the partner's own page already plays, and
 * nothing else. It sends no referer, no cookies and no page it was on, so a
 * stream that only plays for a signed-in viewer or behind a hotlink check will
 * not play in Cast Bridge either. That is the partner's call to make: serve
 * the file openly, or give it a long-lived signed link in data-cast-src.
 *
 * Skipped on purpose:
 *   - a video under DRM (it raises `encrypted`). A television would get a
 *     black screen, so offering the button would be a promise we cannot keep.
 *   - a video playing from blob: or data: — that is hls.js or a MediaSource
 *     player, and the address it shows belongs to this tab only. Put the
 *     real playlist in data-cast-src and the button comes back.
 *
 * Attributes (all optional):
 *   <video data-cast-src="https://…/master.m3u8">   the address to send
 *   <video data-cast-title="Sunday service">        the title on the TV
 *   <video data-cast-bridge="off">                  no button on this one
 *   <script … data-auto="false">                    only videos marked data-cast-bridge
 *   <script … data-label="Watch on TV">             the button text
 *   <button data-cast-bridge-button data-cast-src="…">   your own button
 *
 * JavaScript: window.CastBridge.send(url, { title }) and CastBridge.scan().
 */
(function () {
  'use strict';

  if (window.CastBridge && window.CastBridge.version) return;

  var script = document.currentScript;
  var ORIGIN = 'https://cast.jrvsystems.app';
  try { if (script && script.src) ORIGIN = new URL(script.src).origin; } catch (e) {}

  var AUTO = !(script && script.getAttribute('data-auto') === 'false');
  var LABEL = (script && script.getAttribute('data-label')) || 'Send to Cast Bridge';
  var DONE = 'data-cast-bridge-done';

  function isHttp(u) { return /^https?:\/\//i.test(String(u || '')); }

  /* The address a video is really playing from, or '' when it has none we
     can hand to another device. */
  function sourceOf(video) {
    var explicit = video.getAttribute('data-cast-src');
    if (explicit) return isHttp(explicit) ? explicit : '';
    var u = video.currentSrc || video.getAttribute('src') || '';
    if (!u) {
      var s = video.querySelector('source[src]');
      if (s) u = s.src;
    }
    return isHttp(u) ? u : '';
  }

  function titleOf(el) {
    return el.getAttribute('data-cast-title') || el.getAttribute('title') ||
      el.getAttribute('aria-label') || document.title || '';
  }

  function send(url, opts) {
    if (!isHttp(url)) return false;
    opts = opts || {};
    var to = ORIGIN + '/?u=' + encodeURIComponent(url);
    if (opts.title) to += '&t=' + encodeURIComponent(String(opts.title).slice(0, 200));
    var win = window.open(to, '_blank', 'noopener');
    /* A blocked pop-up still has somewhere to go. */
    if (!win) location.href = to;
    return true;
  }

  var CSS =
    ':host{all:initial;display:block;margin:8px 0 0}' +
    ':host([hidden]){display:none}' +
    'button{display:inline-flex;align-items:center;gap:8px;min-height:44px;' +
    'padding:0 16px;border:0;border-radius:12px;color:#1b0d03;' +
    'background:linear-gradient(180deg,#ff8a45,#ff6a1a);box-shadow:0 3px 0 #c24a08,0 5px 8px rgba(0,0,0,.3);' +
    'font:700 14px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'cursor:pointer;transition:transform .08s,box-shadow .08s;-webkit-tap-highlight-color:transparent}' +
    'button:hover{filter:brightness(1.06)}' +
    'button:active{transform:translateY(3px);box-shadow:0 0 0 #c24a08,0 1px 2px rgba(0,0,0,.3)}' +
    'button:focus-visible{outline:2px solid #7fb2ff;outline-offset:3px}' +
    'svg{width:18px;height:18px;flex:none}' +
    '@media (prefers-reduced-motion:reduce){button:active{transform:none}}';

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>' +
    '<path d="M2 20h.01"/></svg>';

  function attach(video) {
    if (video.hasAttribute(DONE)) return;
    var mark = video.getAttribute('data-cast-bridge');
    if (mark === 'off') return;
    if (!AUTO && mark === null) return;
    video.setAttribute(DONE, '');

    var host = document.createElement('div');
    host.setAttribute('data-cast-bridge-ui', '');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<style>' + CSS + '</style><button type="button">' + ICON +
      '<span></span></button>';
    root.querySelector('span').textContent = LABEL;
    var drm = false;

    function refresh() { host.hidden = drm || !sourceOf(video); }

    root.querySelector('button').addEventListener('click', function () {
      var u = sourceOf(video);
      if (!u) return;
      try { video.pause(); } catch (e) {}
      send(u, { title: titleOf(video) });
    });

    video.addEventListener('encrypted', function () { drm = true; refresh(); });
    ['loadstart', 'loadedmetadata', 'emptied'].forEach(function (ev) {
      video.addEventListener(ev, refresh);
    });

    video.insertAdjacentElement('afterend', host);
    refresh();
  }

  function bindButton(el) {
    if (el.hasAttribute(DONE)) return;
    el.setAttribute(DONE, '');
    el.addEventListener('click', function (e) {
      var u = el.getAttribute('data-cast-src') || el.getAttribute('href');
      if (!isHttp(u)) return;
      e.preventDefault();
      send(u, { title: titleOf(el) });
    });
  }

  function scan(scope) {
    scope = scope || document;
    if (!scope.querySelectorAll) return;
    Array.prototype.forEach.call(scope.querySelectorAll('video'), attach);
    Array.prototype.forEach.call(scope.querySelectorAll('[data-cast-bridge-button]'), bindButton);
  }

  window.CastBridge = { version: '1', send: send, scan: function () { scan(document); } };

  function start() {
    scan(document);
    /* Players that build their <video> after the page loads. */
    if (window.MutationObserver) {
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          var added = list[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'VIDEO') attach(n);
            else if (n.hasAttribute('data-cast-bridge-button')) bindButton(n);
            else scan(n);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
