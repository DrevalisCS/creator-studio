import { useEffect, useState, type ReactNode } from 'react';
import { auth } from '@/lib/api';
import { Spinner } from '@/components/ui/Spinner';

/**
 * Gatekeeps the app routes behind the team-mode login check.
 *
 * - If `/auth/me` returns a user → render children.
 * - If `/auth/me` returns null AND `/auth/mode.team_mode` is true →
 *   redirect to `/login`.
 * - Otherwise (no users + no OWNER_EMAIL env) → render children.
 *
 * The gate must NOT be applied to the `/login` route itself —
 * mount it inside the `<Layout>` branch of the router.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'redirecting'>('checking');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await auth.me();
        if (cancelled) return;
        if (me) {
          setState('ok');
          return;
        }
        const mode = await auth.mode();
        if (cancelled) return;
        if (mode.team_mode) {
          setState('redirecting');
          window.location.href = '/login';
        } else {
          setState('ok');
        }
      } catch {
        // On any transient backend error, let the user through — the next
        // API call will surface the real failure via ApiError.
        if (!cancelled) setState('ok');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== 'ok') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-base">
        <Spinner size="lg" />
      </div>
    );
  }
  return <>{children}</>;
}
