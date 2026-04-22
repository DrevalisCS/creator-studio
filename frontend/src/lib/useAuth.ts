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

// ────────────────────────────────────────────────────────────────────

interface UseAuthModeResult {
  teamMode: boolean;
  demoMode: boolean;
  ready: boolean;
}

/**
 * Fetches /api/v1/auth/mode once on mount. Cached in module scope after
 * the first successful call so repeated renders don't re-fetch.
 */
let _cachedMode: { teamMode: boolean; demoMode: boolean } | null = null;
let _modePromise: Promise<{ teamMode: boolean; demoMode: boolean }> | null = null;

export function useAuthMode(): UseAuthModeResult {
  const [state, setState] = useState<UseAuthModeResult>({
    teamMode: _cachedMode?.teamMode ?? false,
    demoMode: _cachedMode?.demoMode ?? false,
    ready: _cachedMode !== null,
  });

  useEffect(() => {
    if (_cachedMode) return;
    if (!_modePromise) {
      _modePromise = auth
        .mode()
        .then((m) => {
          const resolved = { teamMode: m.team_mode, demoMode: m.demo_mode ?? false };
          _cachedMode = resolved;
          return resolved;
        })
        .catch(() => {
          const fallback = { teamMode: false, demoMode: false };
          _cachedMode = fallback;
          return fallback;
        });
    }
    let alive = true;
    void _modePromise.then((m) => {
      if (alive) setState({ ...m, ready: true });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
