import { useState, useEffect, useCallback } from 'react';
import { Terminal, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { metricsApi } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineEvent {
  step: string;
  duration_seconds: number;
  success: boolean;
  episode_id: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Polling interval (ms)
// ---------------------------------------------------------------------------

const POLL_INTERVAL = 5000;

// ---------------------------------------------------------------------------
// Logs Page
// ---------------------------------------------------------------------------

function Logs() {
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchEvents = useCallback(async () => {
    try {
      const data = await metricsApi.events(200);
      setEvents(data);
    } catch {
      // ignore
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchEvents().finally(() => setLoading(false));
  }, [fetchEvents]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchEvents, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchEvents]);

  // ── Helpers ─────────────────────────────────────────────────────────

  const getStepColor = (step: string) => {
    const colors: Record<string, string> = {
      script: 'text-blue-400',
      voice: 'text-purple-400',
      scenes: 'text-green-400',
      captions: 'text-yellow-400',
      assembly: 'text-orange-400',
      thumbnail: 'text-pink-400',
    };
    return colors[step] || 'text-accent';
  };

  // ── Render ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      {/* Banner already shows "Event Log"; subtitle + actions only. */}
      <PageHeader
        subtitle="Recent pipeline execution events."
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 rounded accent-accent"
              />
              <span className="text-sm text-txt-secondary">Auto-refresh</span>
            </label>
            <Button variant="ghost" size="sm" onClick={() => void fetchEvents()}>
              <RefreshCw size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      {/* Stats summary */}
      {events.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card padding="md">
            <div className="text-xs text-txt-tertiary">Total Events</div>
            <div className="text-2xl font-bold text-txt-primary">{events.length}</div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-txt-tertiary">Successful</div>
            <div className="text-2xl font-bold text-green-400">
              {events.filter((e) => e.success).length}
            </div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-txt-tertiary">Failed</div>
            <div className="text-2xl font-bold text-red-400">
              {events.filter((e) => !e.success).length}
            </div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-txt-tertiary">Avg Duration</div>
            <div className="text-2xl font-bold text-txt-primary">
              {events.length > 0
                ? (
                    events.reduce((sum, e) => sum + (e.duration_seconds || 0), 0) /
                    events.length
                  ).toFixed(1)
                : '0'}
              s
            </div>
          </Card>
        </div>
      )}

      {/* Event log */}
      <Card padding="none">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal size={14} className="text-txt-tertiary" />
            <span className="text-sm font-medium text-txt-primary">Pipeline Events</span>
            <Badge variant="neutral">{events.length}</Badge>
          </div>
        </div>

        <div className="font-mono text-xs max-h-[65vh] overflow-y-auto p-4 scrollbar-thin">
          {events.length === 0 ? (
            <EmptyState
              icon={Terminal}
              title="No pipeline events recorded yet"
              description="Events appear here as episodes are generated."
            />
          ) : (
            <div className="space-y-0">
              {events.map((e, i) => (
                <div
                  key={i}
                  className={[
                    'py-1.5 border-b border-border/20 flex items-center gap-3',
                    e.success ? 'text-txt-secondary' : 'text-red-400',
                  ].join(' ')}
                >
                  <span className="text-txt-tertiary w-20 shrink-0">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={e.success ? 'text-green-400' : 'text-red-400'}>
                    {e.success ? '\u2713' : '\u2717'}
                  </span>
                  <span className={`w-20 shrink-0 ${getStepColor(e.step)}`}>{e.step}</span>
                  <span className="text-txt-tertiary w-16 shrink-0 text-right">
                    {e.duration_seconds?.toFixed(1)}s
                  </span>
                  <span className="text-txt-tertiary">
                    {e.episode_id?.slice(0, 8)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default Logs;
