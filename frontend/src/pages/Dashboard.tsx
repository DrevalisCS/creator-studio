import { useState, useEffect, useCallback, type ReactNode } from 'react';
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
  Settings,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { SetupChecklist } from '@/components/SetupChecklist';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { EpisodeCard } from '@/components/episodes/EpisodeCard';
import { JobProgressBar } from '@/components/jobs/JobProgressBar';
import { useToast } from '@/components/ui/Toast';
import {
  episodes as episodesApi,
  series as seriesApi,
  jobs as jobsApi,
  ApiError,
  formatError,
} from '@/lib/api';
import { useActiveJobsProgress } from '@/lib/websocket';
import type {
  EpisodeListItem,
  SeriesListItem,
  GenerationJobListItem,
} from '@/types';

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
// Stat Card
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: number;
  icon: ReactNode;
  color: string;
}

function StatCard({ label, value, icon, color }: StatCardProps) {
  return (
    <Card padding="md" className="edge-highlight">
      <div className="flex items-center gap-4">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 icon-hover"
          style={{ backgroundColor: `${color}12`, color }}
        >
          {icon}
        </div>
        <div>
          <p className="text-2xl font-display font-bold text-txt-primary tracking-tight">{value}</p>
          <p className="text-xs font-display font-medium text-txt-tertiary tracking-wide uppercase">{label}</p>
        </div>
      </div>
    </Card>
  );
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

  // --- Data state ---
  const [recentEpisodes, setRecentEpisodes] = useState<EpisodeListItem[]>([]);
  const [activityEpisodes, setActivityEpisodes] = useState<EpisodeListItem[]>([]);
  const [seriesList, setSeriesList] = useState<SeriesListItem[]>([]);
  const [activeJobs, setActiveJobs] = useState<GenerationJobListItem[]>([]);
  const [allEpisodes, setAllEpisodes] = useState<EpisodeListItem[]>([]);
  const [loading, setLoading] = useState(true);

  // --- WebSocket progress ---
  const { latestByEpisode } = useActiveJobsProgress();

  // --- Fetch data ---
  const fetchData = useCallback(async () => {
    try {
      const [recentRes, seriesRes, jobsRes, allEpsRes, activityRes] = await Promise.all([
        episodesApi.recent(8),
        seriesApi.list(),
        jobsApi.active(),
        episodesApi.list(),
        episodesApi.recent(10),
      ]);
      setRecentEpisodes(recentRes);
      setActivityEpisodes(activityRes);
      setSeriesList(seriesRes);
      setActiveJobs(jobsRes);
      setAllEpisodes(allEpsRes);
    } catch (err) {
      // 402 means the license gate rejected us — LicenseGate handles UI
      // flip to the activation wizard; no need to spam a toast for that.
      if (err instanceof ApiError && err.status === 402) {
        return;
      }
      toast.error('Failed to load dashboard data', { description: formatError(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Refresh active jobs periodically
  useEffect(() => {
    // Suppress duplicate toasts during extended outages — single toast
    // per failure burst, reset once a poll succeeds again.
    let lastErrShown = false;
    const interval = setInterval(async () => {
      try {
        const res = await jobsApi.active();
        setActiveJobs(res);
        lastErrShown = false;
      } catch (err) {
        // Silent on 402 — LicenseGate owns that state.
        if (err instanceof ApiError && err.status === 402) {
          return;
        }
        if (!lastErrShown) {
          toast.error('Failed to refresh active jobs', {
            description: formatError(err),
          });
          lastErrShown = true;
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [toast]);

  // --- Stats ---
  const totalEpisodes = allEpisodes.length;
  const completedCount = allEpisodes.filter(
    (e) => e.status === 'review' || e.status === 'exported',
  ).length;
  const failedCount = allEpisodes.filter((e) => e.status === 'failed').length;
  const totalSeries = seriesList.length;

  // --- Series lookup map for activity timeline ---
  const seriesById = Object.fromEntries(seriesList.map((s) => [s.id, s.name]));

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
          <button
            onClick={() => navigate('/series')}
            className="flex flex-col items-center gap-2 p-4 bg-bg-surface/60 backdrop-blur-sm border border-white/[0.04] rounded-xl text-center transition-all duration-normal hover:bg-bg-surface/80 hover:border-white/[0.08] hover:shadow-card-hover group"
            aria-label="Create New Series"
          >
            <div className="w-10 h-10 rounded-xl bg-accent/[0.08] flex items-center justify-center icon-hover">
              <Plus size={18} className="text-accent" />
            </div>
            <span className="text-sm font-display font-medium text-txt-primary">New Series</span>
            <span className="text-xs text-txt-tertiary">Create a new series</span>
          </button>
          <button
            onClick={() => {
              const firstSeries = seriesList[0];
              if (firstSeries) {
                navigate(`/series/${firstSeries.id}?tab=trending`);
              } else {
                navigate('/series');
              }
            }}
            className="flex flex-col items-center gap-2 p-4 bg-bg-surface/60 backdrop-blur-sm border border-white/[0.04] rounded-xl text-center transition-all duration-normal hover:bg-bg-surface/80 hover:border-white/[0.08] hover:shadow-card-hover group"
            aria-label="Generate Trending Topics"
          >
            <div className="w-10 h-10 rounded-xl bg-success/[0.08] flex items-center justify-center icon-hover">
              <TrendingUp size={18} className="text-success" />
            </div>
            <span className="text-sm font-display font-medium text-txt-primary">Trending Topics</span>
            <span className="text-xs text-txt-tertiary">Discover viral ideas</span>
          </button>
          <button
            onClick={() => navigate('/calendar')}
            className="flex flex-col items-center gap-2 p-4 bg-bg-surface/60 backdrop-blur-sm border border-white/[0.04] rounded-xl text-center transition-all duration-normal hover:bg-bg-surface/80 hover:border-white/[0.08] hover:shadow-card-hover group"
            aria-label="View Content Calendar"
          >
            <div className="w-10 h-10 rounded-xl bg-info/[0.08] flex items-center justify-center icon-hover">
              <CalendarDays size={18} className="text-info" />
            </div>
            <span className="text-sm font-display font-medium text-txt-primary">Calendar</span>
            <span className="text-xs text-txt-tertiary">Schedule content</span>
          </button>
          <button
            onClick={() => navigate('/settings?tab=templates')}
            className="flex flex-col items-center gap-2 p-4 bg-bg-surface/60 backdrop-blur-sm border border-white/[0.04] rounded-xl text-center transition-all duration-normal hover:bg-bg-surface/80 hover:border-white/[0.08] hover:shadow-card-hover group"
            aria-label="Manage Prompt Templates"
          >
            <div className="w-10 h-10 rounded-xl bg-warning/[0.08] flex items-center justify-center icon-hover">
              <Settings size={18} className="text-warning" />
            </div>
            <span className="text-sm font-display font-medium text-txt-primary">Templates</span>
            <span className="text-xs text-txt-tertiary">Manage prompts</span>
          </button>
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
                <div className="empty-state py-8">
                  <Film size={28} />
                  <p className="text-sm font-display">No episodes yet</p>
                  <p className="text-xs">
                    Create a series and generate your first episode
                  </p>
                </div>
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
          <div className="empty-state py-12">
            <Film size={36} />
            <p className="text-sm font-display">No episodes yet</p>
            <p className="text-xs">
              Create a series and generate your first episode
            </p>
          </div>
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
