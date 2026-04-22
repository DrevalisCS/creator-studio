// Shared client-side logic for the Drevalis marketing site.
//
// Responsibilities:
//   1. Wire "Subscribe" buttons to the license server's /checkout endpoint
//   2. Wire the "Manage subscription" form to the license server's /portal endpoint
//   3. Monthly / yearly pricing toggle
//   4. Progressive reveal-on-scroll for .reveal elements
//   5. Email collection UX (stash in sessionStorage, prefill later)

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

document.addEventListener('DOMContentLoaded', () => {
  wireCheckoutButtons();
  wirePaypalButtons();
  wireIntervalToggle();
  wireBillingPortalForm();
  wireReveal();
  wireImageFallback();
  wireLightbox();
});
