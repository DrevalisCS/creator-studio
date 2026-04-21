import { useState, useEffect } from 'react';
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

const STEP_COLORS: Record<string, string> = {
  script: 'bg-indigo-500',
  voice: 'bg-pink-500',
  scenes: 'bg-teal-500',
  captions: 'bg-amber-500',
  assembly: 'bg-blue-500',
  thumbnail: 'bg-purple-500',
  tts: 'bg-pink-500',
  llm: 'bg-indigo-500',
};

const STEP_TEXT_COLORS: Record<string, string> = {
  script: 'text-indigo-400',
  voice: 'text-pink-400',
  scenes: 'text-teal-400',
  captions: 'text-amber-400',
  assembly: 'text-blue-400',
  thumbnail: 'text-purple-400',
  tts: 'text-pink-400',
  llm: 'text-indigo-400',
};

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
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [workerHealth, setWorkerHealth] = useState<WorkerHealth | null>(null);
  const [restartingWorker, setRestartingWorker] = useState(false);
  const [priority, setPriority] = useState<PriorityMode>(() => {
    const stored = localStorage.getItem(PRIORITY_STORAGE_KEY);
    return (stored as PriorityMode | null) ?? 'shorts_first';
  });

  // Live WebSocket progress updates for all active jobs. `connected`
  // surfaces the pubsub link health — users otherwise see stale
  // progress with no hint that reconnection is in flight.
  const { latestByEpisode, connected: wsConnected } = useActiveJobsProgress();

  // Poll unified tasks endpoint + queue status every 3s
  useEffect(() => {
    let mounted = true;

    const poll = async () => {
      try {
        const [tasksRes, statusData] = await Promise.all([
          jobsApi.tasksActive(),
          jobsApi.status(),
        ]);
        if (!mounted) return;

        const mapped: BackgroundTask[] = (tasksRes.tasks ?? []).map((t: any) => {
          const ws = latestByEpisode[t.id];
          const wsProgress = ws
            ? Object.values(ws).reduce(
                (best, msg) =>
                  msg.progress_pct > (best?.progress_pct ?? -1) ? msg : best,
                Object.values(ws)[0],
              )
            : null;
          return {
            type: t.type ?? 'episode_generation',
            id: t.id,
            title: t.title ?? 'Untitled',
            step: wsProgress?.step ?? t.step ?? 'script',
            status: t.status ?? 'running',
            progress: wsProgress?.progress_pct ?? t.progress ?? -1,
            url: t.url ?? `/episodes/${t.id}`,
          };
        });

        setTasks(mapped);
        setQueueStatus({
          active: statusData.generating_episodes ?? 0,
          queued: statusData.queued ?? 0,
          max_concurrent: statusData.max_concurrent ?? 4,
          slots_available: statusData.slots_available ?? 0,
          total_failed_episodes: statusData.total_failed_episodes ?? 0,
        });
      } catch {
        // ignore
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [latestByEpisode]);

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

  // Poll worker health every 30s
  useEffect(() => {
    const poll = () => {
      jobsApi
        .workerHealth()
        .then(setWorkerHealth)
        .catch(() =>
          setWorkerHealth({ alive: false, last_heartbeat: null, generating_count: 0 }),
        );
    };
    poll();
    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
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
      setTimeout(() => {
        void jobsApi
          .workerHealth()
          .then(setWorkerHealth)
          .catch(() =>
            setWorkerHealth({ alive: false, last_heartbeat: null, generating_count: 0 }),
          );
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

    {/* ── Desktop: docked bottom bar (hidden on mobile) ────────────── */}
    <div className="hidden md:block fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.06] bg-bg-surface/70 backdrop-blur-xl">
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
                            className={`text-[9px] flex-shrink-0 ${STEP_TEXT_COLORS[task.step] ?? 'text-txt-secondary'}`}
                          >
                            {task.step}
                          </Badge>

                          {/* Progress bar */}
                          <div className="flex-1 min-w-[80px] max-w-[200px]">
                            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                              {isIndeterminate ? (
                                <div
                                  className={`h-full rounded-full animate-pulse w-1/2 ${STEP_COLORS[task.step] || 'bg-accent'}`}
                                />
                              ) : (
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${STEP_COLORS[task.step] || 'bg-accent'}`}
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

      {/* Status strip (always visible) */}
      <div
        className="flex items-center justify-between px-4 h-8 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
        role="button"
        aria-expanded={expanded}
        aria-label="Toggle activity monitor"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Activity size={12} className="text-accent" />
            <span className="text-[11px] font-display font-medium text-txt-primary">Activity</span>
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

          {/* Queue info */}
          {queueStatus && (
            <span className="text-[10px] text-txt-tertiary">
              {queueStatus.active}/{queueStatus.max_concurrent} slots
              {queueStatus.queued > 0 && ` · ${queueStatus.queued} queued`}
            </span>
          )}

          {/* Priority mode */}
          <span className="text-[10px] text-txt-tertiary">
            · {PRIORITY_LABELS[priority]}
          </span>

          {/* Active task summary */}
          {totalActive > 0 && (
            <div className="flex items-center gap-1.5 ml-2">
              {tasks.slice(0, 3).map((task) => (
                <div key={task.id} className="flex items-center gap-1">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${STEP_COLORS[task.step] || 'bg-accent'}`}
                  />
                  <span className="text-[10px] text-txt-secondary truncate max-w-[120px]">
                    {task.title.length > 20 ? task.title.slice(0, 20) + '...' : task.title}
                  </span>
                </div>
              ))}
              {totalActive > 3 && (
                <span className="text-[10px] text-txt-tertiary">+{totalActive - 3}</span>
              )}
            </div>
          )}
        </div>

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
      </div>
    </div>
    </>
  );
}
