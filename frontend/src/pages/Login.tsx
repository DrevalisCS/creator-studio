import { useState } from 'react';
import { Lock } from 'lucide-react';
import { auth, formatError } from '@/lib/api';

/**
 * Team-mode login screen.
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Client-side guard — stop the form firing an empty request when
    // both fields are blank. The backend rejects it anyway, but this
    // surfaces the problem with a useful message instead of a raw 422.
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Enter your email and password to sign in.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(trimmedEmail, password);
      window.location.href = '/';
    } catch (err) {
      setError(formatError(err) || 'Invalid email or password');
    } finally {
      setSubmitting(false);
    }
  };

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

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-txt-secondary block mb-1">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-bg-base border border-white/[0.08] rounded-md text-sm text-txt-primary focus:outline-none focus:border-accent/40"
            />
          </div>
          <div>
            <label className="text-xs text-txt-secondary block mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-bg-base border border-white/[0.08] rounded-md text-sm text-txt-primary focus:outline-none focus:border-accent/40"
            />
          </div>

          {error && (
            <div className="p-2 rounded border border-error/30 bg-error/10 text-xs text-error">
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
