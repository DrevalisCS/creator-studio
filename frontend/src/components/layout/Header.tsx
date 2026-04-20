import { useLocation } from 'react-router-dom';
import { Activity } from 'lucide-react';

// ---------------------------------------------------------------------------
// Route -> Title mapping
// ---------------------------------------------------------------------------

function getPageTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  if (pathname === '/series') return 'Series';
  if (pathname.startsWith('/series/')) return 'Series Detail';
  if (pathname === '/episodes') return 'Episodes';
  if (pathname.startsWith('/episodes/')) return 'Episode Detail';
  if (pathname === '/audiobooks') return 'Text to Voice';
  if (pathname.startsWith('/audiobooks/')) return 'Audiobook Detail';
  if (pathname === '/youtube') return 'YouTube';
  if (pathname === '/calendar') return 'Calendar';
  if (pathname === '/jobs') return 'Jobs';
  if (pathname === '/logs') return 'Event Log';
  if (pathname === '/settings') return 'Settings';
  if (pathname === '/help') return 'Help';
  if (pathname === '/about') return 'About';
  return 'Drevalis Creator Studio';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HeaderProps {
  activeJobCount: number;
  sidebarCollapsed: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Header({ activeJobCount, sidebarCollapsed }: HeaderProps) {
  const location = useLocation();
  const title = getPageTitle(location.pathname);

  return (
    <header
      className={[
        'fixed top-0 right-0 h-12 bg-bg-surface/60 backdrop-blur-xl border-b border-white/[0.04] z-sticky',
        'flex items-center justify-between px-4 md:px-6',
        'transition-all duration-normal',
        // Mobile: full width (no sidebar). Tablet: collapsed sidebar. Desktop: respect toggle.
        'left-0',
        'md:left-[56px]',
        sidebarCollapsed ? 'lg:left-[56px]' : 'lg:left-[240px]',
      ].join(' ')}
    >
      {/* Page title */}
      <h1 className="text-lg font-display font-semibold text-txt-primary tracking-tight">{title}</h1>

      {/* Right actions */}
      <div className="flex items-center gap-3">
        {/* Active jobs indicator */}
        {activeJobCount > 0 && (
          <a
            href="/"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-accent bg-accent/[0.08] border border-accent/20 hover:bg-accent/[0.12] transition-all duration-normal"
            title="Active generation jobs"
          >
            <Activity size={14} className="animate-pulse" />
            <span className="text-xs font-medium">{activeJobCount}</span>
            <span className="text-xs text-accent/70">
              {activeJobCount === 1 ? 'job' : 'jobs'}
            </span>
          </a>
        )}
      </div>
    </header>
  );
}

export { Header };
export type { HeaderProps };
