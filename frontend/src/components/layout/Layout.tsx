import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { ActivityMonitor } from '@/components/ActivityMonitor';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { DemoBanner } from '@/components/DemoBanner';
import { useAuthMode } from '@/lib/useAuth';
import { jobs as jobsApi } from '@/lib/api';
import { useTheme } from '@/lib/theme';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeJobCount, setActiveJobCount] = useState(0);
  const { demoMode } = useAuthMode();
  const { activityDock } = useTheme();

  // Padding the <main> needs so the Activity Monitor doesn't cover content.
  // Bottom dock ≈ 48px compact bar; left/right rails are 320px; top dock
  // sits above the sticky header so we don't reserve space for it here.
  const dockPadClass =
    activityDock === 'right'
      ? 'md:pr-[320px]'
      : activityDock === 'left'
        ? 'md:pl-[376px] lg:pl-[560px]' // sidebar + rail
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

  return (
    <div
      className="min-h-screen bg-bg-base noise-overlay"
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
          'pt-12 min-h-screen transition-all duration-normal',
          // Mobile: no sidebar offset, leave room for mobile nav + floating pill
          'pl-0 pb-[76px]',
          // Tablet: collapsed sidebar always shown at md+
          activityDock === 'left' ? '' : 'md:pl-[56px]',
          bottomPadClass,
          topPadClass,
          dockPadClass,
          // Desktop: respect sidebar expand/collapse state (unless the
          // activity dock is on the left, which already pads deep enough)
          activityDock === 'left'
            ? ''
            : sidebarCollapsed
              ? 'lg:pl-[56px]'
              : 'lg:pl-[240px]',
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
    </div>
  );
}

export { Layout };
