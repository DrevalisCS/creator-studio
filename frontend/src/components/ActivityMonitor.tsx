import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ChevronUp,
  ChevronDown,
  Square,
  Mic,
  Play,
  Sparkles,
  Trash2,
  RefreshCw,
  ListOrdered,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { LiveStatus } from '@/components/ui/LiveStatus';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { jobs as jobsApi, episodes as episodesApi } from '@/lib/api';
import { useActiveJobsProgress } from '@/lib/websocket';
import { useTheme } from '@/lib/theme';
import { STEP_BG, STEP_TEXT, isKnownStep, type StepName } from '@/lib/stepColors';
import { useActiveTasks, useJobsStatus, useWorkerHealth, queryKeys } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackgroundTask {
  type: 'episode_generation' | 'audiobook_generation' | 'script_generation';
  id: string;
  title: string;
  step: string;
  status: string;
  progress: number; // -1 = indeterminate
  url: string;
}

interface QueueStatus {
  active: number;
  queued: number;
  max_concurrent: number;
  slots_available: number;
  total_failed_episodes: number;
}

type PriorityMode = 'shorts_first' | 'longform_first' | 'fifo';

const PRIORITY_OPTIONS: { value: PriorityMode; label: string }[] = [
  { value: 'shorts_first', label: 'Shorts First' },
  { value: 'longform_first', label: 'Longform First' },
  { value: 'fifo', label: 'Default (FIFO)' },
];

const PRIORITY_LABELS: Record<PriorityMode, string> = {
  shorts_first: 'Shorts First',
  longform_first: 'Longform First',
  fifo: 'FIFO',
};

