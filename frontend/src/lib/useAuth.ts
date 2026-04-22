import { useCallback, useEffect, useState } from 'react';
import { auth, type AuthUser } from '@/lib/api';

interface UseAuthResult {
  user: AuthUser | null;
  loading: boolean;
  /** True once we've made at least one /me call. Distinguishes "initial load" from "logged out". */
  ready: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches the currently-logged-in user (or null) from /api/v1/auth/me.
 *
 * Team mode is opt-in: installs with no users in the DB return null
 * AND the /users endpoint 401s. The LoginGate decides whether to
 * redirect based on both signals.
 */
export function useAuth(): UseAuthResult {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await auth.me();
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { user, loading, ready, refresh };
}
