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

document.addEventListener('DOMContentLoaded', () => {
  wireCheckoutButtons();
  wireIntervalToggle();
  wireBillingPortalForm();
  wireReveal();
  wireImageFallback();
});
