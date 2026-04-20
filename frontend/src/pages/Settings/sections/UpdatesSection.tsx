import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, AlertTriangle, RefreshCw, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { updates, type UpdateStatus } from '@/lib/api';

export function UpdatesSection() {
  const { toast } = useToast();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);

  const refresh = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const s = await updates.status(force);
      setStatus(s);
    } catch (e: any) {
      toast({ title: 'Update check failed', description: e?.message, variant: 'error' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    refresh(false);
  }, [refresh]);

  const onApply = async () => {
    if (!confirm('Pull the new images and restart the stack? The app will be unavailable for ~60 seconds.')) {
      return;
    }
    setApplying(true);
    try {
      const r = await updates.apply();
      toast({ title: 'Update queued', description: r.hint, variant: 'success' });
    } catch (e: any) {
      toast({ title: 'Could not queue update', description: e?.message, variant: 'error' });
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return <Card className="p-6">Checking for updates…</Card>;
  }

  if (!status) {
    return <Card className="p-6">No update information available.</Card>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-txt-primary flex items-center gap-2">
          <ArrowUpCircle size={18} /> Updates
        </h3>
        <p className="text-xs text-txt-secondary mt-1">
          New releases from the Drevalis team. Updates require an active license.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-txt-secondary mb-1">Installed</div>
            <div className="text-lg font-semibold text-txt-primary">
              {status.current_installed ?? '—'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-txt-secondary mb-1">Latest stable</div>
            <div className="text-lg font-semibold text-txt-primary">
              {status.current_stable ?? '—'}
            </div>
          </div>
        </div>

        {status.unavailable ? (
          <div className="p-3 rounded border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Update information unavailable</div>
              <div className="mt-0.5 text-amber-200/80">
                {status.reason === 'license_required' && 'No active license — activate to receive updates.'}
                {status.reason === 'license_revoked' && 'License revoked — renew to receive updates.'}
                {status.reason === 'license_expired' && 'License expired — renew to receive updates.'}
                {status.reason === 'license_server_not_configured' && 'Offline-only install — updates must be installed manually.'}
                {status.reason === 'network_error' && 'Could not reach the update server. Retry in a moment.'}
                {!['license_required', 'license_revoked', 'license_expired', 'license_server_not_configured', 'network_error'].includes(status.reason ?? '') && (
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
            You're on the latest version.
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
          <Button variant="ghost" size="sm" onClick={() => refresh(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Check again
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onApply}
            disabled={applying || !status.update_available || status.unavailable}
          >
            {applying ? 'Queueing…' : 'Update now'}
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
