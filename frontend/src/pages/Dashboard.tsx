import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Film,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  LayoutList,
  Plus,
  TrendingUp,
  CalendarDays,
  Clapperboard,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { SetupChecklist } from '@/components/SetupChecklist';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { EpisodeCard } from '@/components/episodes/EpisodeCard';
import { JobProgressBar } from '@/components/jobs/JobProgressBar';
import { EmptyState } from '@/components/ui/EmptyState';
import { SystemHealthCard } from '@/components/SystemHealthCard';
import { StatCard } from '@/components/ui/StatCard';
import { QuickActionTile } from '@/components/ui/QuickActionTile';
import { useToast } from '@/components/ui/Toast';
import { ApiError, formatError } from '@/lib/api';
import { useActiveJobsProgress } from '@/lib/websocket';
import {
  useActiveJobs,
  useEpisodes,
  useRecentEpisodes,
  useSeries,
} from '@/lib/queries';
import type { EpisodeListItem, GenerationJobListItem } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Recent Activity Item
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--color-txt-tertiary)',
  generating: 'var(--color-accent)',
  review: '#34D399',
  editing: '#FBBF24',
  exported: '#34D399',
  failed: '#F87171',
};

interface ActivityItemProps {
  episode: EpisodeListItem;
  seriesName: string | undefined;
  onClick: () => void;
}

