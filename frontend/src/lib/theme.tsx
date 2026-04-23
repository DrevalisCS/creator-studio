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

export type ActivityDockPosition = 'bottom' | 'top' | 'left' | 'right';

interface ThemeContextValue {
  mode: ThemeMode;
  accentId: string;
  accent: AccentColor;
  activityDock: ActivityDockPosition;
  setMode: (mode: ThemeMode) => void;
  setAccentId: (id: string) => void;
  setActivityDock: (p: ActivityDockPosition) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_MODE_KEY = 'sf_theme_mode';
const STORAGE_ACCENT_KEY = 'sf_theme_accent';
const STORAGE_DOCK_KEY = 'sf_activity_dock';

// ---------------------------------------------------------------------------
// Apply theme to DOM
// ---------------------------------------------------------------------------

// ── Color-mix helpers ─────────────────────────────────────────────────
// Parse a ``#RRGGBB`` → {r,g,b} so we can blend accent into neutral
// surfaces at runtime. The v0.20.4 theme switcher only changed four
// accent vars, so swapping accent looked subtle. v0.20.5 mixes accent
// into the whole surface ladder (backgrounds, borders, hover states)
// and bumps up all the related CSS variables, so a theme switch feels
// like a real theme change — card surfaces pick up a subtle tint,
// focus rings recolor, borders warm up.

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function mix(
  base: { r: number; g: number; b: number },
  accent: { r: number; g: number; b: number },
  ratio: number,
): string {
  const r = Math.round(base.r * (1 - ratio) + accent.r * ratio);
  const g = Math.round(base.g * (1 - ratio) + accent.g * ratio);
  const b = Math.round(base.b * (1 - ratio) + accent.b * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

function rgba(
  accent: { r: number; g: number; b: number },
  alpha: number,
): string {
  return `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${alpha})`;
}

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

  const isLight = mode === 'light';
  const accentHex = isLight ? accent.light : accent.dark;
  const accentHoverHex = isLight ? accent.lightHover : accent.darkHover;
  const accentRgb = hexToRgb(accentHex);

  // ── Accent variables ──────────────────────────────────────
  html.style.setProperty('--color-accent', accentHex);
  html.style.setProperty('--color-accent-hover', accentHoverHex);
  html.style.setProperty('--color-accent-active', accentHex);
  html.style.setProperty('--color-accent-muted', rgba(accentRgb, 0.10));
  html.style.setProperty('--color-accent-subtle', rgba(accentRgb, 0.20));
  html.style.setProperty('--color-border-accent', rgba(accentRgb, 0.30));
  html.style.setProperty(
    '--shadow-accent-glow',
    `0 0 24px ${rgba(accentRgb, 0.28)}, 0 0 8px ${rgba(accentRgb, 0.16)}`,
  );

  // ── Surface tinting — v0.20.5 ─────────────────────────────
  // Mix the accent into the base/surface/elevated/hover slots so the
  // whole UI picks up the chosen color rather than just the buttons.
  // Dark mode uses a near-black base; light mode a near-white base.
  const baseColor = isLight
    ? { r: 248, g: 249, b: 250 } // #F8F9FA
    : { r: 10, g: 10, b: 12 }; // #0A0A0C
  const surfaceColor = isLight
    ? { r: 255, g: 255, b: 255 }
    : { r: 17, g: 17, b: 22 }; // #111116
  const elevatedColor = isLight
    ? { r: 255, g: 255, b: 255 }
    : { r: 26, g: 26, b: 32 }; // #1A1A20
  const hoverColor = isLight
    ? { r: 241, g: 243, b: 245 } // #F1F3F5
    : { r: 36, g: 36, b: 44 }; // #24242C

  // Tint percentages are small on purpose — enough to read as "the
  // orange theme" on surfaces without losing readability of white
  // text on those surfaces.
  const tint = isLight ? 0.04 : 0.035;
  const hoverTint = isLight ? 0.07 : 0.065;

  html.style.setProperty('--color-bg-base', mix(baseColor, accentRgb, tint * 0.4));
  html.style.setProperty('--color-bg-surface', mix(surfaceColor, accentRgb, tint));
  html.style.setProperty('--color-bg-elevated', mix(elevatedColor, accentRgb, tint));
  html.style.setProperty('--color-bg-hover', mix(hoverColor, accentRgb, hoverTint));
  html.style.setProperty(
    '--color-bg-active',
    mix(hoverColor, accentRgb, hoverTint * 1.4),
  );

  // Borders pick up a subtle accent wash too — cards read as a set.
  const borderColor = isLight
    ? { r: 229, g: 231, b: 235 } // #E5E7EB
    : { r: 38, g: 38, b: 45 }; // #26262D
  html.style.setProperty('--color-border', mix(borderColor, accentRgb, 0.12));
  html.style.setProperty(
    '--color-border-hover',
    mix(borderColor, accentRgb, 0.22),
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

  const [activityDock, setActivityDockState] = useState<ActivityDockPosition>(() => {
    const stored = safeGet(STORAGE_DOCK_KEY);
    return (['bottom', 'top', 'left', 'right'] as const).includes(
      stored as ActivityDockPosition,
    )
      ? (stored as ActivityDockPosition)
      : 'bottom';
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

  const setActivityDock = useCallback((p: ActivityDockPosition) => {
    setActivityDockState(p);
    safeSet(STORAGE_DOCK_KEY, p);
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  // Apply on mount and when mode/accent changes
  useEffect(() => {
    applyTheme(mode, accent);
  }, [mode, accent]);

  // Reflect dock position on <html> so both CSS-side layout and components
  // that need to know (e.g. sidebar, toast stack) can react without
  // re-rendering via context changes.
  useEffect(() => {
    document.documentElement.dataset.activityDock = activityDock;
  }, [activityDock]);

  return (
    <ThemeContext.Provider
      value={{
        mode,
        accentId,
        accent,
        activityDock,
        setMode,
        setAccentId,
        setActivityDock,
        toggleMode,
      }}
    >
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