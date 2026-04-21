import { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  Copy,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ExternalLink,
  Monitor,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { license, formatError, type ActivationsResponse } from '@/lib/api';
import { useLicense } from '@/lib/useLicense';

function StateBadge({ state }: { state: string }) {
  switch (state) {
    case 'active':
      return (
        <Badge variant="success">
          <CheckCircle2 size={12} className="mr-1" /> Active
        </Badge>
      );
    case 'grace':
      return (
        <Badge variant="warning">
          <Clock size={12} className="mr-1" /> Grace period
        </Badge>
      );
    case 'expired':
      return (
        <Badge variant="error">
          <XCircle size={12} className="mr-1" /> Expired
        </Badge>
      );
    case 'invalid':
      return (
        <Badge variant="error">
          <AlertTriangle size={12} className="mr-1" /> Invalid
        </Badge>
      );
    default:
      return <Badge variant="default">Unactivated</Badge>;
  }
}

function tsToRelative(ts: number | null | undefined): string {
  if (!ts) return '-';
  const ms = ts < 1e12 ? ts * 1000 : ts; // unix seconds -> ms if needed
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function LicenseSection() {
  const { status, loading, refresh } = useLicense();
  const { toast } = useToast();
  const [replaceKey, setReplaceKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);

  // Activations list (server-side seat tracking)
  const [activations, setActivations] = useState<ActivationsResponse | null>(null);
  const [activationsLoading, setActivationsLoading] = useState(false);
  const [deactivatingMachine, setDeactivatingMachine] = useState<string | null>(null);

  const loadActivations = useCallback(async () => {
    if (!status || status.state === 'unactivated' || status.state === 'invalid') {
      setActivations(null);
      return;
    }
    setActivationsLoading(true);
    try {
      const res = await license.listActivations();
      setActivations(res);
    } catch (e) {
      // License server unreachable or endpoint missing (older server) -
      // surface the cause once, keep UI functional.
      toast.warning('Could not load seat list', { description: formatError(e) });
      setActivations(null);
    } finally {
      setActivationsLoading(false);
    }
  }, [status, toast]);

  useEffect(() => {
    loadActivations();
  }, [loadActivations]);

  const onDeactivateMachine = async (machineId: string) => {
    const isSelf = machineId === activations?.this_machine_id;
    const msg = isSelf
      ? "Deactivate THIS machine's seat? The app will lock until you paste a new license."
      : `Free the seat held by machine ${machineId.slice(0, 8)}...? The other install locks on its next heartbeat.`;
    if (!confirm(msg)) return;
    setDeactivatingMachine(machineId);
    try {
      const res = await license.deactivateMachine(machineId);
      setActivations(res);
      toast.success(isSelf ? 'This machine deactivated' : 'Seat released');
      if (isSelf) {
        // Our own JWT was cleared server-side AND locally; refresh status
        // so LicenseGate flips back to the activation wizard.
        await refresh();
      }
    } catch (e) {
      toast.error('Deactivation failed', { description: formatError(e) });
    } finally {
      setDeactivatingMachine(null);
    }
  };

  const onManageSubscription = async () => {
    setOpeningPortal(true);
    try {
      const r = await license.portal();
      if (r.url) {
        window.open(r.url, '_blank', 'noopener,noreferrer');
      } else {
        throw new Error('no portal url');
      }
    } catch (e: any) {
      const detail = e?.detail ?? e?.message ?? 'could not open billing portal';
      toast.error('Billing portal unavailable', {
        description: typeof detail === 'string' ? detail : JSON.stringify(detail),
      });
    } finally {
      setOpeningPortal(false);
    }
  };

  const copyMachineId = async () => {
    if (!status?.machine_id) return;
    try {
      await navigator.clipboard.writeText(status.machine_id);
      toast.success('Machine ID copied');
    } catch {
      toast.error('Copy failed');
    }
  };

  const onReplace = async () => {
    if (!replaceKey.trim()) return;
    setReplacing(true);
    try {
      await license.activate(replaceKey.trim());
      toast.success('License replaced');
      setReplaceKey('');
      refresh();
    } catch (e: any) {
      const detail = e?.detail ?? e?.message ?? 'activation failed';
      toast.error('Activation failed', {
        description: typeof detail === 'string' ? detail : JSON.stringify(detail),
      });
    } finally {
      setReplacing(false);
    }
  };

  const onDeactivate = async () => {
    if (!confirm('Deactivate license on this machine? The app will lock until you activate again.')) {
      return;
    }
    setDeactivating(true);
    try {
      await license.deactivate();
      toast.success('License deactivated');
      refresh();
    } catch (e: any) {
      toast.error('Deactivate failed', { description: e?.message });
    } finally {
      setDeactivating(false);
    }
  };

  if (loading && !status) {
    return <Card className="p-6">Loading license…</Card>;
  }

  const periodEnd = status?.period_end ? new Date(status.period_end) : null;
  const exp = status?.exp ? new Date(status.exp) : null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-txt-primary flex items-center gap-2">
          <KeyRound size={18} /> License
        </h3>
        <p className="text-xs text-txt-secondary mt-1">
          Your subscription entitlements and seat information.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-txt-secondary mb-1">Status</div>
            <StateBadge state={status?.state ?? 'unactivated'} />
          </div>
          <div className="text-right">
            <div className="text-xs text-txt-secondary mb-1">Tier</div>
            <div className="text-sm font-semibold text-txt-primary capitalize">
              {status?.tier ?? '—'}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 pt-3 border-t border-white/[0.06]">
          <div>
            <div className="text-xs text-txt-secondary mb-1">Paid through</div>
            <div className="text-sm text-txt-primary">
              {periodEnd ? periodEnd.toLocaleDateString() : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-txt-secondary mb-1">Hard expiry (+ 7d grace)</div>
            <div className="text-sm text-txt-primary">
              {exp ? exp.toLocaleDateString() : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-txt-secondary mb-1">Seat cap</div>
            <div className="text-sm text-txt-primary">
              {status?.machines_cap ?? '—'} {status?.machines_cap === 1 ? 'machine' : 'machines'}
            </div>
          </div>
          <div>
            <div className="text-xs text-txt-secondary mb-1">Features</div>
            <div className="text-xs text-txt-primary flex flex-wrap gap-1">
              {(status?.features ?? []).map((f) => (
                <span key={f} className="px-1.5 py-0.5 rounded bg-bg-hover text-txt-secondary">
                  {f}
                </span>
              )) || '—'}
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-white/[0.06]">
          <div className="text-xs text-txt-secondary mb-1">This machine</div>
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono text-txt-primary bg-bg-base px-2 py-1 rounded">
              {status?.machine_id ?? '—'}
            </code>
            <Button variant="ghost" size="sm" onClick={copyMachineId}>
              <Copy size={14} />
            </Button>
          </div>
          {status?.activated_at && (
            <div className="text-xs text-txt-secondary mt-1">
              Activated {new Date(status.activated_at).toLocaleString()}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-txt-primary">Manage subscription</h4>
            <p className="text-xs text-txt-secondary mt-1">
              Upgrade, downgrade, change payment method, view invoices, or cancel — handled by Stripe's billing portal.
            </p>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={onManageSubscription}
            disabled={openingPortal || status?.state !== 'active'}
          >
            {openingPortal ? 'Opening…' : <>Open portal <ExternalLink size={14} /></>}
          </Button>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-txt-primary">Replace license key</h4>
          <p className="text-xs text-txt-secondary mt-1">
            Paste a new JWT to switch tier or extend the subscription.
          </p>
        </div>
        <textarea
          value={replaceKey}
          onChange={(e) => setReplaceKey(e.target.value)}
          className="w-full h-24 px-3 py-2 bg-bg-base border border-white/[0.08] rounded-md text-xs font-mono text-txt-primary focus:outline-none focus:border-accent/40 resize-none"
          placeholder="eyJhbGciOiJFZERTQSI..."
          spellCheck={false}
        />
        <div className="flex items-center justify-end">
          <Button variant="primary" size="md" onClick={onReplace} disabled={replacing || !replaceKey.trim()}>
            {replacing ? 'Activating…' : 'Replace'}
          </Button>
        </div>
      </Card>

      {/* Activated machines (all seats held by this license) */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
              <Monitor size={14} />
              Activated machines
            </h4>
            <p className="text-xs text-txt-secondary mt-1">
              {activations
                ? `${activations.activations.length} of ${activations.cap} seats used on your ${activations.tier} tier.`
                : 'Seats currently held by this license key.'}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadActivations}
            disabled={activationsLoading}
            title="Re-check seat list"
          >
            <RefreshCw size={13} className={activationsLoading ? 'animate-spin' : ''} />
          </Button>
        </div>

        {activations === null ? (
          <div className="text-xs text-txt-muted py-3 text-center">
            {activationsLoading ? 'Loading...' : 'Seat list not available.'}
          </div>
        ) : activations.activations.length === 0 ? (
          <div className="text-xs text-txt-muted py-3 text-center">
            No machines currently registered.
          </div>
        ) : (
          <div className="space-y-2">
            {activations.activations.map((a) => (
              <div
                key={a.machine_id}
                className={[
                  'flex items-center justify-between gap-3 p-3 rounded border',
                  a.is_this_machine
                    ? 'border-accent/40 bg-accent/[0.04]'
                    : 'border-white/[0.06] bg-bg-elevated/50',
                ].join(' ')}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-txt-primary truncate">
                      {a.machine_id}
                    </code>
                    {a.is_this_machine && (
                      <Badge variant="success" className="text-[10px]">
                        This machine
                      </Badge>
                    )}
                    {a.last_known_version && (
                      <span className="text-[10px] text-txt-muted">v{a.last_known_version}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-txt-muted mt-0.5">
                    First seen {tsToRelative(a.first_seen)} &middot; Last heartbeat{' '}
                    {tsToRelative(a.last_heartbeat)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDeactivateMachine(a.machine_id)}
                  disabled={deactivatingMachine === a.machine_id}
                  className="shrink-0 text-error hover:bg-error/10"
                  title={
                    a.is_this_machine
                      ? 'Deactivate this machine (the app will lock)'
                      : 'Free the seat held by this remote machine'
                  }
                >
                  <Trash2 size={13} />
                  {deactivatingMachine === a.machine_id ? 'Working...' : 'Deactivate'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-txt-primary">Deactivate this machine</h4>
            <p className="text-xs text-txt-secondary mt-1">
              Clears the stored license. The app will lock until a new key is pasted. Equivalent to
              hitting &ldquo;Deactivate&rdquo; next to the highlighted row above.
            </p>
          </div>
          <Button variant="destructive" size="md" onClick={onDeactivate} disabled={deactivating}>
            {deactivating ? 'Working...' : 'Deactivate'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default LicenseSection;
