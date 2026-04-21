import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Download, Trash2, Upload, RefreshCw, AlertTriangle } from 'lucide-react';
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
