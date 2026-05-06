import { useState, useEffect, createContext, useContext, useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { ActivityMonitor } from '@/components/ActivityMonitor';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { DemoBanner } from '@/components/DemoBanner';
import { CommandPalette } from '@/components/CommandPalette';
import { useAuthMode } from '@/lib/useAuth';
import { jobs as jobsApi } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { useRouteDocumentTitle } from '@/hooks/useDocumentTitle';

// ---------------------------------------------------------------------------
// Command Palette context
// ---------------------------------------------------------------------------
//
// Replaces the previous Header → Layout coupling that fired a synthetic
// ``KeyboardEvent`` on the window object to nudge the global Cmd+K
// listener. Any descendant of ``Layout`` can now open / close the
// palette by calling ``useCommandPalette().setOpen(true)``. The Cmd+K
// keystroke is owned by Layout exclusively — pages should not bind it
// themselves (Help previously had its own listener which double-fired).

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (ctx === null) {
    throw new Error('useCommandPalette must be used inside <Layout>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeJobCount, setActiveJobCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { demoMode } = useAuthMode();
  const { activityDock } = useTheme();

  // Drive document.title from the current route's routeMeta entry.
  // Pages can still override per-instance via ``useDocumentTitle``.
  useRouteDocumentTitle();

  // Global ⌘K / Ctrl+K — opens the command palette from anywhere in
  // the app shell. Help has its own content-scoped palette; this one
  // jumps between routes + actions. The "/" shortcut is reserved for
  // page-local search inputs, so we don't bind it globally here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [paletteOpen]);

  // Padding the <main> needs so the Activity Monitor doesn't cover
  // content. The rail widths are CSS-driven (ActivityMonitor sets
  // ``w-[44px]`` collapsed or ``w-[320px]`` expanded based on its own
  // state), so we conservatively reserve the 44px collapsed width from
  // the page frame — the rail floats above ``<main>`` when expanded,
  // which is the desirable behavior (rail overlays content briefly
  // without reshuffling the layout on every expand/collapse).
  const dockPadClass =
    activityDock === 'right'
      ? 'md:pr-[44px]'
      : activityDock === 'left'
        ? 'md:pl-[100px]' // sidebar collapsed (56px) + rail (44px)
        : '';
  const bottomPadClass = activityDock === 'bottom' ? 'md:pb-[48px]' : 'md:pb-0';
  const topPadClass = activityDock === 'top' ? 'md:pt-[60px]' : '';

  // Poll active jobs count every 10 seconds
  useEffect(() => {
    let mounted = true;

    const fetchCount = async () => {
      try {
        const active = await jobsApi.active();
        if (mounted) setActiveJobCount(active.length);
      } catch {
        // Silently ignore - backend might not be running
      }
    };

    void fetchCount();
    const interval = setInterval(() => void fetchCount(), 10000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Memoise the context value so descendants don't re-render on every
  // sibling state change in Layout.
  const paletteContextValue = useMemo<CommandPaletteContextValue>(
    () => ({
      open: paletteOpen,
      setOpen: setPaletteOpen,
      toggle: () => setPaletteOpen((v) => !v),
    }),
    [paletteOpen],
  );

  return (
    <CommandPaletteContext.Provider value={paletteContextValue}>
    <div
      className="min-h-[100dvh] bg-bg-base noise-overlay"
      style={demoMode ? { paddingTop: 32 } : undefined}
    >
      <DemoBanner />
      {/* Sidebar — hidden on mobile, visible md+ */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((prev) => !prev)}
      />
      <Header
        activeJobCount={activeJobCount}
        sidebarCollapsed={sidebarCollapsed}
      />

      {/* Main content area
          Mobile:  no left padding (no sidebar), bottom padding for mobile nav (60px) + activity pill (16px) = 76px
          Tablet:  collapsed sidebar width (56px) + activity bar height (32px)
          Desktop: expanded (240px) or collapsed (56px) sidebar width */}
      <main
        className={[
          'pt-12 min-h-[100dvh] transition-all duration-normal',
          // Mobile: no sidebar offset, leave room for mobile nav + floating pill
          'pl-0 pb-[76px]',
          // Tablet: collapsed sidebar always shown at md+
          'md:pl-[56px]',
          bottomPadClass,
          topPadClass,
          dockPadClass,
          // Desktop: respect sidebar expand/collapse state
          sidebarCollapsed ? 'lg:pl-[56px]' : 'lg:pl-[240px]',
        ].join(' ')}
      >
        <div className="p-6 pb-6 max-w-[1400px] mx-auto">
          <Outlet />
        </div>
      </main>

      {/* Global activity monitor (docked bar on desktop, floating pill on mobile) */}
      <ActivityMonitor />

      {/* Bottom tab navigation — only rendered below md breakpoint */}
      <MobileNav />

      {/* First-run onboarding wizard (renders nothing when dismissed or when
          the critical three — ComfyUI/LLM/voice — are already configured) */}
      <OnboardingGate />

      {/* Global command palette — ⌘K / Ctrl+K from anywhere */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
    </CommandPaletteContext.Provider>
  );
}

export { Layout, useCommandPalette, CommandPaletteContext };
export type { CommandPaletteContextValue };
