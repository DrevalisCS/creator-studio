import type { ReactNode } from 'react';
import type { EpisodeStatus, JobStatus } from '@/types';

// ---------------------------------------------------------------------------
// Variant map
// ---------------------------------------------------------------------------

const statusVariants: Record<string, string> = {
  // Episode statuses
  draft: 'bg-bg-hover text-txt-secondary',
  generating: 'bg-accent-muted text-accent',
  review: 'bg-info-muted text-info',
  editing: 'bg-warning-muted text-warning',
  exported: 'bg-success-muted text-success',
  failed: 'bg-error-muted text-error',

  // Job statuses
  queued: 'bg-bg-hover text-txt-secondary',
  running: 'bg-accent-muted text-accent',
  done: 'bg-success-muted text-success',

  // Pipeline step colors
  script: 'bg-step-muted-script text-step-script',
  voice: 'bg-step-muted-voice text-step-voice',
  scenes: 'bg-step-muted-scenes text-step-scenes',
  captions: 'bg-step-muted-captions text-step-captions',
  assembly: 'bg-step-muted-assembly text-step-assembly',
  thumbnail: 'bg-step-muted-thumbnail text-step-thumbnail',

  // Service health
  ok: 'bg-success-muted text-success',
  degraded: 'bg-warning-muted text-warning',
  unreachable: 'bg-error-muted text-error',
  unhealthy: 'bg-error-muted text-error',

  // Generic
  info: 'bg-info-muted text-info',
  success: 'bg-success-muted text-success',
  warning: 'bg-warning-muted text-warning',
  error: 'bg-error-muted text-error',
  accent: 'bg-accent-muted text-accent',
  neutral: 'bg-bg-hover text-txt-secondary',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BadgeProps {
  variant?: EpisodeStatus | JobStatus | string;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Badge({ variant = 'neutral', children, className = '', dot = false }: BadgeProps) {
  const colors = statusVariants[variant] ?? statusVariants['neutral']!;

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5',
        'text-[11px] font-medium leading-4 tracking-wide',
        'rounded-full whitespace-nowrap',
        'border border-current/10',
        // Pulse animation for active statuses
        (variant === 'generating' || variant === 'running') ? 'status-pulse' : '',
        colors,
        className,
      ].filter(Boolean).join(' ')}
    >
      {dot && (
        <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
      )}
      {children}
    </span>
  );
}

export { Badge };
export type { BadgeProps };
