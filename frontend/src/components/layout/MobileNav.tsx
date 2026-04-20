import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Film, Mic, Layers, ListChecks } from 'lucide-react';
import { jobs as jobsApi } from '@/lib/api';

// ---------------------------------------------------------------------------
// Tab definitions — 5 most-used items for mobile
// ---------------------------------------------------------------------------

const TABS = [
  { to: '/', icon: LayoutDashboard, label: 'Home', end: true },
  { to: '/episodes', icon: Film, label: 'Episodes', end: false },
  { to: '/series', icon: Layers, label: 'Series', end: false },
  { to: '/audiobooks', icon: Mic, label: 'Voice', end: false },
  { to: '/jobs', icon: ListChecks, label: 'Jobs', end: false },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function MobileNav() {
  const [genCount, setGenCount] = useState(0);

  // Poll generating count every 10s — mirrors Sidebar polling
  useEffect(() => {
    let mounted = true;

    const poll = () => {
      jobsApi
        .status()
        .then((d) => {
          if (mounted) setGenCount(d.generating_episodes ?? 0);
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    // md:hidden — only renders below the md breakpoint
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-[99] bg-bg-surface/80 backdrop-blur-xl border-t border-white/[0.06]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Mobile navigation"
    >
      <div className="flex h-[60px]">
        {TABS.map((tab) => {
          const isEpisodes = tab.to === '/episodes';

          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                [
                  'relative flex flex-col items-center justify-center flex-1 gap-1',
                  'transition-colors duration-fast',
                  isActive ? 'text-accent' : 'text-txt-secondary',
                ].join(' ')
              }
              aria-label={tab.label}
            >
              {({ isActive }) => (
                <>
                  <div className="relative">
                    <tab.icon
                      size={22}
                      strokeWidth={isActive ? 2.5 : 1.75}
                      aria-hidden="true"
                    />
                    {/* Generating badge — 6px green dot on Episodes icon */}
                    {isEpisodes && genCount > 0 && (
                      <span
                        className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green-500"
                        aria-label={`${genCount} episode${genCount > 1 ? 's' : ''} generating`}
                      />
                    )}
                  </div>
                  <span className="text-[10px] font-display font-medium leading-none">{tab.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

export { MobileNav };
