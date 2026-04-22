import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Activity, ChevronDown, LogOut, User as UserIcon } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { auth } from '@/lib/api';

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
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const onLogout = async () => {
    try {
      await auth.logout();
    } finally {
      window.location.href = '/login';
    }
  };

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

        {/* User dropdown — only rendered in team mode (signed-in user) */}
        {user && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-full text-txt-secondary hover:text-txt-primary hover:bg-white/[0.04] transition-colors"
              aria-label="User menu"
            >
              <span className="w-6 h-6 rounded-full bg-accent/15 border border-accent/30 text-accent text-[11px] flex items-center justify-center">
                {(user.display_name || user.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden md:inline text-xs font-medium">
                {user.display_name || user.email.split('@')[0]}
              </span>
              <ChevronDown size={12} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-56 rounded-md border border-white/[0.06] bg-bg-elevated shadow-lg z-dropdown overflow-hidden">
                <div className="px-3 py-2 border-b border-white/[0.04]">
                  <div className="text-xs text-txt-muted flex items-center gap-1.5">
                    <UserIcon size={11} />
                    Signed in as
                  </div>
                  <div className="text-sm text-txt-primary truncate">{user.email}</div>
                  <div className="text-[11px] text-txt-muted mt-0.5 capitalize">{user.role}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void onLogout();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-txt-secondary hover:text-error hover:bg-error/10 transition-colors text-left"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

export { Header };
export type { HeaderProps };
