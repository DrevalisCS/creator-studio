import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Search,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { updates, type UpdateStatus, formatError } from '@/lib/api';

/** Human-readable "2 minutes ago" from a Date. */
function timeAgo(d: Date): string {
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

export function UpdatesSection() {
  const { toast } = useToast();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = useCallback(
    async (force: boolean, surfaceResult: boolean) => {
      if (force) setRefreshing(true);
      else setLoading(true);
      try {
        const s = await updates.status(force);
        setStatus(s);
        setLastChecked(new Date());
        if (surfaceResult) {
          if (s.unavailable) {
            toast.warning('Update check returned no data', {
              description: s.reason ?? 'See the card below for details.',
            });
          } else if (s.update_available) {
            toast.success(
              `Update available: ${s.current_stable ?? 'new version'}`,
              {
                description: s.mandatory_security_update
                  ? 'This is a security update.'
                  : 'Click Update now to apply.',
              },
            );
          } else {
            toast.success("You're on the latest version", {
              description: `Installed: ${s.current_installed ?? '-'}`,
            });
          }
        }
      } catch (e) {
        toast.error('Update check failed', { description: formatError(e) });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    // Initial fetch: no toast, just populate.
    refresh(false, false);
  }, [refresh]);

  // Re-render the "last checked" label once a minute so it stays accurate
  // without the user clicking around.
  const [, bumpTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bumpTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const onApply = async () => {
    if (
      !confirm(
        'Pull the new images and restart the stack? The app will be unavailable for ~60 seconds.',
      )
    ) {
      return;
    }
    setApplying(true);
    try {
      const r = await updates.apply();
      toast.success('Update queued', { description: r.hint });
    } catch (e) {
      toast.error('Could not queue update', { description: formatError(e) });
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return <Card className="p-6">Checking for updates...</Card>;
  }

  if (!status) {
    return <Card className="p-6">No update information available.</Card>;
  }

  return (
    <div className="space-y-4">
      {/* Header + prominent Check button */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary flex items-center gap-2">
            <ArrowUpCircle size={18} /> Updates
          </h3>
          <p className="text-xs text-txt-secondary mt-1">
            New releases from the Drevalis team. Updates require an active license.
          </p>
          {lastChecked && (
            <p className="text-[11px] text-txt-muted mt-1">
              Last checked: {timeAgo(lastChecked)}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={() => refresh(true, true)}
          disabled={refreshing}
          className="shrink-0"
          title="Force a fresh check against the update server (bypasses the 6h cache)"
        >
          <Search size={15} className={refreshing ? 'animate-pulse' : ''} />
          {refreshing ? 'Checking...' : 'Check for updates'}
        </Button>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-txt-secondary mb-1">Installed</div>
            <div className="text-lg font-semibold text-txt-primary">
              {status.current_installed ?? '-'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-txt-secondary mb-1">Latest stable</div>
            <div className="text-lg font-semibold text-txt-primary">
              {status.current_stable ?? '-'}
            </div>
          </div>
        </div>

        {status.unavailable ? (
          <div className="p-3 rounded border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Update information unavailable</div>
              <div className="mt-0.5 text-amber-200/80">
                {status.reason === 'license_required' &&
                  'No active license - activate to receive updates.'}
                {status.reason === 'license_revoked' &&
                  'License revoked - renew to receive updates.'}
                {status.reason === 'license_expired' &&
                  'License expired - renew to receive updates.'}
                {status.reason === 'license_server_not_configured' &&
                  'Offline-only install - updates must be installed manually.'}
                {status.reason === 'network_error' &&
                  'Could not reach the update server. Retry in a moment.'}
                {![
                  'license_required',
                  'license_revoked',
                  'license_expired',
                  'license_server_not_configured',
                  'network_error',
                ].includes(status.reason ?? '') && (
                  <>Reason: {status.reason ?? 'unknown'}</>
                )}
              </div>
            </div>
          </div>
        ) : status.update_available ? (
          <div className="p-3 rounded border border-accent/30 bg-accent/10 text-xs text-accent flex items-start gap-2">
            <ArrowUpCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">
                Update available{status.mandatory_security_update ? ' (security)' : ''}
              </div>
              {status.changelog_url && (
                <a
                  href={status.changelog_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mt-0.5 underline hover:no-underline"
                >
                  View changelog <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="p-3 rounded border border-success/30 bg-success/10 text-xs text-success flex items-center gap-2">
            <CheckCircle2 size={14} />
            You&apos;re on the latest version.
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refresh(true, true)}
            disabled={refreshing}
            title="Also triggers the check above"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Check again
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onApply}
            disabled={applying || !status.update_available || status.unavailable}
          >
            {applying ? 'Queueing...' : 'Update now'}
          </Button>
        </div>

        {status.image_tags && Object.keys(status.image_tags).length > 0 && (
          <div className="pt-3 border-t border-white/[0.06]">
            <div className="text-xs text-txt-secondary mb-2">Image tags for this release</div>
            <div className="space-y-1">
              {Object.entries(status.image_tags).map(([service, tag]) => (
                <div key={service} className="flex items-center justify-between text-xs">
                  <span className="text-txt-secondary">{service}</span>
                  <code className="font-mono text-txt-primary bg-bg-base px-2 py-0.5 rounded">
                    {tag}
                  </code>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default UpdatesSection;
