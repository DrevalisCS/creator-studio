/**
 * Appearance section — dark/light mode, accent color, activity-monitor dock.
 *
 * Controls that previously lived in the Sidebar (theme + accent picker)
 * were moved here in v0.20.3 so the navigation surface stays narrowly
 * workflow-focused. The activity-dock position is new: the monitor can
 * now sit at the bottom (classic), top, left, or right.
 */

import { Sun, Moon, PanelBottom, PanelTop, PanelLeft, PanelRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useTheme, ACCENT_COLORS, type ActivityDockPosition } from '@/lib/theme';

const DOCK_OPTIONS: Array<{
  id: ActivityDockPosition;
  label: string;
  icon: typeof PanelBottom;
  help: string;
}> = [
  {
    id: 'bottom',
    label: 'Bottom',
    icon: PanelBottom,
    help: 'Classic task-bar strip across the bottom of the screen.',
  },
  {
    id: 'top',
    label: 'Top',
    icon: PanelTop,
    help: 'Pinned to the top of the viewport, above the header.',
  },
  {
    id: 'left',
    label: 'Left rail',
    icon: PanelLeft,
    help: 'Full-height rail on the left side — always expanded.',
  },
  {
    id: 'right',
    label: 'Right rail',
    icon: PanelRight,
    help: 'Full-height rail on the right side — always expanded.',
  },
];

export function AppearanceSection() {
  const { mode, toggleMode, accentId, setAccentId, activityDock, setActivityDock } = useTheme();

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-txt-primary">Appearance</h3>
        <p className="text-xs text-txt-secondary mt-1">
          Theme, accent color, and Activity Monitor position. Preferences are stored in
          this browser only.
        </p>
      </div>

      {/* ── Mode (dark / light) ─────────────────────────────────── */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-txt-primary">Color mode</h4>
            <p className="text-xs text-txt-secondary mt-1">
              {mode === 'dark'
                ? 'Currently dark — easier on the eyes for long editing sessions.'
                : 'Currently light — high contrast for bright studios.'}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleMode}
            className="flex items-center gap-2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm font-medium text-txt-primary hover:bg-bg-hover transition-colors"
            aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
          >
            {mode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {mode === 'dark' ? 'Switch to light' : 'Switch to dark'}
          </button>
        </div>
      </Card>

      {/* ── Accent color ─────────────────────────────────────────── */}
      <Card className="p-5">
        <h4 className="text-sm font-semibold text-txt-primary">Accent color</h4>
        <p className="text-xs text-txt-secondary mt-1 mb-4">
          Applies across buttons, links, focus rings, and progress bars.
        </p>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_COLORS.map((color) => {
            const isActive = accentId === color.id;
            const swatch = mode === 'dark' ? color.dark : color.light;
            return (
              <button
                key={color.id}
                type="button"
                onClick={() => setAccentId(color.id)}
                className={[
                  'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all',
                  isActive
                    ? 'border-accent text-txt-primary bg-accent-muted'
                    : 'border-border text-txt-secondary hover:border-border-strong',
                ].join(' ')}
                aria-pressed={isActive}
              >
                <span
                  className="inline-block w-3 h-3 rounded-full"
                  style={{ backgroundColor: swatch }}
                />
                {color.name}
              </button>
            );
          })}
        </div>
      </Card>

      {/* ── Activity Monitor dock ─────────────────────────────────── */}
      <Card className="p-5">
        <h4 className="text-sm font-semibold text-txt-primary">Activity Monitor position</h4>
        <p className="text-xs text-txt-secondary mt-1 mb-4">
          Where the background-jobs bar lives. Top/bottom show a compact tray;
          left/right show a full-height rail (always expanded).
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {DOCK_OPTIONS.map((opt) => {
            const isActive = activityDock === opt.id;
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setActivityDock(opt.id)}
                className={[
                  'flex flex-col items-center gap-2 rounded-md border px-3 py-3 text-xs font-medium transition-all text-left',
                  isActive
                    ? 'border-accent bg-accent-muted text-txt-primary'
                    : 'border-border bg-bg-elevated text-txt-secondary hover:border-border-strong',
                ].join(' ')}
                aria-pressed={isActive}
              >
                <Icon size={18} className={isActive ? 'text-accent' : 'text-txt-tertiary'} />
                <span className="text-txt-primary">{opt.label}</span>
                <span className="text-[11px] text-txt-muted leading-snug">{opt.help}</span>
              </button>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

export default AppearanceSection;
