// Shared client-side logic for the Drevalis marketing site.
//
// Responsibilities:
//   1. Wire "Subscribe" buttons to the license server's /checkout endpoint
//   2. Wire the "Manage subscription" form to the license server's /portal endpoint
//   3. Monthly / yearly pricing toggle
//   4. Progressive reveal-on-scroll for .reveal elements
//   5. Email collection UX (stash in sessionStorage, prefill later)
//   6. Opt-in analytics (see initAnalytics below)

// ── Analytics (opt-in) ───────────────────────────────────────────────
// Set ``window.ANALYTICS`` in the page's <head> to enable. Examples:
//   window.ANALYTICS = { provider: 'plausible', domain: 'drevalis.com' }
//   window.ANALYTICS = { provider: 'umami', id: '...', src: 'https://analytics.yourdomain.com/script.js' }
//   window.ANALYTICS = { provider: 'ga4', id: 'G-XXXXXXXXXX' }
// Plausible / Umami set no cookies so no banner is required under
// FADP/GDPR. GA4 needs a consent banner if you target the EU.
(function initAnalytics() {
  if (typeof window === 'undefined') return;
  var a = window.ANALYTICS;
  if (!a || !a.provider) return;
  var s = document.createElement('script');
  s.defer = true;
  if (a.provider === 'plausible') {
    s.src = a.src || 'https://plausible.io/js/script.js';
    s.setAttribute('data-domain', a.domain || location.hostname);
  } else if (a.provider === 'umami') {
    s.src = a.src;
    if (a.id) s.setAttribute('data-website-id', a.id);
  } else if (a.provider === 'ga4') {
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + a.id;
    s.async = true;
    var inline = document.createElement('script');
    inline.innerHTML =
      "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};" +
      "gtag('js',new Date());gtag('config','" + a.id + "',{anonymize_ip:true});";
    document.head.appendChild(inline);
  }
  document.head.appendChild(s);
})();

const LICENSE_SERVER = 'https://license.drevalis.com';

async function startCheckout({ tier, interval, email }) {
  const btn = document.activeElement;
  if (btn && btn.tagName === 'BUTTON') {
    btn.disabled = true;
    btn.dataset.prevText = btn.textContent;
    btn.textContent = 'Redirecting…';
  }
  try {
    const res = await fetch(`${LICENSE_SERVER}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, interval, email: email || null }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.url) throw new Error('No checkout URL returned');
    window.location.href = data.url;
  } catch (err) {
    alert('Could not start checkout: ' + err.message);
    if (btn && btn.tagName === 'BUTTON') {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevText || 'Subscribe';
    }
  }
}

async function openBillingPortal({ license_key }) {
  try {
    const res = await fetch(`${LICENSE_SERVER}/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.url) throw new Error('No portal URL returned');
    window.location.href = data.url;
  } catch (err) {
    alert('Could not open billing portal: ' + err.message);
  }
}

function wireCheckoutButtons() {
  document.querySelectorAll('[data-checkout]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tier = btn.dataset.tier;
      const interval = btn.dataset.interval;
      const email = sessionStorage.getItem('drevalis_email') || null;
      startCheckout({ tier, interval, email });
    });
  });
}

function wireIntervalToggle() {
  const toggle = document.querySelector('[data-interval-toggle]');
  if (!toggle) return;
  const sync = () => {
    const yearly = toggle.checked;
    document.querySelectorAll('[data-price]').forEach((el) => {
      el.textContent = yearly ? el.dataset.priceYearly : el.dataset.priceMonthly;
    });
    document.querySelectorAll('[data-interval-label]').forEach((el) => {
      el.textContent = yearly ? '/yr' : '/mo';
    });
    document.querySelectorAll('[data-checkout]').forEach((btn) => {
      btn.dataset.interval = yearly ? 'yearly' : 'monthly';
    });
    document.querySelectorAll('[data-interval-hint]').forEach((el) => {
      el.textContent = yearly ? 'Billed annually' : 'Billed monthly';
    });
  };
  toggle.addEventListener('change', sync);
  sync();
}

