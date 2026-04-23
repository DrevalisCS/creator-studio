import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Download,
  Trash2,
  Upload,
  RefreshCw,
  AlertTriangle,
  Wrench,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { ApiError, formatError } from '@/lib/api';

interface Archive {
  filename: string;
  size_bytes: number;
  created_at: string;
}

interface BackupListResponse {
  backup_directory: string;
  retention: number;
  auto_enabled: boolean;
  archives: Archive[];
}

interface RepairReport {
  scanned: number;
  already_ok: number;
  relinked: number;
  unresolved: number;
  relinked_paths: Array<{ from: string; to: string }>;
  unresolved_paths: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function BackupSection() {
  const { toast } = useToast();
  const [state, setState] = useState<BackupListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairReport, setRepairReport] = useState<RepairReport | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [allowKeyMismatch, setAllowKeyMismatch] = useState(false);
  const [restoreDb, setRestoreDb] = useState(true);
  const [restoreMedia, setRestoreMedia] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/backup');
      if (!res.ok) throw new ApiError(res.status, res.statusText, await res.text());
      const data: BackupListResponse = await res.json();
      setState(data);
    } catch (err) {
      toast.error('Failed to load backups', { description: formatError(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/v1/backup', { method: 'POST' });
      if (!res.ok) throw new ApiError(res.status, res.statusText, await res.text());
      const data = await res.json();
      toast.success('Backup created', {
        description: `${data.filename} (${formatBytes(data.size_bytes)})`,
      });
      await refresh();
    } catch (err) {
      toast.error('Backup failed', { description: formatError(err) });
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (filename: string) => {
    if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/v1/backup/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204)
        throw new ApiError(res.status, res.statusText, await res.text());
      toast.success('Deleted', { description: filename });
      await refresh();
    } catch (err) {
      toast.error('Delete failed', { description: formatError(err) });
    }
  };

  const onDownload = (filename: string) => {
    window.open(`/api/v1/backup/${encodeURIComponent(filename)}`, '_blank');
  };

  const onRepair = async () => {
    setRepairing(true);
    setRepairReport(null);
    try {
      // Explicitly empty JSON body — nginx/uvicorn stacks sometimes
      // inject a default Content-Type header on body-less POSTs which
      // confused FastAPI into returning 422. Sending "{}" with the
      // correct Content-Type removes the ambiguity.
      const res = await fetch('/api/v1/backup/repair-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        // FastAPI 422 puts a validation-error array in `.detail`; other
        // errors put a plain string there. Flatten either shape to a
        // human-readable message so toasts don't render "[object Object]".
        let message = res.statusText;
        const detail = (payload as { detail?: unknown }).detail;
        if (Array.isArray(detail)) {
          message = detail
            .map((d: { loc?: unknown[]; msg?: string }) => {
              const loc = (d.loc ?? []).join('.');
              return loc ? `${loc}: ${d.msg ?? ''}` : d.msg ?? '';
            })
            .filter(Boolean)
            .join('; ') || message;
        } else if (typeof detail === 'string') {
          message = detail;
        } else if (detail && typeof detail === 'object') {
          message = JSON.stringify(detail);
        }
        throw new ApiError(res.status, res.statusText, message);
      }
      const data: RepairReport = await res.json();
      setRepairReport(data);
      if (data.relinked > 0) {
        toast.success('Media links repaired', {
          description: `${data.relinked} relinked, ${data.unresolved} unresolved`,
        });
      } else if (data.unresolved > 0) {
        toast.error('No matches found', {
          description: `${data.unresolved} rows still point nowhere`,
        });
      } else {
        toast.success('Nothing to repair', {
          description: `All ${data.already_ok} media rows resolve correctly`,
        });
      }
    } catch (err) {
      toast.error('Repair failed', { description: formatError(err) });
    } finally {
      setRepairing(false);
    }
  };

  const onRestore = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      toast.error('No file selected');
      return;
    }
    if (restoreConfirm !== 'RESTORE') {
      toast.error('Type RESTORE in the confirmation field to proceed');
      return;
    }
    if (!restoreDb && !restoreMedia) {
      toast.error('Select at least one of database or media to restore');
      return;
    }
    setRestoring(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const params = new URLSearchParams();
      if (allowKeyMismatch) params.set('allow_key_mismatch', 'true');
      if (!restoreDb) params.set('restore_db', 'false');
      if (!restoreMedia) params.set('restore_media', 'false');
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(`/api/v1/backup/restore${qs}`, {
        method: 'POST',
        headers: { 'X-Confirm-Restore': 'i-understand' },
        body: fd,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new ApiError(res.status, res.statusText, detail.detail ?? res.statusText);
      }
      const data = await res.json();
      const totalRows = Object.values(
        (data.rows_inserted ?? {}) as Record<string, number>,
      ).reduce((a, b) => a + b, 0);
      const storageCount = (data.storage_paths_restored ?? []).length;
      toast.success('Restore complete', {
        description: `${totalRows} rows + ${storageCount} storage dirs. Reload the page to pick up the new state.`,
      });
      setRestoreConfirm('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await refresh();
    } catch (err) {
      toast.error('Restore failed', { description: formatError(err) });
    } finally {
      setRestoring(false);
    }
  };

  if (loading) return <Card className="p-6">Loading backups...</Card>;
  if (!state) return <Card className="p-6">Backup service unavailable.</Card>;

  return (
    <div className="space-y-6">
      {/* Header / status */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-lg flex items-center gap-2 mb-1">
              <Archive className="w-5 h-5" />
              Backups
            </h3>
            <p className="text-sm text-txt-secondary">
              Full-install archives (DB rows + user media). Safe to move between machines that
              share the same ENCRYPTION_KEY.
            </p>
          </div>
          <Button onClick={onCreate} disabled={creating} variant="primary">
            {creating ? 'Creating...' : 'Backup now'}
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4 text-xs">
          <div className="rounded bg-bg-elevated p-3">
            <div className="text-txt-muted uppercase tracking-wider mb-1">Directory</div>
            <div className="text-txt-primary font-mono break-all">{state.backup_directory}</div>
          </div>
          <div className="rounded bg-bg-elevated p-3">
            <div className="text-txt-muted uppercase tracking-wider mb-1">Retention</div>
            <div className="text-txt-primary">Keep {state.retention} most recent</div>
          </div>
          <div className="rounded bg-bg-elevated p-3">
            <div className="text-txt-muted uppercase tracking-wider mb-1">Auto-backup</div>
            <div className={state.auto_enabled ? 'text-accent' : 'text-txt-secondary'}>
              {state.auto_enabled ? 'Nightly at 03:00 UTC' : 'Disabled'}
            </div>
          </div>
        </div>
        <p className="text-xs text-txt-muted mt-3">
          Configure via environment variables: <code>BACKUP_DIRECTORY</code>,{' '}
          <code>BACKUP_RETENTION</code>, <code>BACKUP_AUTO_ENABLED</code>. Mount a network share
          (SMB/NFS) into the container at the backup directory path to send backups off-box.
        </p>
      </Card>

      {/* List of archives */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold">Existing archives ({state.archives.length})</h4>
          <Button size="sm" variant="ghost" onClick={refresh}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Refresh
          </Button>
        </div>
        {state.archives.length === 0 ? (
          <div className="py-12 text-center text-sm text-txt-muted">
            No backups yet. Click <strong className="text-txt-primary">Backup now</strong> to create
            your first one.
          </div>
        ) : (
          <div className="space-y-2">
            {state.archives.map((a) => (
              <div
                key={a.filename}
                className="flex items-center justify-between gap-4 p-3 rounded bg-bg-elevated"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm truncate">{a.filename}</div>
                  <div className="text-xs text-txt-muted">
                    {new Date(a.created_at).toLocaleString()} &middot; {formatBytes(a.size_bytes)}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => onDownload(a.filename)}>
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDelete(a.filename)}
                    className="text-error hover:bg-error/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Repair media links — non-destructive */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="font-semibold flex items-center gap-2">
              <Wrench className="w-4 h-4" />
              Repair media links
            </h4>
            <p className="text-sm text-txt-secondary mt-1">
              Relink <code>media_assets</code> rows to files on disk after a rough restore or
              manual copy. Non-destructive: only rows whose current path is broken get updated.
            </p>
          </div>
          <Button onClick={onRepair} disabled={repairing} variant="primary">
            {repairing ? 'Scanning...' : 'Repair now'}
          </Button>
        </div>
        {repairReport && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="rounded bg-bg-elevated p-3">
                <div className="text-txt-muted uppercase tracking-wider mb-1">Scanned</div>
                <div className="text-txt-primary text-lg font-semibold">
                  {repairReport.scanned}
                </div>
              </div>
              <div className="rounded bg-bg-elevated p-3">
                <div className="text-txt-muted uppercase tracking-wider mb-1">Already OK</div>
                <div className="text-txt-primary text-lg font-semibold">
                  {repairReport.already_ok}
                </div>
              </div>
              <div className="rounded bg-emerald-500/10 p-3">
                <div className="text-emerald-300 uppercase tracking-wider mb-1">Relinked</div>
                <div className="text-emerald-200 text-lg font-semibold">
                  {repairReport.relinked}
                </div>
              </div>
              <div
                className={`rounded p-3 ${
                  repairReport.unresolved > 0 ? 'bg-amber-500/10' : 'bg-bg-elevated'
                }`}
              >
                <div
                  className={`uppercase tracking-wider mb-1 ${
                    repairReport.unresolved > 0 ? 'text-amber-300' : 'text-txt-muted'
                  }`}
                >
                  Unresolved
                </div>
                <div
                  className={`text-lg font-semibold ${
                    repairReport.unresolved > 0 ? 'text-amber-200' : 'text-txt-primary'
                  }`}
                >
                  {repairReport.unresolved}
                </div>
              </div>
            </div>
            {repairReport.relinked_paths.length > 0 && (
              <details className="rounded bg-bg-elevated p-3 text-xs">
                <summary className="cursor-pointer text-txt-secondary">
                  Relinked paths ({repairReport.relinked_paths.length}
                  {repairReport.relinked > repairReport.relinked_paths.length ? '+' : ''})
                </summary>
                <div className="mt-2 space-y-1 font-mono">
                  {repairReport.relinked_paths.map((p, i) => (
                    <div key={i} className="truncate">
                      <span className="text-txt-muted">{p.from || '(empty)'}</span>
                      <span className="text-emerald-300 mx-1">→</span>
                      <span className="text-txt-primary">{p.to}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {repairReport.unresolved_paths.length > 0 && (
              <details className="rounded bg-amber-500/5 p-3 text-xs">
                <summary className="cursor-pointer text-amber-300">
                  Unresolved paths ({repairReport.unresolved_paths.length}
                  {repairReport.unresolved > repairReport.unresolved_paths.length ? '+' : ''})
                </summary>
                <div className="mt-2 space-y-1 font-mono text-txt-secondary">
                  {repairReport.unresolved_paths.map((p, i) => (
                    <div key={i} className="truncate">
                      {p}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-txt-muted">
                  These rows still point nowhere. If the underlying files are genuinely gone,
                  regenerate the affected episodes or delete the orphan rows.
                </p>
              </details>
            )}
          </div>
        )}
      </Card>

      {/* Restore — dangerous */}
      <Card className="p-6 border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start gap-3 mb-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold">Restore from archive</h4>
            <p className="text-sm text-txt-secondary mt-1">
              <strong>Destructive.</strong> Restoring truncates every user table and overwrites
              storage files with the contents of the archive. Your current content is deleted. This
              is the right action when migrating to a new machine.
            </p>
          </div>
        </div>
        <div className="space-y-3 mt-4">
          <div>
            <label className="block text-xs font-medium text-txt-secondary mb-1">
              1. Select archive (.tar.gz)
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tar.gz,application/gzip"
              className="block w-full text-sm text-txt-primary file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-bg-elevated file:text-txt-primary hover:file:bg-bg-hover"
            />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-txt-secondary">What to restore</div>
            <label className="flex items-center gap-2 text-xs text-txt-secondary">
              <input
                type="checkbox"
                checked={restoreDb}
                onChange={(e) => setRestoreDb(e.target.checked)}
                className="rounded"
              />
              <span>
                <strong className="text-txt-primary">Database rows</strong> — series, episodes,
                audiobooks, configs, OAuth tokens
              </span>
            </label>
            <label className="flex items-center gap-2 text-xs text-txt-secondary">
              <input
                type="checkbox"
                checked={restoreMedia}
                onChange={(e) => setRestoreMedia(e.target.checked)}
                className="rounded"
              />
              <span>
                <strong className="text-txt-primary">Media files</strong> — generated videos,
                audiobook audio, voice previews (can be very large)
              </span>
            </label>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <input
              id="allow-key-mismatch"
              type="checkbox"
              checked={allowKeyMismatch}
              onChange={(e) => setAllowKeyMismatch(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="allow-key-mismatch" className="text-txt-secondary">
              Allow different ENCRYPTION_KEY (OAuth tokens + API keys will need to be re-entered)
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium text-txt-secondary mb-1">
              2. Type <strong className="text-txt-primary font-mono">RESTORE</strong> to confirm
            </label>
            <Input
              value={restoreConfirm}
              onChange={(e) => setRestoreConfirm(e.target.value)}
              placeholder="RESTORE"
            />
          </div>
          <Button
            onClick={onRestore}
            disabled={
              restoring || restoreConfirm !== 'RESTORE' || (!restoreDb && !restoreMedia)
            }
            variant="primary"
            className="bg-amber-500 hover:bg-amber-400 text-bg-base"
          >
            <Upload className="w-4 h-4 mr-1" />
            {restoring ? 'Restoring...' : 'Restore (destructive)'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
