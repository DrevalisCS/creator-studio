/* Drevalis marketing boot intro — shows once per visitor on the first
 * arrival at the site. Matches the in-app retro CRT boot sequence.
 *
 * Gate: ``localStorage.drevalis_marketing_boot_seen``. Cleared by
 * visitors wiping cookies/localStorage; set permanently after the
 * first run so repeat visitors go straight to the content.
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var KEY = 'drevalis_marketing_boot_seen';
  try {
    if (window.localStorage.getItem(KEY)) return;
  } catch (_) {
    // Private mode — still run, just skip persistence.
  }

  // Respect reduced motion — a full-screen flashing terminal isn't kind
  // to folks who opt out of animation.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      try { window.localStorage.setItem(KEY, '1'); } catch (_) {}
      return;
    }
  } catch (_) {}

  var BOOT_DURATION_MS = 2800;
  var FADE_MS = 400;
  var LINES = [
    { text: 'DREVALIS CREATOR STUDIO   v0.19',            at: 0 },
    { text: 'Copyright (c) 2026 Drevalis. All rights reserved.', at: 120 },
    { text: '',                                           at: 240 },
    { text: 'Self-check: pipeline .............. OK',     at: 420 },
    { text: 'Self-check: storage ............... OK',     at: 680 },
    { text: 'Self-check: llm pool .............. OK',     at: 940 },
    { text: 'Self-check: comfyui nodes ......... OK',     at: 1200 },
    { text: 'Self-check: ffmpeg binary ......... OK',     at: 1460 },
    { text: 'Self-check: license ............... OK',     at: 1720 },
    { text: '',                                           at: 1820 },
    { text: 'Loading drevalis.com…',                      at: 1980 },
  ];

  var style = document.createElement('style');
  style.textContent =
    '#drevalis-boot{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:#000;color:#7cff8a;' +
    'font:14px/1.55 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;transition:opacity ' + FADE_MS + 'ms;}' +
    '#drevalis-boot .wrap{max-width:640px;padding:40px 24px;position:relative;z-index:1;}' +
    '#drevalis-boot .crt{position:absolute;inset:0;pointer-events:none;' +
    'background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,0.18) 2px,rgba(0,0,0,0.18) 4px);}' +
    '#drevalis-boot .line{animation:drevbootfade 180ms ease-out both;min-height:1.55em;white-space:pre;}' +
    '@keyframes drevbootfade{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}' +
    '#drevalis-boot .cur{display:inline-block;width:8px;height:1em;background:#7cff8a;vertical-align:-3px;animation:drevbootblink 700ms steps(2) infinite;}' +
    '@keyframes drevbootblink{to{opacity:0}}';
  document.head.appendChild(style);

  var host = document.createElement('div');
  host.id = 'drevalis-boot';
  host.innerHTML = '<div class="crt"></div><div class="wrap" data-out></div>';
  (document.body || document.documentElement).appendChild(host);

  var out = host.querySelector('[data-out]');
  var lockedScroll = document.body ? document.body.style.overflow : '';
  if (document.body) document.body.style.overflow = 'hidden';

  var start = performance.now();
  var rendered = 0;

  function tick() {
    var elapsed = performance.now() - start;
    while (rendered < LINES.length && LINES[rendered].at <= elapsed) {
      var div = document.createElement('div');
      div.className = 'line';
      var t = LINES[rendered].text;
      div.textContent = t === '' ? '\u00A0' : '> ' + t;
      out.appendChild(div);
      rendered++;
    }
    if (elapsed >= 2100 && elapsed < BOOT_DURATION_MS && !out.querySelector('.cur-row')) {
      var curRow = document.createElement('div');
      curRow.className = 'line cur-row';
      curRow.innerHTML = '&gt; <span class="cur"></span>';
      out.appendChild(curRow);
    }
    if (elapsed >= BOOT_DURATION_MS) {
      host.style.opacity = '0';
      setTimeout(function () {
        if (host.parentNode) host.parentNode.removeChild(host);
        if (document.body) document.body.style.overflow = lockedScroll;
        try { window.localStorage.setItem(KEY, '1'); } catch (_) {}
      }, FADE_MS);
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