function wireBillingPortalForm() {
  const form = document.querySelector('[data-portal-form]');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input[name="license_key"]');
    const key = input.value.trim();
    if (!key) return;
    openBillingPortal({ license_key: key });
  });
}

function wireReveal() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('revealed'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
  );
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}

function wireImageFallback() {
  // If a product screenshot hasn't been dropped in yet, the broken-image
  // icon is ugly. Remove the <img> so the .img-slot's ::after hint shows.
  document.querySelectorAll('.img-slot img').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

// ── Lightbox — click any .img-slot img to view full-resolution ────────

function wireLightbox() {
  // Build the lightbox shell lazily on first open so the DOM stays clean
  // when the feature isn't used. One shell is reused for every image.
  let shell = null;
  let imgEl = null;
  let captionEl = null;

  const ensureShell = () => {
    if (shell) return;
    shell = document.createElement('div');
    shell.className = 'lightbox';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Screenshot preview');
    shell.innerHTML = `
      <button type="button" class="lightbox-close" aria-label="Close preview">×</button>
      <img class="lightbox-img" alt="" />
      <div class="lightbox-caption"></div>
    `;
    imgEl = shell.querySelector('.lightbox-img');
    captionEl = shell.querySelector('.lightbox-caption');
    const closeBtn = shell.querySelector('.lightbox-close');
    // Close on backdrop click, close button, Escape, or any click outside the img.
    shell.addEventListener('click', (e) => {
      if (e.target === shell || e.target === closeBtn) close();
    });
    // Prevent propagation from the img itself so clicking the image doesn't close.
    imgEl.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(shell);
  };

  const open = (src, alt) => {
    ensureShell();
    imgEl.src = src;
    imgEl.alt = alt || '';
    captionEl.textContent = alt || '';
    captionEl.style.display = alt ? '' : 'none';
    shell.classList.add('open');
    document.body.classList.add('lightbox-open');
  };
  const close = () => {
    if (!shell) return;
    shell.classList.remove('open');
    document.body.classList.remove('lightbox-open');
    // Blank src so the next open doesn't flash the previous image.
    if (imgEl) imgEl.removeAttribute('src');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell?.classList.contains('open')) close();
  });

  document.querySelectorAll('.img-slot').forEach((slot) => {
    slot.addEventListener('click', (e) => {
      const img = slot.querySelector('img');
      // Only open if the img actually loaded — ignore empty placeholder slots.
      if (!img || !img.currentSrc || img.naturalWidth === 0) return;
      // Don't swallow clicks on internal interactive elements (none today,
      // but keeps the behaviour friendly if the slot grows one later).
      if (e.target.closest('a, button')) return;
      open(img.currentSrc, img.alt);
    });
  });
}

// PayPal — feature-flagged. Operator opts in by setting
// ``window.PAYPAL_ENABLED = true`` in a <script> tag before site.js.
// When off, no PayPal buttons are injected (the default).

