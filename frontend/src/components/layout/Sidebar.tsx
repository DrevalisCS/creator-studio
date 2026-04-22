import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { useTheme, ACCENT_COLORS } from '@/lib/theme';
import { jobs as jobsApi } from '@/lib/api';
import {
  LayoutDashboard,
  Layers,
  Film,
  Mic,
  Clapperboard,
  Terminal,
  ListChecks,
  Activity,
  Cpu,
  Settings,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Youtube,
  CalendarDays,
  Send,
  Sun,
  Moon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Nav items — ordered by workflow frequency
// ---------------------------------------------------------------------------

const NAV_TOP = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
] as const;

// Content Studio — Episodes first (most used), then Series, then Voice
const NAV_CONTENT_STUDIO = [
  { to: '/episodes', icon: Film, label: 'Episodes' },
  { to: '/series', icon: Layers, label: 'Series' },
  { to: '/audiobooks', icon: Mic, label: 'Text to Voice' },
] as const;

// Publish — always visible (YouTube not conditional on connection)
const NAV_PUBLISH = [
  { to: '/calendar', icon: CalendarDays, label: 'Calendar' },
  { to: '/youtube', icon: Youtube, label: 'YouTube' },
] as const;

// System — Jobs promoted (users need it when things break)
const NAV_SYSTEM = [
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/cloud-gpu', icon: Cpu, label: 'Cloud GPU' },
  { to: '/jobs', icon: ListChecks, label: 'Jobs' },
  { to: '/usage', icon: Activity, label: 'Usage' },
  { to: '/logs', icon: Terminal, label: 'Event Log' },
] as const;

const NAV_BOTTOM = [
  { to: '/help', icon: HelpCircle, label: 'Help' },
] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function SectionHeader({ label, icon: Icon, collapsed }: { label: string; icon: typeof LayoutDashboard; collapsed: boolean }) {
  return (
    <div className={`mt-3 mb-1 ${collapsed ? 'px-0 text-center' : 'px-3'}`}>
      {!collapsed ? (
        <span className="text-[10px] font-display font-bold uppercase tracking-[0.15em] text-txt-tertiary">
          {label}
        </span>
      ) : (
        <Icon size={12} className="text-txt-tertiary mx-auto" />
      )}
    </div>
  );
}

