import { useState } from 'react';
import { KeyRound, Copy, CheckCircle2, XCircle, Clock, AlertTriangle, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { license } from '@/lib/api';
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

export function LicenseSection() {
  const { status, loading, refresh } = useLicense();
  const { toast } = useToast();
  const [replaceKey, setReplaceKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);

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
      toast({
        title: 'Billing portal unavailable',
        description: typeof detail === 'string' ? detail : JSON.stringify(detail),
        variant: 'error',
      });
    } finally {
      setOpeningPortal(false);
    }
  };

  const copyMachineId = async () => {
    if (!status?.machine_id) return;
    try {
      await navigator.clipboard.writeText(status.machine_id);
      toast({ title: 'Machine ID copied', variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', variant: 'error' });
    }
  };

  const onReplace = async () => {
    if (!replaceKey.trim()) return;
    setReplacing(true);
    try {
      await license.activate(replaceKey.trim());
      toast({ title: 'License replaced', variant: 'success' });
      setReplaceKey('');
      refresh();
    } catch (e: any) {
      const detail = e?.detail ?? e?.message ?? 'activation failed';
      toast({
        title: 'Activation failed',
        description: typeof detail === 'string' ? detail : JSON.stringify(detail),
        variant: 'error',
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
      toast({ title: 'License deactivated', variant: 'success' });
      refresh();
    } catch (e: any) {
      toast({ title: 'Deactivate failed', description: e?.message, variant: 'error' });
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

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-txt-primary">Deactivate this machine</h4>
            <p className="text-xs text-txt-secondary mt-1">
              Clears the stored license. The app will lock until a new key is pasted.
            </p>
          </div>
          <Button variant="destructive" size="md" onClick={onDeactivate} disabled={deactivating}>
            {deactivating ? 'Working…' : 'Deactivate'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default LicenseSection;