async function startPaypalCheckout({ tier, interval }) {
  const btn = document.activeElement;
  if (btn && btn.tagName === 'BUTTON') {
    btn.disabled = true;
    btn.dataset.prevText = btn.textContent;
    btn.textContent = 'Redirecting to PayPal…';
  }
  try {
    const res = await fetch(`${LICENSE_SERVER}/paypal/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, interval }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.approve_url) throw new Error('No PayPal approve_url returned');
    window.location.href = data.approve_url;
  } catch (err) {
    alert('Could not start PayPal checkout: ' + err.message);
    if (btn && btn.tagName === 'BUTTON') {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevText || 'Pay with PayPal';
    }
  }
}

function wirePaypalButtons() {
  if (!window.PAYPAL_ENABLED) return;
  document.querySelectorAll('button[data-checkout]').forEach((btn) => {
    if (btn.parentElement?.querySelector('[data-paypal]')) return;
    const pp = document.createElement('button');
    pp.setAttribute('data-paypal', '');
    pp.setAttribute('data-tier', btn.dataset.tier || '');
    pp.setAttribute('data-interval', btn.dataset.interval || 'monthly');
    pp.className = 'btn btn-ghost mb-6';
    pp.style.marginTop = '-14px';
    pp.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:-2px;margin-right:6px" fill="currentColor"><path d="M7.5 21h3.9l.9-5.7h2.6c4.5 0 7-2.2 7.8-6.4.6-3.3-1.4-5.9-5-5.9H11c-.5 0-.9.3-1 .8L7 21c-.1.5.3 1 .9 1zm7.3-9.3h-2.6l1-6.3h2.6c1.9 0 2.9 1 2.6 2.9-.3 2.3-1.5 3.4-3.6 3.4zM3 21h3.9L9.8 2.8c.1-.5-.2-1-.8-1H4.9c-.5 0-.9.3-1 .8L1 20c-.1.5.3 1 .9 1z"/></svg>Pay with PayPal';
    pp.addEventListener('click', (e) => {
      e.preventDefault();
      const tier = pp.dataset.tier;
      const interval = document.querySelector('[data-interval-toggle]')?.checked
        ? 'yearly'
        : 'monthly';
      startPaypalCheckout({ tier, interval });
    });
    btn.insertAdjacentElement('afterend', pp);
  });
}

// ── Built-by-creators: render /data/channels.json into cards ────────
async function renderBuiltByCreators() {
  const host = document.querySelector('[data-built-by-creators]');
  if (!host) return;
  try {
    const res = await fetch('/data/channels.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const channels = await res.json();
    if (!Array.isArray(channels) || channels.length === 0) return;
    host.innerHTML = '';
    for (const c of channels) {
      const card = document.createElement('a');
      card.className = 'card card-hover p-6 flex items-center gap-4';
      card.href = c.url || '#';
      if (c.url && c.url !== '#') {
        card.target = '_blank';
        card.rel = 'noopener';
      }
      const img = document.createElement('img');
      img.className = 'w-14 h-14 rounded-full object-cover shrink-0 bg-[var(--bg-elevated)]';
      img.alt = c.handle || '';
      img.loading = 'lazy';
      img.src = c.thumb || '/assets/images/channels/placeholder.webp';
      img.addEventListener('error', () => {
        img.replaceWith(
          Object.assign(document.createElement('div'), {
            className:
              'w-14 h-14 rounded-full bg-[var(--bg-elevated)] shrink-0 flex items-center justify-center text-[var(--txt-muted)] text-xs',
            textContent: (c.handle || '?').slice(1, 3).toUpperCase(),
          }),
        );
      });
      const body = document.createElement('div');
      body.className = 'min-w-0 flex-1';
      body.innerHTML = `
        <div class="text-[var(--txt-primary)] font-semibold truncate">${escapeHtml(c.handle || '')}</div>
        <div class="text-sm text-[var(--txt-secondary)] truncate">${escapeHtml(c.description || '')}</div>
        <div class="mt-1 text-xs text-[var(--txt-muted)]">
          ${c.subs ? `<span>${escapeHtml(String(c.subs))} subs</span>` : ''}
          ${c.subs && c.episodes ? ' · ' : ''}
          ${c.episodes ? `<span>${escapeHtml(String(c.episodes))} episodes</span>` : ''}
        </div>
      `;
      card.appendChild(img);
      card.appendChild(body);
      host.appendChild(card);
    }
  } catch (err) {
    // Leave the placeholder cards intact — nothing to surface.
    // eslint-disable-next-line no-console
    console.debug('channels.json load failed', err);
  }
}

// ── Example gallery: render /data/examples.json into a YT lite-embed grid
async function renderExampleGallery() {
  const host = document.querySelector('[data-example-gallery]');
  if (!host) return;
  try {
    const res = await fetch('/data/examples.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const examples = await res.json();
    if (!Array.isArray(examples) || examples.length === 0) return;
    host.innerHTML = '';
    for (const ex of examples) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className =
        'card p-0 overflow-hidden aspect-[9/16] relative flex items-center justify-center group';
      tile.setAttribute('data-yt-id', ex.youtube_id || '');
      tile.setAttribute('aria-label', `Play ${ex.series_name || 'example'}`);
      // Poster thumbnail from YouTube's CDN — no iframe load until click.
      const poster = document.createElement('img');
      poster.className =
        'absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition';
      poster.loading = 'lazy';
      poster.alt = ex.series_name || '';
      poster.src = ex.youtube_id
        ? `https://i.ytimg.com/vi/${encodeURIComponent(ex.youtube_id)}/hqdefault.jpg`
        : '';
      const overlay = document.createElement('div');
      overlay.className =
        'absolute inset-0 bg-gradient-to-t from-black/80 to-transparent flex flex-col justify-end p-3 text-left';
      overlay.innerHTML = `
        <div class="text-[var(--txt-primary)] text-sm font-semibold truncate">${escapeHtml(ex.series_name || '')}</div>
        <div class="text-xs text-[var(--txt-muted)] truncate">
          ${ex.duration_seconds ? `${Math.round(ex.duration_seconds)}s` : ''}
          ${ex.gpu_used ? ` · ${escapeHtml(ex.gpu_used)}` : ''}
          ${ex.generation_time_minutes ? ` · ~${escapeHtml(String(ex.generation_time_minutes))} min render` : ''}
        </div>
      `;
      const play = document.createElement('div');
      play.className =
        'absolute inset-0 flex items-center justify-center text-white opacity-80 group-hover:opacity-100 transition';
      play.innerHTML =
        '<svg width="56" height="56" viewBox="0 0 56 56" fill="none"><circle cx="28" cy="28" r="28" fill="rgba(0,0,0,0.45)"/><path d="M22 18 L40 28 L22 38 Z" fill="white"/></svg>';
      tile.appendChild(poster);
      tile.appendChild(overlay);
      tile.appendChild(play);
      tile.addEventListener('click', () => {
        const id = tile.getAttribute('data-yt-id');
        if (!id) return;
        // Replace the tile's content with the real iframe only on click
        // so the page cost stays low until the visitor actually asks.
        tile.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.className = 'w-full h-full absolute inset-0';
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`;
        iframe.title = ex.series_name || 'Drevalis example';
        iframe.loading = 'lazy';
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        tile.appendChild(iframe);
      });
      host.appendChild(tile);
    }
  } catch (err) {
    // Placeholder tile stays — no noise in the UI on network hiccup.
    // eslint-disable-next-line no-console
    console.debug('examples.json load failed', err);
  }
}

// Small, safe HTML escaper for untrusted JSON fields.
function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function wireHeroVideoFallback() {
  // If the hero <video> can't load (file missing, format unsupported,
  // autoplay blocked with no poster fetch), show the static <img>
  // fallback so the hero isn't a black rectangle.
  document.querySelectorAll('[data-hero-video]').forEach((v) => {
    const fallback = v.parentElement?.querySelector('[data-hero-fallback]');
    const swap = () => {
      if (!fallback) return;
      fallback.removeAttribute('hidden');
      v.remove();
    };
    v.addEventListener('error', swap, { once: true });
    // ``stalled`` fires if the network can't keep up; we give it a
    // 3 s grace window before falling back.
    let failTimer = null;
    v.addEventListener('loadeddata', () => {
      if (failTimer) clearTimeout(failTimer);
    }, { once: true });
    failTimer = setTimeout(() => {
      // If the video never reached loadeddata, assume it's broken.
      if (v.readyState < 2 /* HAVE_CURRENT_DATA */) swap();
    }, 3000);
  });
}

function wireCompetitorCompareToggle() {
  document.querySelectorAll('details[data-competitor-compare]').forEach((d) => {
    const label = d.querySelector('[data-compare-label]');
    if (!label) return;
    const sync = () => {
      label.textContent = d.open ? 'Hide comparison' : 'Show comparison';
    };
    d.addEventListener('toggle', sync);
    sync();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireCheckoutButtons();
  wirePaypalButtons();
  wireIntervalToggle();
  wireBillingPortalForm();
  wireReveal();
  wireImageFallback();
  wireLightbox();
  wireHeroVideoFallback();
  wireCompetitorCompareToggle();
  renderBuiltByCreators();
  renderExampleGallery();
});
