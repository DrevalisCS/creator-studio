import { useRef, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { auth, formatError } from '@/lib/api';
import { Input } from '@/components/ui/Input';

/**
 * Team-mode login screen.
 *
 * Two-stage flow when TOTP 2FA is active:
 *
 * Stage 1 — email + password.  Backend returns either:
 *   { message: "logged_in", ... }           → no 2FA, redirect immediately.
 *   { stage: "totp_required", challenge }   → show TOTP input.
 *
 * Stage 2 — 6-digit TOTP code (or 16-char recovery code via toggle).
 *   POST /auth/login/totp with { challenge, code } → redirect on success.
 *
 * Mounted outside the main <Layout> so it's reachable even when the
 * auth cookie is missing. Success → `window.location.href = '/'`
 * (full reload so every downstream component picks up the new
 * session cookie + the whoami fetch in Layout).
 */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // TOTP stage — set when the backend returns {stage: "totp_required"}.
  const [totpChallenge, setTotpChallenge] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const totpInputRef = useRef<HTMLInputElement>(null);

  // ── Stage 1: email + password ─────────────────────────────────────

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Enter your email and password to sign in.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await auth.login(trimmedEmail, password);
      if ('stage' in result && result.stage === 'totp_required') {
        // Backend wants a second factor — show the TOTP input.
        setTotpChallenge(result.challenge);
        // Auto-focus the TOTP input on next render.
        setTimeout(() => totpInputRef.current?.focus(), 50);
      } else {
        // Password-only success.
        window.location.href = '/';
      }
    } catch (err) {
      setError(formatError(err) || 'Invalid email or password');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Stage 2: TOTP / recovery code ────────────────────────────────

  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = totpCode.trim();
    if (!code) {
      setError(useRecovery ? 'Enter your recovery code.' : 'Enter the 6-digit code from your authenticator app.');
      return;
    }
    if (!totpChallenge) return;
    setSubmitting(true);
    setError(null);
    try {
      await auth.loginTotp(totpChallenge, code);
      window.location.href = '/';
    } catch (err) {
      setError(formatError(err) || 'Invalid code. Try again.');
      setTotpCode('');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelTotp = () => {
    setTotpChallenge(null);
    setTotpCode('');
    setUseRecovery(false);
    setError(null);
  };

  // ── Render ─────────────────────────────────────────────────────────

  if (totpChallenge) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-bg-base p-6">
        <div className="w-full max-w-sm bg-bg-elevated/80 border border-white/[0.06] rounded-lg p-8 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-accent/15 border border-accent/30 mx-auto mb-4">
            <ShieldCheck className="text-accent" size={20} />
          </div>
          <h1 className="text-xl font-semibold text-center text-txt-primary mb-1">
            Two-factor verification
          </h1>
          <p className="text-xs text-center text-txt-secondary mb-6">
            {useRecovery
              ? 'Enter one of your 16-character recovery codes.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>

          <form onSubmit={submitTotp} className="space-y-4">
            <Input
              ref={totpInputRef}
              label={useRecovery ? 'Recovery code' : 'Authentication code'}
              type="text"
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              required
              value={totpCode}
              maxLength={useRecovery ? 16 : 6}
              placeholder={useRecovery ? 'abcdef0123456789' : '123456'}
              onChange={(e) => setTotpCode(e.target.value)}
            />

            {error && (
              <div className="p-2 rounded border border-error/30 bg-error/10 text-xs text-error" role="alert">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-gradient-to-r from-accent to-accent-hover text-bg-base font-semibold py-2.5 text-sm disabled:opacity-50"
            >
              {submitting ? 'Verifying…' : 'Verify'}
            </button>
          </form>

          <div className="flex items-center justify-between mt-4">
            <button
              type="button"
              onClick={() => { setUseRecovery(!useRecovery); setTotpCode(''); setError(null); }}
              className="text-[11px] text-txt-muted hover:text-txt-secondary underline underline-offset-2"
            >
              {useRecovery ? 'Use authenticator app instead' : 'Use a recovery code instead'}
            </button>
            <button
              type="button"
              onClick={cancelTotp}
              className="text-[11px] text-txt-muted hover:text-txt-secondary underline underline-offset-2"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-bg-base p-6">
      <div className="w-full max-w-sm bg-bg-elevated/80 border border-white/[0.06] rounded-lg p-8 shadow-lg backdrop-blur-sm">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-accent/15 border border-accent/30 mx-auto mb-4">
          <Lock className="text-accent" size={20} />
        </div>
        <h1 className="text-xl font-semibold text-center text-txt-primary mb-1">
          Sign in
        </h1>
        <p className="text-xs text-center text-txt-secondary mb-6">
          Drevalis Creator Studio — team mode
        </p>

        <form onSubmit={submitCredentials} className="space-y-4">
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <div className="p-2 rounded border border-error/30 bg-error/10 text-xs text-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-gradient-to-r from-accent to-accent-hover text-bg-base font-semibold py-2.5 text-sm disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-[11px] text-txt-muted text-center mt-6">
          First-run install? Set <code>OWNER_EMAIL</code> and <code>OWNER_PASSWORD</code> in
          your <code>.env</code> and try signing in — the owner account is created automatically
          on your first login attempt.
        </p>
      </div>
    </div>
  );
}
