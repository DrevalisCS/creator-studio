// Shared client-side logic for all marketing pages.
//
// Responsibilities:
// 1. Wire "Subscribe" buttons to the license server's /checkout endpoint
// 2. Wire the "Manage subscription" form to the license server's /portal endpoint
// 3. Email collection UX (stash in sessionStorage, prefill later)

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

document.addEventListener('DOMContentLoaded', () => {
  // Subscribe buttons
  document.querySelectorAll('[data-checkout]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tier = btn.dataset.tier;
      const interval = btn.dataset.interval;
      const email = sessionStorage.getItem('drevalis_email') || null;
      startCheckout({ tier, interval, email });
    });
  });

  // Billing interval toggle (monthly / yearly)
  const toggle = document.querySelector('[data-interval-toggle]');
  if (toggle) {
    toggle.addEventListener('change', () => {
      const yearly = toggle.checked;
      document.querySelectorAll('[data-price]').forEach((el) => {
        const v = yearly ? el.dataset.priceYearly : el.dataset.priceMonthly;
        el.textContent = v;
      });
      document.querySelectorAll('[data-interval-label]').forEach((el) => {
        el.textContent = yearly ? '/yr' : '/mo';
      });
      document.querySelectorAll('[data-checkout]').forEach((btn) => {
        btn.dataset.interval = yearly ? 'yearly' : 'monthly';
      });
    });
  }

  // Account page — billing portal form
  const portalForm = document.querySelector('[data-portal-form]');
  if (portalForm) {
    portalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = portalForm.querySelector('input[name="license_key"]');
      const license_key = input.value.trim();
      if (!license_key) return;
      openBillingPortal({ license_key });
    });
  }
});