const PRIORITY_STORAGE_KEY = 'sf_job_priority';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Step palette is owned by ``lib/stepColors.ts`` (canonical theme-aware
// classes). Background-task ``step`` strings can also be the worker
// aliases ``tts`` (audiobook voice) and ``llm`` (script) which aren't
// in the canonical six — we map them to their pipeline equivalent so
// they pick up the same theme colour.
const STEP_ALIASES: Record<string, StepName> = {
  tts: 'voice',
  llm: 'script',
};

function stepBg(step: string): string {
  if (isKnownStep(step)) return STEP_BG[step];
  const aliased = STEP_ALIASES[step];
  return aliased ? STEP_BG[aliased] : 'bg-accent';
}

function stepText(step: string): string {
  if (isKnownStep(step)) return STEP_TEXT[step];
  const aliased = STEP_ALIASES[step];
  return aliased ? STEP_TEXT[aliased] : 'text-txt-secondary';
}

const TASK_ICONS: Record<string, typeof Play> = {
  episode_generation: Play,
  audiobook_generation: Mic,
  script_generation: Sparkles,
};

// ---------------------------------------------------------------------------
// Worker health type
// ---------------------------------------------------------------------------

interface WorkerHealth {
  alive: boolean;
  last_heartbeat: string | null;
  generating_count: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActivityMonitor() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { activityDock } = useTheme();
  const isVerticalDock = activityDock === 'left' || activityDock === 'right';
  // v0.20.5: left / right rails are now ALSO retractable. The rail
  // collapses to a 40px strip showing just the Activity icon + count,
  // click anywhere on the collapsed strip to pop it back out. Default
  // for vertical docks is expanded, default for horizontal is collapsed.
  const [userExpanded, setUserExpanded] = useState<boolean>(() => {
    // One-time init only — we honor whatever the user had on the
    // previous render so switching dock position doesn't flip their
    // preference.
    return false;
  });
  const expanded = userExpanded;
  const setExpanded = (v: boolean) => setUserExpanded(v);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [restartingWorker, setRestartingWorker] = useState(false);
  const [priority, setPriority] = useState<PriorityMode>(() => {
    const stored = localStorage.getItem(PRIORITY_STORAGE_KEY);
    return (stored as PriorityMode | null) ?? 'shorts_first';
  });

  // Live WebSocket progress updates for all active jobs. `connected`
  // surfaces the pubsub link health — users otherwise see stale
  // progress with no hint that reconnection is in flight.
  const { latestByEpisode, connected: wsConnected } = useActiveJobsProgress();

  // Phase 3.3 + 3.4: tasks list + queue status migrated to React Query.
  // Polling is conditional on the WebSocket reporting active jobs:
  // the rail polls at 5s while jobs are running, drops to no-poll
  // when idle, and pauses entirely when the tab is hidden.
  const hasActive = Object.keys(latestByEpisode).length > 0;
  const tasksQ = useActiveTasks({ hasActive });
  const statusQ = useJobsStatus({ hasActive });
  const workerHealthQ = useWorkerHealth();
  const qc = useQueryClient();

  // Tasks come from the API as a partial shape; merge with the WS
  // ``latestByEpisode`` map so progress + step come from whichever
  // source is fresher (WS for running jobs, API for queued).
  const tasks: BackgroundTask[] = useMemo(() => {
    const apiTasks = tasksQ.data?.tasks ?? [];
    return apiTasks.map((t: { type?: string; id: string; title?: string; step?: string; status?: string; progress?: number; url?: string }) => {
      const ws = latestByEpisode[t.id];
      const wsProgress = ws
        ? Object.values(ws).reduce(
            (best, msg) =>
              msg.progress_pct > (best?.progress_pct ?? -1) ? msg : best,
            Object.values(ws)[0],
          )
        : null;
      return {
        type: (t.type as BackgroundTask['type']) ?? 'episode_generation',
        id: t.id,
        title: t.title ?? 'Untitled',
        step: wsProgress?.step ?? t.step ?? 'script',
        status: t.status ?? 'running',
        progress: wsProgress?.progress_pct ?? t.progress ?? -1,
        url: t.url ?? `/episodes/${t.id}`,
      };
    });
  }, [tasksQ.data, latestByEpisode]);

  const queueStatus: QueueStatus | null = useMemo(() => {
    const s = statusQ.data;
    if (!s) return null;
    return {
      active: s.generating_episodes ?? 0,
      queued: s.queued ?? 0,
      max_concurrent: s.max_concurrent ?? 4,
      slots_available: s.slots_available ?? 0,
      total_failed_episodes: s.total_failed_episodes ?? 0,
    };
  }, [statusQ.data]);

  const workerHealth: WorkerHealth | null = workerHealthQ.data
    ? workerHealthQ.data
    : workerHealthQ.isError
      ? { alive: false, last_heartbeat: null, generating_count: 0 }
      : null;

  const refetchAll = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
  };

  // Load priority from backend on mount
  useEffect(() => {
    jobsApi.getPriority()
      .then((d) => {
        const mode = d.mode as PriorityMode;
        if (['shorts_first', 'longform_first', 'fifo'].includes(mode)) {
          setPriority(mode);
          localStorage.setItem(PRIORITY_STORAGE_KEY, mode);
        }
      })
      .catch(() => {});
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────

  const handleCancel = async (task: BackgroundTask) => {
    setCancelling((prev) => new Set(prev).add(task.id));
    try {
      if (task.type === 'episode_generation') await episodesApi.cancel(task.id);
      toast.success('Job cancelled');
    } catch (err) {
      toast.error('Failed to cancel job', { description: String(err) });
    } finally {
      setCancelling((prev) => {
        const n = new Set(prev);
        n.delete(task.id);
        return n;
      });
    }
  };

  const handleRestartWorker = async () => {
    setRestartingWorker(true);
    try {
      await jobsApi.restartWorker();
      toast.info('Worker restart signal sent');
      // Re-poll worker health after the restart settles. ``refetchAll``
      // also covers tasks + status, which the next interval tick would
      // pick up anyway, but invalidating now feels snappier.
      setTimeout(() => {
        refetchAll();
      }, 3000);
    } catch (err) {
      toast.error('Failed to restart worker', { description: String(err) });
    } finally {
      setRestartingWorker(false);
    }
  };

  const handlePriorityChange = (next: PriorityMode) => {
    setPriority(next);
    localStorage.setItem(PRIORITY_STORAGE_KEY, next);
    void jobsApi.setPriority(next);
  };

  const totalActive = tasks.length;
  const failedCount = queueStatus?.total_failed_episodes ?? 0;
  const workerAlive = workerHealth?.alive ?? null;

  // ── Render: Docked bottom bar ──────────────────────────────────────

  return (
    <>
      {/* ── Mobile: floating pill above the mobile nav bar ───────────── */}
      {totalActive > 0 && (
        <button
          onClick={() => navigate('/jobs')}
          className={[
            'fixed z-[98] md:hidden',
            'bottom-[76px] right-4',
            'flex items-center gap-2',
            'bg-bg-elevated/90 backdrop-blur-xl border border-white/[0.1] shadow-glass rounded-full px-3 py-1.5',
            'text-xs font-medium text-txt-primary',
            'transition-colors duration-fast hover:bg-white/[0.04]',
          ].join(' ')}
          aria-label={`${totalActive} active job${totalActive > 1 ? 's' : ''} — tap to view`}
        >
          <Spinner size="sm" />
          <span>{totalActive} active</span>
        </button>
      )}

    {/* ── Desktop: position-aware docked bar (hidden on mobile) ─────
         Position from ``activityDock`` (Settings → Appearance):
         bottom/top = horizontal tray, collapsible
         left/right = vertical rail; expanded = 320px, collapsed = 40px
         rail with just Activity icon + count. Click strip to toggle. */}
    <div
      className={[
        'hidden md:block fixed z-40 bg-bg-surface/90 backdrop-blur-xl',
        'border-white/[0.08] shadow-[0_8px_32px_-8px_rgba(0,0,0,0.55)]',
        'transition-[width,height] duration-200 ease-out',
        activityDock === 'bottom' ? 'bottom-0 left-0 right-0 border-t' : '',
        activityDock === 'top' ? 'top-0 left-0 right-0 border-b' : '',
        activityDock === 'left'
          ? `top-0 bottom-0 left-0 border-r flex flex-col ${expanded ? 'w-[320px]' : 'w-[44px]'}`
          : '',
        activityDock === 'right'
          ? `top-0 bottom-0 right-0 border-l flex flex-col ${expanded ? 'w-[320px]' : 'w-[44px]'}`
          : '',
      ].join(' ')}
      data-dock={activityDock}
      data-expanded={expanded}
    >
      {/* Expanded panel */}
      {expanded && (
        <div className="border-b border-border">
          <div className="flex divide-x divide-border" style={{ maxHeight: '260px' }}>
            {/* ── Left: Active task list ────────────────────────────── */}
            <div className="flex-1 overflow-y-auto">
              {totalActive === 0 ? (
                <div className="p-4 text-center text-xs text-txt-tertiary h-full flex items-center justify-center">
                  No active jobs
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {tasks.map((task) => {
                    const Icon = TASK_ICONS[task.type] || Play;
                    const isIndeterminate = task.progress < 0;

                    return (
                      <div
                        key={`${task.type}-${task.id}`}
                        className="px-4 py-2 group hover:bg-white/[0.04] transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          {/* Icon */}
                          <Icon size={12} className="text-accent flex-shrink-0" />

                          {/* Title + Step */}
                          <button
                            onClick={() => navigate(task.url)}
                            className="text-xs font-medium text-txt-primary hover:text-accent truncate max-w-[200px] text-left"
                          >
                            {task.title}
                          </button>

                          <Badge
                            variant="neutral"
                            className={`text-[9px] flex-shrink-0 ${stepText(task.step)}`}
                          >
                            {task.step}
                          </Badge>

                          {/* Progress bar */}
                          <div className="flex-1 min-w-[80px] max-w-[200px]">
                            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                              {isIndeterminate ? (
                                <div
                                  className={`h-full rounded-full animate-pulse w-1/2 ${stepBg(task.step)}`}
                                />
                              ) : (
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${stepBg(task.step)}`}
                                  style={{ width: `${task.progress}%` }}
                                />
                              )}
                            </div>
                          </div>

                          {/* Progress text */}
                          {isIndeterminate ? (
                            <Spinner size="sm" />
                          ) : (
                            <span className="text-[10px] text-txt-tertiary w-8 text-right flex-shrink-0">
                              {task.progress}%
                            </span>
                          )}

                          {/* Cancel */}
                          {task.type === 'episode_generation' && (
                            <Tooltip content="Cancel this job">
                              <button
                                onClick={() => void handleCancel(task)}
                                disabled={cancelling.has(task.id)}
                                className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition flex-shrink-0"
                                aria-label={`Cancel ${task.title}`}
                              >
                                <Square size={10} />
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Right: Controls ──────────────────────────────────── */}
            <div className="w-64 flex-shrink-0 bg-bg-elevated/50 flex flex-col justify-between p-3 gap-3">
              {/* Worker health row */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        'w-2 h-2 rounded-full flex-shrink-0',
                        workerAlive === null
                          ? 'bg-txt-tertiary'
                          : workerAlive
                          ? 'bg-green-500'
                          : 'bg-red-500 animate-pulse',
                      ].join(' ')}
                      aria-hidden="true"
                    />
                    <span
                      className={[
                        'text-xs font-medium',
                        workerAlive === null
                          ? 'text-txt-tertiary'
                          : workerAlive
                          ? 'text-green-400'
                          : 'text-red-400',
                      ].join(' ')}
                    >
                      Worker:{' '}
                      {workerAlive === null ? 'Unknown' : workerAlive ? 'Active' : 'Down'}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={[
                      'text-[10px] h-6 px-2',
                      workerAlive === false
                        ? 'text-amber-400 hover:text-amber-300'
                        : 'text-txt-tertiary hover:text-txt-secondary',
                    ].join(' ')}
                    onClick={() => void handleRestartWorker()}
                    disabled={restartingWorker}
                    aria-label="Restart worker process"
                  >
                    {restartingWorker ? (
                      <Spinner size="sm" />
                    ) : (
                      <RefreshCw size={10} />
                    )}
                    Restart
                  </Button>
                </div>

                {/* Live-progress WebSocket status */}
                <div className="flex items-center justify-between text-[10px] text-txt-tertiary">
                  <span>Progress stream</span>
                  <LiveStatus connected={wsConnected} />
                </div>

                {/* Divider */}
                <div className="border-t border-border" />

                {/* Action buttons */}
                <div className="flex flex-wrap gap-1.5">
                  {failedCount > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-green-400 text-[10px] h-6 px-2"
                      onClick={() => {
                        jobsApi.retryAllFailed()
                          .then(() => toast.success(`Retrying ${failedCount} failed jobs`))
                          .catch((e) => toast.error('Retry failed', { description: String(e) }));
                      }}
                      aria-label={`Retry ${failedCount} failed jobs`}
                    >
                      <Play size={9} />
                      Retry Failed ({failedCount})
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-amber-400 text-[10px] h-6 px-2"
                    onClick={() => {
                      jobsApi.pauseAll()
                        .then(() => toast.info('Queue paused'))
                        .catch((e) => toast.error('Pause failed', { description: String(e) }));
                    }}
                    aria-label="Pause all running jobs"
                  >
                    <Square size={9} />
                    Pause All
                  </Button>
                  {totalActive > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400 text-[10px] h-6 px-2"
                      onClick={() => {
                        jobsApi.cancelAll()
                          .then(() => toast.warning('All jobs cancelled'))
                          .catch((e) => toast.error('Cancel failed', { description: String(e) }));
                      }}
                      aria-label="Cancel all running jobs"
                    >
                      <Square size={9} />
                      Cancel All
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-txt-tertiary text-[10px] h-6 px-2"
                    onClick={() => {
                      jobsApi.cleanup()
                        .then(() => toast.success('Cleanup complete'))
                        .catch((e) => toast.error('Cleanup failed', { description: String(e) }));
                    }}
                    aria-label="Clean up stale job records"
                  >
                    <Trash2 size={9} />
                    Cleanup
                  </Button>
                </div>
              </div>

              {/* Priority selector */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <ListOrdered size={10} className="text-txt-tertiary" />
                  <span className="text-[10px] text-txt-tertiary font-medium uppercase tracking-wider">
                    Priority
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handlePriorityChange(opt.value)}
                      className={[
                        'text-left text-[10px] px-2 py-1 rounded transition-colors',
                        priority === opt.value
                          ? 'bg-accent/15 text-accent font-medium'
                          : 'text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.04]',
                      ].join(' ')}
                      aria-pressed={priority === opt.value}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status strip (always visible on horizontal docks; hidden on
          vertical rails since those are always-expanded). v0.20.3:
          taller + higher-contrast so it stops reading as a faint line
          at the edge of the screen. */}
      <div
        className={[
          'flex items-center select-none cursor-pointer transition-colors',
          isVerticalDock
            ? expanded
              ? 'h-11 px-4 border-b border-border/60 justify-between'
              : 'flex-col h-full w-full py-3 gap-3 justify-start hover:bg-white/[0.03]'
            : 'h-10 px-4 justify-between',
          totalActive > 0 ? 'bg-accent-muted/20' : '',
        ].join(' ')}
        onClick={() => setExpanded(!expanded)}
        role="button"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse activity monitor' : 'Expand activity monitor'}
      >
        <div
          className={
            isVerticalDock && !expanded
              ? 'flex flex-col items-center gap-2'
              : 'flex items-center gap-3'
          }
        >
          <div
            className={
              isVerticalDock && !expanded
                ? 'flex flex-col items-center gap-1.5'
                : 'flex items-center gap-2'
            }
          >
            <Activity size={isVerticalDock && !expanded ? 18 : 14} className="text-accent" />
            {(!isVerticalDock || expanded) && (
              <span className="text-xs font-display font-semibold text-txt-primary">
                Activity
              </span>
            )}
            {totalActive > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-accent text-[10px] font-bold text-bg-base">
                {totalActive}
              </span>
            )}
          </div>

          {/* Worker status dot */}
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              workerAlive === null
                ? 'bg-txt-tertiary'
                : workerAlive
                ? 'bg-green-500'
                : 'bg-red-500 animate-pulse'
            }`}
            aria-hidden="true"
          />

          {/* Everything beyond the core (Activity + count) is hidden
              on a collapsed vertical rail — not enough horizontal
              room to render legibly. */}
          {(!isVerticalDock || expanded) && (
            <>
              {queueStatus && (
                <span className="text-[10px] text-txt-tertiary">
                  {queueStatus.active}/{queueStatus.max_concurrent} slots
                  {queueStatus.queued > 0 && ` · ${queueStatus.queued} queued`}
                </span>
              )}
              <span className="text-[10px] text-txt-tertiary">
                · {PRIORITY_LABELS[priority]}
              </span>
              {totalActive > 0 && (
                <div className="flex items-center gap-1.5 ml-2">
                  {tasks.slice(0, 3).map((task) => (
                    <div key={task.id} className="flex items-center gap-1">
                      <div
                        className={`w-1.5 h-1.5 rounded-full ${stepBg(task.step)}`}
                      />
                      <span className="text-[10px] text-txt-secondary truncate max-w-[120px]">
                        {task.title.length > 20
                          ? task.title.slice(0, 20) + '...'
                          : task.title}
                      </span>
                    </div>
                  ))}
                  {totalActive > 3 && (
                    <span className="text-[10px] text-txt-tertiary">
                      +{totalActive - 3}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {(!isVerticalDock || expanded) && (
          <div className="flex items-center gap-2">
            {totalActive > 0 && (
              <Badge variant="accent" className="text-[9px]">
                {totalActive} active
              </Badge>
            )}
            {expanded ? (
              <ChevronDown size={12} className="text-txt-tertiary" />
            ) : (
              <ChevronUp size={12} className="text-txt-tertiary" />
            )}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