function SidebarLink({ item, collapsed }: { item: { to: string; icon: typeof LayoutDashboard; label: string }; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        [
          'relative flex items-center gap-2.5 rounded-md transition-all duration-fast',
          collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
          isActive
            ? 'bg-accent/[0.08] text-accent'
            : 'text-txt-secondary hover:text-txt-primary hover:bg-white/[0.04]',
        ].join(' ')
      }
      title={collapsed ? item.label : undefined}
    >
      {({ isActive }) => (
        <>
          <div className={`absolute left-0 w-0.5 rounded-r transition-all duration-300 ${isActive ? 'h-5 bg-accent opacity-100' : 'h-0 bg-accent opacity-0'}`} />
          <item.icon size={18} className="shrink-0" />
          {!collapsed && <span className="text-sm font-medium">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { mode, toggleMode, accentId, setAccentId } = useTheme();
  const [genCount, setGenCount] = useState(0);

  useEffect(() => {
    const poll = () => {
      jobsApi.status()
        .then(d => setGenCount(d.generating_episodes ?? 0))
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside
      className={[
        'fixed top-0 left-0 h-screen bg-bg-surface/70 backdrop-blur-xl border-r border-white/[0.06] z-sticky',
        // Hidden on mobile, shown as flex column on md+
        'hidden md:flex flex-col transition-all duration-normal',
        collapsed ? 'w-[56px]' : 'w-[240px]',
      ].join(' ')}
    >
      {/* Logo */}
      <div className="h-12 flex items-center gap-2.5 px-4 border-b border-white/[0.04] shrink-0">
        <Clapperboard size={20} className="text-accent shrink-0 breathing-glow rounded-md" />
        {!collapsed && (
          <span className="text-md font-display font-bold text-gradient-accent whitespace-nowrap">
            Drevalis
          </span>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-2 flex flex-col gap-0.5 px-2 overflow-y-auto scrollbar-hidden">
        {/* Dashboard */}
        {NAV_TOP.map((item) => (
          <SidebarLink key={item.to} item={item} collapsed={collapsed} />
        ))}

        {/* Content Studio */}
        <SectionHeader label="Content Studio" icon={Clapperboard} collapsed={collapsed} />
        {NAV_CONTENT_STUDIO.map((item) => {
          const isEpisodes = item.to === '/episodes';
          if (isEpisodes) {
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  [
                    'relative flex items-center gap-2.5 rounded-md transition-all duration-fast',
                    collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
                    isActive
                      ? 'bg-accent/[0.08] text-accent'
                      : 'text-txt-secondary hover:text-txt-primary hover:bg-white/[0.04]',
                  ].join(' ')
                }
                title={collapsed ? item.label : undefined}
              >
                {({ isActive }) => (
                  <>
                    <div className={`absolute left-0 w-0.5 rounded-r transition-all duration-300 ${isActive ? 'h-5 bg-accent opacity-100' : 'h-0 bg-accent opacity-0'}`} />
                    <item.icon size={18} className="shrink-0" />
                    {!collapsed && (
                      <>
                        <span className="text-sm font-medium flex-1">{item.label}</span>
                        {genCount > 0 && (
                          <Badge
                            variant="accent"
                            className="text-[9px] px-1.5 py-0.5 ml-auto"
                            aria-label={`${genCount} episode${genCount > 1 ? 's' : ''} generating`}
                          >
                            {genCount}
                          </Badge>
                        )}
                      </>
                    )}
                    {collapsed && genCount > 0 && (
                      <span
                        className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent"
                        aria-label={`${genCount} episode${genCount > 1 ? 's' : ''} generating`}
                      />
                    )}
                  </>
                )}
              </NavLink>
            );
          }
          return <SidebarLink key={item.to} item={item} collapsed={collapsed} />;
        })}

        {/* Publish — always visible */}
        <SectionHeader label="Publish" icon={Send} collapsed={collapsed} />
        {NAV_PUBLISH.map((item) => (
          <SidebarLink key={item.to} item={item} collapsed={collapsed} />
        ))}

        {/* System */}
        <SectionHeader label="System" icon={Settings} collapsed={collapsed} />
        {NAV_SYSTEM.map((item) => (
          <SidebarLink key={item.to} item={item} collapsed={collapsed} />
        ))}

        {/* Help & About (no header) */}
        <div className="my-1 border-t border-border/50" />
        {NAV_BOTTOM.map((item) => (
          <SidebarLink key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>

      {/* Theme picker */}
      <div className="border-t border-white/[0.06] px-2 py-2 shrink-0">
        {/* Dark/Light toggle */}
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between px-1'} mb-2`}>
          {!collapsed && (
            <span className="text-[10px] font-display font-medium text-txt-tertiary uppercase tracking-wider">Theme</span>
          )}
          <Tooltip content={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <button
              onClick={toggleMode}
              className="flex items-center justify-center w-7 h-7 rounded-md text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.04] transition-colors"
              aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
            >
              {mode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </Tooltip>
        </div>

        {/* Accent color dots */}
        <div className={`flex ${collapsed ? 'flex-col items-center' : 'flex-wrap justify-center'} gap-1.5`}>
          {ACCENT_COLORS.map((color) => (
            <Tooltip key={color.id} content={color.name}>
              <button
                onClick={() => setAccentId(color.id)}
                className={[
                  'w-5 h-5 rounded-full transition-all duration-fast',
                  'hover:scale-110',
                  accentId === color.id
                    ? 'scale-110'
                    : 'opacity-60 hover:opacity-100',
                ].join(' ')}
                style={{
                  backgroundColor: mode === 'dark' ? color.dark : color.light,
                  boxShadow: accentId === color.id
                    ? `0 0 0 2px var(--color-bg-surface), 0 0 0 4px ${mode === 'dark' ? color.dark : color.light}`
                    : undefined,
                }}
                aria-label={`Set accent color to ${color.name}`}
                aria-pressed={accentId === color.id}
              />
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Collapse toggle */}
      <div className="border-t border-white/[0.06] p-2 shrink-0">
        <button
          onClick={onToggle}
          className={[
            'flex items-center justify-center w-full rounded-md py-2',
            'text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.04]',
            'transition-colors duration-fast',
          ].join(' ')}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRight size={16} />
          ) : (
            <>
              <ChevronLeft size={16} />
              <span className="ml-2 text-xs">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

export { Sidebar };
export type { SidebarProps };
