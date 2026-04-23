/**
 * Theme system — dark/light mode + accent color selection.
 *
 * Persists to localStorage. Applies CSS class to <html> element.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeMode = 'dark' | 'light';

export interface AccentColor {
  id: string;
  name: string;
  /** CSS color value for dark mode */
  dark: string;
  /** CSS color value for light mode */
  light: string;
  /** Hover variant */
  darkHover: string;
  lightHover: string;
}

// ---------------------------------------------------------------------------
// Available accent colors
// ---------------------------------------------------------------------------

export const ACCENT_COLORS: AccentColor[] = [
  {
    id: 'teal',
    name: 'Teal',
    dark: '#00D4AA',
    light: '#00B894',
    darkHover: '#00E8BC',
    lightHover: '#00A885',
  },
  {
    id: 'blue',
    name: 'Ocean Blue',
    dark: '#60A5FA',
    light: '#3B82F6',
    darkHover: '#93C5FD',
    lightHover: '#2563EB',
  },
  {
    id: 'purple',
    name: 'Violet',
    dark: '#A78BFA',
    light: '#8B5CF6',
    darkHover: '#C4B5FD',
    lightHover: '#7C3AED',
  },
  {
    id: 'rose',
    name: 'Rose',
    dark: '#FB7185',
    light: '#F43F5E',
    darkHover: '#FDA4AF',
    lightHover: '#E11D48',
  },
  {
    id: 'amber',
    name: 'Amber',
    dark: '#FBBF24',
    light: '#F59E0B',
    darkHover: '#FCD34D',
    lightHover: '#D97706',
  },
  {
    id: 'emerald',
    name: 'Emerald',
    dark: '#34D399',
    light: '#10B981',
    darkHover: '#6EE7B7',
    lightHover: '#059669',
  },
  {
    id: 'cyan',
    name: 'Cyan',
    dark: '#22D3EE',
    light: '#06B6D4',
    darkHover: '#67E8F9',
    lightHover: '#0891B2',
  },
  {
    id: 'orange',
    name: 'Sunset',
    dark: '#FB923C',
    light: '#F97316',
    darkHover: '#FDBA74',
    lightHover: '#EA580C',
  },
];

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ThemeContextValue {
  mode: ThemeMode;
  accentId: string;
  accent: AccentColor;
  setMode: (mode: ThemeMode) => void;
  setAccentId: (id: string) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_MODE_KEY = 'sf_theme_mode';
const STORAGE_ACCENT_KEY = 'sf_theme_accent';

// ---------------------------------------------------------------------------
// Apply theme to DOM
// ---------------------------------------------------------------------------

function applyTheme(mode: ThemeMode, accent: AccentColor) {
  const html = document.documentElement;

  // Mode class
  if (mode === 'light') {
    html.classList.add('light');
    html.classList.remove('dark');
  } else {
    html.classList.add('dark');
    html.classList.remove('light');
  }

  // Accent CSS variables
  const isLight = mode === 'light';
  html.style.setProperty('--color-accent', isLight ? accent.light : accent.dark);
  html.style.setProperty('--color-accent-hover', isLight ? accent.lightHover : accent.darkHover);
  html.style.setProperty('--color-accent-active', isLight ? accent.light : accent.dark);
  html.style.setProperty('--color-accent-muted', `${isLight ? accent.light : accent.dark}1A`);
  html.style.setProperty('--color-accent-subtle', `${isLight ? accent.light : accent.dark}33`);
  html.style.setProperty('--color-border-accent', `${isLight ? accent.light : accent.dark}33`);
  html.style.setProperty('--shadow-accent-glow',
    `0 0 20px ${isLight ? accent.light : accent.dark}26, 0 0 6px ${isLight ? accent.light : accent.dark}1A`
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

// Safe wrappers — Safari private mode, locked-down browsers and some
// embedded WebViews throw SecurityError on localStorage access. Returning
// ``null`` / swallowing write errors means the theme falls back to its
// in-memory default instead of crashing the ThemeProvider on mount.
function safeGet(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    /* ignore — persistence is best-effort */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = safeGet(STORAGE_MODE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  });

  const [accentId, setAccentIdState] = useState<string>(() => {
    return safeGet(STORAGE_ACCENT_KEY) ?? 'teal';
  });

  const accent = ACCENT_COLORS.find((c) => c.id === accentId) ?? ACCENT_COLORS[0]!;

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    safeSet(STORAGE_MODE_KEY, m);
  }, []);

  const setAccentId = useCallback((id: string) => {
    setAccentIdState(id);
    safeSet(STORAGE_ACCENT_KEY, id);
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  // Apply on mount and when mode/accent changes
  useEffect(() => {
    applyTheme(mode, accent);
  }, [mode, accent]);

  return (
    <ThemeContext.Provider value={{ mode, accentId, accent, setMode, setAccentId, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}