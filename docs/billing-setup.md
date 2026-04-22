# Billing setup — Stripe (CHF) + PayPal

This doc covers the operator-side setup after v0.16's pricing rework.
All changes happen in the **private** `license-server/` repo and in
Stripe / PayPal dashboards — the public repo just renders the pricing
page and opens checkout URLs returned by the license server.

## 1. Stripe — CHF pricing + automatic conversion

**One-time dashboard work**

Create 8 new Products / Prices in Stripe, all priced in **CHF**:

| Tier     | Interval  | Amount (CHF) | Price env var          |
|----------|-----------|--------------|------------------------|
| Creator  | monthly   | 19           | `STRIPE_PRICE_CREATOR_MONTHLY`  |
| Creator  | yearly    | 190          | `STRIPE_PRICE_CREATOR_YEARLY`   |
| Pro      | monthly   | 49           | `STRIPE_PRICE_PRO_MONTHLY`      |
| Pro      | yearly    | 490          | `STRIPE_PRICE_PRO_YEARLY`       |
| Studio   | monthly   | 99           | `STRIPE_PRICE_STUDIO_MONTHLY`   |
| Studio   | yearly    | 990          | `STRIPE_PRICE_STUDIO_YEARLY`    |

In the Stripe Checkout session creation:

- `currency: 'chf'`
- `automatic_tax: { enabled: true }` — Stripe handles Swiss MWST + EU VAT
- `allow_promotion_codes: true`
- Leave `adaptive_pricing` **on** — Stripe shows the buyer their local
  currency automatically and handles FX.

Update the `license-server/app/stripe_client.py` price-ID env-var
lookup to match the new names. No API change required.

## 2. PayPal — subscription plans

**One-time dashboard work**

On <https://developer.paypal.com>:

1. Create a **Business** app → note the `client_id` + `secret`.
2. In the merchant dashboard, create 6 Subscription Plans (Creator M/Y,
   Pro M/Y, Studio M/Y), priced in **CHF**.

**Env vars on the license-server host**

```
PAYPAL_MODE=live                    # or "sandbox"
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_PLAN_CREATOR_MONTHLY=P-...
PAYPAL_PLAN_CREATOR_YEARLY=P-...
PAYPAL_PLAN_PRO_MONTHLY=P-...
PAYPAL_PLAN_PRO_YEARLY=P-...
PAYPAL_PLAN_STUDIO_MONTHLY=P-...
PAYPAL_PLAN_STUDIO_YEARLY=P-...
PAYPAL_WEBHOOK_ID=WH-...
```

**Endpoints to add in `license-server/` (contract)**

The marketing site already calls these — they 404 gracefully until the
server implements them and the operator flips `PAYPAL_ENABLED`:

- `POST /paypal/checkout` — body `{tier, interval}` → returns
  `{approve_url, subscription_id}`. Use the Subscriptions API v1
  (`/v1/billing/subscriptions`) with `application_context.return_url`
  pointing at `/thank-you?provider=paypal&session_id=...`.
- `POST /paypal/webhook` — receives subscription events:
  - `BILLING.SUBSCRIPTION.ACTIVATED` → mint / extend license JWT
  - `BILLING.SUBSCRIPTION.CANCELLED` → start 7-day grace
  - `PAYMENT.SALE.COMPLETED` → log invoice, extend period

Activate in the frontend once the server is live: add
`<script>window.PAYPAL_ENABLED=true;</script>` before `site.js` in
`pricing.html` and re-deploy the marketing site. The Pay with PayPal
button auto-injects next to every Stripe checkout CTA.

## 3. Feature flags — tier locks

Tier → feature mapping enforced by the license JWT's `features` claim:

| Tier     | features claim                                                |
|----------|---------------------------------------------------------------|
| Creator  | `["base","editor","assets","local_tts","scheduled_publish","seo_preflight"]` |
| Pro      | Creator + `["unlimited_episodes","cloud_gpu","elevenlabs","voice_cloning","character_locks","audiobooks","tiktok","inpaint","continuity"]` |
| Studio   | Pro + `["instagram","x_twitter","team_mode","api_access","priority_support","unlimited_channels"]` |

The Drevalis app already checks `features` via
`core/license/feature_gate.py`. Backend endpoints already gated on
`require_feature("runpod")` etc. will start enforcing these when the
JWT issues them.

## 4. Deploy checklist

- [ ] Create Stripe CHF Prices, set 6 env vars on license-server
- [ ] Create PayPal Plans, set 9 env vars on license-server
- [ ] Implement `/paypal/checkout` + `/paypal/webhook` in
      `license-server/app/routes/paypal.py`
- [ ] Flip `PAYPAL_ENABLED=true` on `pricing.html` and rebuild the
      marketing container
- [ ] `curl -X POST https://license.drevalis.com/paypal/checkout`
      sanity-check
- [ ] Update `features` claims in the license minter for each tier