function ActivityItem({ episode, seriesName, onClick }: ActivityItemProps) {
  const dotColor = STATUS_COLOR[episode.status] ?? 'var(--color-txt-tertiary)';
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.03] transition-all duration-normal text-left"
      aria-label={`View episode: ${episode.title}`}
    >
      {/* Status dot */}
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: dotColor }}
        aria-hidden="true"
      />

      {/* Title + series */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-display font-medium text-txt-primary truncate">
          {episode.title}
        </p>
        {seriesName && (
          <p className="text-xs text-txt-tertiary truncate">{seriesName}</p>
        )}
      </div>

      {/* Status badge */}
      <Badge variant={episode.status} className="shrink-0">
        {episode.status}
      </Badge>

      {/* Relative time */}
      <span className="text-xs text-txt-tertiary shrink-0 w-20 text-right">
        {timeAgo(episode.created_at)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

function Dashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();

  // --- WebSocket progress ---
  const { latestByEpisode } = useActiveJobsProgress();

  // --- Data via React Query (Phase 3.3) ---
  // Each hook owns its own snapshot cache + invalidation. Mutations
  // elsewhere (delete episode, generate, etc.) call ``invalidateQueries``
  // which triggers a refetch here automatically. ``activeJobs`` toggles
  // its 5s refetchInterval based on whether the WS reports any active
  // job (R6: list snapshots from Query, in-flight progress from WS).
  const recentQ = useRecentEpisodes(8);
  const activityQ = useRecentEpisodes(10);
  const seriesQ = useSeries();
  const allEpsQ = useEpisodes();
  const hasActive = Object.keys(latestByEpisode).length > 0;
  const activeJobsQ = useActiveJobs({ hasActive });

  const recentEpisodes: EpisodeListItem[] = recentQ.data ?? [];
  const activityEpisodes = activityQ.data ?? [];
  const seriesList = seriesQ.data ?? [];
  const activeJobs = activeJobsQ.data ?? [];
  const allEpisodes = allEpsQ.data ?? [];
  const loading =
    recentQ.isPending ||
    activityQ.isPending ||
    seriesQ.isPending ||
    allEpsQ.isPending;

  // Surface non-license fetch errors as a single toast burst — Query
  // gives us the error per hook; we collapse to one toast and reset
  // when the error clears, mirroring the previous "lastErrShown" gate.
  const lastErrShown = useRef(false);
  useEffect(() => {
    const err =
      recentQ.error ||
      activityQ.error ||
      seriesQ.error ||
      allEpsQ.error ||
      activeJobsQ.error;
    if (!err) {
      lastErrShown.current = false;
      return;
    }
    if (err instanceof ApiError && err.status === 402) return;
    if (!lastErrShown.current) {
      toast.error('Failed to load dashboard data', { description: formatError(err) });
      lastErrShown.current = true;
    }
  }, [
    recentQ.error,
    activityQ.error,
    seriesQ.error,
    allEpsQ.error,
    activeJobsQ.error,
    toast,
  ]);

  // --- Stats --- (memoised: WS messages re-render Dashboard at the
  // pipeline-progress cadence; without these the .filter walks the
  // full episode list every tick).
  const totalEpisodes = allEpisodes.length;
  const { completedCount, failedCount } = useMemo(() => {
    let completed = 0;
    let failed = 0;
    for (const e of allEpisodes) {
      if (e.status === 'review' || e.status === 'exported') completed += 1;
      else if (e.status === 'failed') failed += 1;
    }
    return { completedCount: completed, failedCount: failed };
  }, [allEpisodes]);
  const totalSeries = seriesList.length;

  // --- Series lookup map for activity timeline ---
  const seriesById = useMemo(
    () => Object.fromEntries(seriesList.map((s) => [s.id, s.name])),
    [seriesList],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Onboarding checklist (self-hides when complete / dismissed) */}
      <SetupChecklist />

      {/* Runtime health pulse — only renders when something is degraded
          or unreachable, so it doesn't burn dashboard real estate when
          everything is fine. */}
      <SystemHealthCard />

      {/* Top row: 4 stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Episodes"
          value={totalEpisodes}
          icon={<Film size={20} />}
          color="#EDEDEF"
        />
        <StatCard
          label="Completed"
          value={completedCount}
          icon={<CheckCircle2 size={20} />}
          color="#34D399"
        />
        <StatCard
          label="Failed"
          value={failedCount}
          icon={<AlertTriangle size={20} />}
          color="#F87171"
        />
        <StatCard
          label="Total Series"
          value={totalSeries}
          icon={<Zap size={20} />}
          color="#00D4AA"
        />
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-xs font-display font-semibold text-txt-tertiary uppercase tracking-[0.15em] mb-3">
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <QuickActionTile
            icon={<Plus size={18} />}
            label="New Series"
            hint="Create a new series"
            accent="accent"
            onClick={() => navigate('/series')}
            ariaLabel="Create New Series"
          />
          <QuickActionTile
            icon={<TrendingUp size={18} />}
            label="Trending Topics"
            hint="Discover viral ideas"
            accent="success"
            onClick={() => {
              const firstSeries = seriesList[0];
              if (firstSeries) {
                navigate(`/series/${firstSeries.id}?tab=trending`);
              } else {
                navigate('/series');
              }
            }}
            ariaLabel="Generate Trending Topics"
          />
          <QuickActionTile
            icon={<CalendarDays size={18} />}
            label="Calendar"
            hint="Schedule content"
            accent="info"
            onClick={() => navigate('/calendar')}
            ariaLabel="View Content Calendar"
          />
          <QuickActionTile
            icon={<Clapperboard size={18} />}
            label="New from video"
            hint="Upload → pick clip → edit"
            accent="warning"
            onClick={() => navigate('/assets?ingest=1')}
            ariaLabel="Create Short from uploaded video"
          />
        </div>
      </div>

      {/* Middle row: Recent Activity + Active Jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Recent Activity timeline */}
        <div className="lg:col-span-7">
          <Card padding="none">
            <CardHeader className="px-4 pt-4 pb-3">
              <CardTitle>
                <span className="flex items-center gap-2 font-display">
                  <LayoutList size={16} className="text-txt-secondary" />
                  Recent Activity
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-2 pb-3">
              {activityEpisodes.length === 0 ? (
                <EmptyState
                  icon={Film}
                  title="No episodes yet"
                  description="Create a series and generate your first episode."
                  action={
                    <Button size="sm" variant="primary" onClick={() => navigate('/series')}>
                      Create a series
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-0.5">
                  {activityEpisodes.map((ep) => (
                    <ActivityItem
                      key={ep.id}
                      episode={ep}
                      seriesName={seriesById[ep.series_id]}
                      onClick={() => navigate(`/episodes/${ep.id}`)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Active jobs */}
        <div className="lg:col-span-5">
          {activeJobs.length > 0 ? (
            <Card padding="md" className="h-full">
              <CardHeader>
                <CardTitle>
                  <span className="flex items-center gap-2 font-display">
                    <Loader2 size={16} className="animate-spin text-accent" />
                    Active Jobs ({activeJobs.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(
                    activeJobs.reduce<Record<string, GenerationJobListItem[]>>(
                      (acc, job) => {
                        const key = job.episode_id;
                        if (!acc[key]) acc[key] = [];
                        acc[key]!.push(job);
                        return acc;
                      },
                      {},
                    ),
                  ).map(([episodeId, epJobs]) => {
                    const wsProgress = latestByEpisode[episodeId] ?? {};
                    const apiProgress: Record<
                      string,
                      { status: string; progress_pct: number; message: string }
                    > = {};
                    for (const job of epJobs) {
                      apiProgress[job.step] = {
                        status: job.status,
                        progress_pct: job.progress_pct,
                        message: job.error_message ?? '',
                      };
                    }
                    const merged = { ...apiProgress };
                    for (const [step, msg] of Object.entries(wsProgress)) {
                      merged[step] = msg;
                    }

                    return (
                      <div
                        key={episodeId}
                        className="surface p-3 cursor-pointer hover:border-border-hover transition-colors"
                        onClick={() => navigate(`/episodes/${episodeId}`)}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-display font-medium text-txt-primary truncate">
                            Episode {episodeId.slice(0, 8)}...
                          </span>
                          <Badge variant="generating" dot>
                            generating
                          </Badge>
                        </div>
                        <JobProgressBar
                          stepProgress={
                            merged as Record<
                              string,
                              import('@/types').ProgressMessage
                            >
                          }
                          compact
                        />
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card padding="md" className="h-full flex flex-col items-center justify-center">
              <div className="text-center py-6">
                <CheckCircle2 size={28} className="text-txt-tertiary mx-auto mb-2" />
                <p className="text-sm font-display text-txt-secondary font-medium">All clear</p>
                <p className="text-xs text-txt-tertiary mt-0.5">No active jobs running</p>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Bottom: Recent Episodes grid */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-display font-semibold text-txt-primary tracking-tight">
            Recent Episodes
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/episodes')}
          >
            View All
          </Button>
        </div>

        {recentEpisodes.length === 0 ? (
          <EmptyState
            icon={Film}
            title="No episodes yet"
            description="Create a series and generate your first episode."
            action={
              <div className="flex gap-2 justify-center">
                <Button size="sm" variant="primary" onClick={() => navigate('/series')}>
                  Create a series
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate('/help')}>
                  Read the Help
                </Button>
              </div>
            }
          />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {recentEpisodes.map((ep) => (
              <EpisodeCard
                key={ep.id}
                episode={ep}
                stepProgress={latestByEpisode[ep.id]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
