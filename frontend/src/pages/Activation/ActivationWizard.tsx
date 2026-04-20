import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { license } from '@/lib/api';

interface Props {
  status: 'unactivated' | 'expired' | 'invalid';
  stateError?: string | null;
  machineId?: string;
  onActivated: () => void;
}

/**
 * Full-screen activation wizard shown when no valid license is present.
 * Paste a license JWT → POST /api/v1/license/activate → parent refreshes
 * status on success and unmounts this.
 */
export function ActivationWizard({ status, stateError, machineId, onActivated }: Props) {
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await license.activate(key.trim());
      onActivated();
    } catch (err: any) {
      const detail = err?.detail ?? err?.message ?? 'activation failed';
      setError(typeof detail === 'string' ? detail : JSON.stringify(detail));
    } finally {
      setSubmitting(false);
    }
  };

  const heading =
    status === 'expired'
      ? 'Your license has expired'
      : status === 'invalid'
      ? 'License signature invalid'
      : 'Activate Creator Studio';
  const sub =
    status === 'expired'
      ? 'Renew to keep generating and to receive future updates. Paste your new license key below.'
      : status === 'invalid'
      ? 'The stored license did not verify against the embedded public key. Paste a fresh key from your order email.'
      : 'Paste the license key from your order email to unlock the app. Keys are signed and verified locally — no internet roundtrip needed.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-base p-6">
      <div className="w-full max-w-lg bg-bg-elevated/80 backdrop-blur-sm border border-white/[0.06] rounded-lg p-8 shadow-lg">
        <h1 className="text-2xl font-semibold text-txt-primary mb-2">{heading}</h1>
        <p className="text-sm text-txt-secondary mb-6">{sub}</p>

        {stateError && (
          <div className="mb-4 p-3 rounded border border-error/30 bg-error/10 text-xs text-error">
            {stateError}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="license-key" className="block text-xs text-txt-secondary mb-1">
              License key (JWT)
            </label>
            <textarea
              id="license-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="w-full h-28 px-3 py-2 bg-bg-base border border-white/[0.08] rounded-md text-xs font-mono text-txt-primary focus:outline-none focus:border-accent/40 resize-none"
              placeholder="eyJhbGciOiJFZERTQSI..."
              spellCheck={false}
              autoComplete="off"
              required
            />
          </div>

          {error && (
            <div className="p-3 rounded border border-error/30 bg-error/10 text-xs text-error">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-txt-secondary">
              {machineId && <span>Machine ID: <code className="font-mono">{machineId}</code></span>}
            </div>
            <Button type="submit" variant="primary" size="md" disabled={submitting || !key.trim()}>
              {submitting ? 'Activating…' : 'Activate'}
            </Button>
          </div>
        </form>

        <div className="mt-6 pt-4 border-t border-white/[0.06] text-xs text-txt-secondary">
          <p>
            Need a key? Buy a subscription at{' '}
            <a
              href="https://drevalis.com"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              drevalis.com
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

export default ActivationWizard;
