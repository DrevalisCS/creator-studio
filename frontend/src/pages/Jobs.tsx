import { useState, useEffect } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useNavigate } from 'react-router-dom';
import {
  ListChecks,
  Square,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { jobs as jobsApi } from '@/lib/api';
import type { GenerationJobExtended } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type FilterStatus = 'all' | 'running' | 'queued' | 'done' | 'failed';

const FILTER_OPTIONS: { key: FilterStatus; label: string; icon: typeof ListChecks }[] = [
  { key: 'all', label: 'All', icon: ListChecks },
  { key: 'running', label: 'Running', icon: Loader2 },
  { key: 'queued', label: 'Queued', icon: Clock },
  { key: 'done', label: 'Done', icon: CheckCircle2 },
  { key: 'failed', label: 'Failed', icon: XCircle },
];

const STEP_COLORS: Record<string, string> = {
  script: 'bg-indigo-500',
  voice: 'bg-pink-500',
  scenes: 'bg-teal-500',
  captions: 'bg-amber-500',
  assembly: 'bg-blue-500',
  thumbnail: 'bg-purple-500',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts: string | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString();
}

function getElapsedStr(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const elapsed = Math.max(0, Math.floor((end - start) / 1000));
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Jobs() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [allJobs, setAllJobs] = useState<GenerationJobExtended[]>([]);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancellingAll, setCancellingAll] = useState(false);

  // Tick counter for elapsed time updates
  const [, setTick] = useState(0);

  // Fetch jobs
  useEffect(() => {
    let mounted = true;

    const fetchJobs = async () => {
      try {
        // Always fetch all jobs so we can compute counts for all filters.
        const data = await jobsApi.all({ limit: 200 });
        if (!mounted) return;
        setAllJobs(data);
      } catch (err) {
        if (mounted) {
          toast.error('Failed to load jobs', { description: String(err) });
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void fetchJobs();
    const interval = setInterval(() => void fetchJobs(), 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Tick for elapsed time in running jobs
  useEffect(() => {
    const hasRunning = allJobs.some((j) => j.status === 'running');
    if (!hasRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [allJobs]);

  // Counts per status
  const counts: Record<FilterStatus, number> = {
    all: allJobs.length,
    running: allJobs.filter((j) => j.status === 'running').length,
    queued: allJobs.filter((j) => j.status === 'queued').length,
    done: allJobs.filter((j) => j.status === 'done').length,
    failed: allJobs.filter((j) => j.status === 'failed').length,
  };

  // Filtered jobs
  const filteredJobs =
    filter === 'all' ? allJobs : allJobs.filter((j) => j.status === filter);

  // Handlers
  const handleCancelJob = async (jobId: string) => {
    setCancelling((prev) => new Set(prev).add(jobId));
    try {
      await jobsApi.cancelJob(jobId);
      toast.success('Job cancelled');
    } catch (err) {
      toast.error('Failed to cancel job', { description: String(err) });
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const handleCancelAll = async () => {
    setCancellingAll(true);
    try {
      await jobsApi.cancelAll();
      toast.success('All active jobs cancelled');
    } catch (err) {
      toast.error('Failed to cancel all jobs', { description: String(err) });
    } finally {
      setCancellingAll(false);
    }
  };

  const hasActiveJobs = counts.running > 0 || counts.queued > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-txt-primary flex items-center gap-2">
            <ListChecks size={24} className="text-accent" />
            Job Manager
          </h2>
          <p className="text-sm text-txt-secondary mt-1">
            Monitor and control all generation tasks
          </p>
        </div>
        <div className="flex gap-2">
          {hasActiveJobs && (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300"
              onClick={() => void handleCancelAll()}
              loading={cancellingAll}
            >
              <Square size={14} /> Stop All
            </Button>
          )}
        </div>
      </div>

      {/* Stats / filter bar */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {FILTER_OPTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={[
              'p-3 rounded-lg text-center transition-all duration-150 border',
              filter === key
                ? 'bg-accent/10 border-accent shadow-sm'
                : 'bg-bg-surface border-border hover:border-border hover:bg-bg-hover',
            ].join(' ')}
          >
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <Icon
                size={14}
                className={
                  filter === key ? 'text-accent' : 'text-txt-tertiary'
                }
              />
              <span
                className={[
                  'text-2xl font-bold',
                  filter === key ? 'text-accent' : 'text-txt-primary',
                ].join(' ')}
              >
                {counts[key]}
              </span>
            </div>
            <div
              className={[
                'text-xs capitalize',
                filter === key ? 'text-accent' : 'text-txt-tertiary',
              ].join(' ')}
            >
              {label}
            </div>
          </button>
        ))}
      </div>

      {/* Job table */}
      <Card padding="none">
        {filteredJobs.length === 0 ? (
          <div className="p-12 text-center">
            <AlertTriangle
              size={32}
              className="mx-auto mb-3 text-txt-tertiary"
            />
            <p className="text-sm text-txt-secondary">
              {filter === 'all'
                ? 'No generation jobs found.'
                : `No ${filter} jobs found.`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-elevated">
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Episode
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Series
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Step
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Progress
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Error
                  </th>
                  <th className="text-left px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Created
                  </th>
                  <th className="text-right px-4 py-2.5 text-txt-tertiary font-medium text-xs uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="hover:bg-bg-hover transition-colors"
                  >
                    {/* Episode */}
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() =>
                          navigate(`/episodes/${job.episode_id}`)
                        }
                        className="text-accent hover:underline text-left truncate block max-w-[200px]"
                        title={job.episode_title || job.episode_id}
                      >
                        {job.episode_title || job.episode_id.slice(0, 8)}
                      </button>
                    </td>

                    {/* Series */}
                    <td className="px-4 py-2.5">
                      <span className="text-txt-secondary text-xs truncate block max-w-[120px]">
                        {job.series_name || '-'}
                      </span>
                    </td>

                    {/* Step */}
                    <td className="px-4 py-2.5">
                      <Badge variant={job.step}>{job.step}</Badge>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-2.5">
                      <Badge variant={job.status} dot>
                        {job.status}
                      </Badge>
                    </td>

                    {/* Progress */}
                    <td className="px-4 py-2.5">
                      {job.status === 'running' ? (
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                            <div
                              className={[
                                'h-full rounded-full transition-all duration-500',
                                STEP_COLORS[job.step] || 'bg-accent',
                              ].join(' ')}
                              style={{
                                width: `${job.progress_pct}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-txt-tertiary w-8 text-right">
                            {job.progress_pct}%
                          </span>
                        </div>
                      ) : job.status === 'done' ? (
                        <span className="text-xs text-success">100%</span>
                      ) : (
                        <span className="text-xs text-txt-tertiary">-</span>
                      )}
                    </td>

                    {/* Duration */}
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-txt-tertiary">
                        {job.started_at
                          ? getElapsedStr(job.started_at, job.completed_at)
                          : '-'}
                      </span>
                    </td>

                    {/* Error */}
                    <td className="px-4 py-2.5">
                      {job.error_message ? (
                        <span
                          className="text-xs text-red-400 truncate block max-w-[200px]"
                          title={job.error_message}
                        >
                          {job.error_message.length > 60
                            ? job.error_message.slice(0, 60) + '...'
                            : job.error_message}
                        </span>
                      ) : (
                        <span className="text-xs text-txt-tertiary">-</span>
                      )}
                    </td>

                    {/* Created */}
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-txt-tertiary">
                        {formatTimestamp(job.created_at)}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-2.5 text-right">
                      {(job.status === 'running' ||
                        job.status === 'queued') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-400 hover:text-red-300"
                          onClick={() => void handleCancelJob(job.id)}
                          disabled={cancelling.has(job.id)}
                          title="Cancel this job"
                        >
                          {cancelling.has(job.id) ? (
                            <RefreshCw
                              size={12}
                              className="animate-spin"
                            />
                          ) : (
                            <Square size={12} />
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Summary footer */}
      {allJobs.length > 0 && (
        <div className="mt-4 text-xs text-txt-tertiary text-center">
          Showing {filteredJobs.length} of {allJobs.length} total jobs
          {hasActiveJobs && (
            <span>
              {' '}
              &middot; {counts.running} running, {counts.queued} queued
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default Jobs;
