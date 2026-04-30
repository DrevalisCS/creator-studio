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
  backup_directory_abs?: string;
  backup_directory_host_source?: string | null;
  retention: number;
  auto_enabled: boolean;
  archives: Archive[];
}

function hostHintFromVmLabel(path: string | null | undefined): string | null {
  // Docker Desktop on Windows/macOS labels bind-mounted host directories
  // with VM-internal prefixes. Map them back to the real user-visible
  // Windows/macOS equivalent so the operator can paste it into Explorer.
  if (!path) return null;
  const vmPrefixes = ['/project/', '/run/desktop/mnt/', '/mnt/host_mnt/', '/host_mnt/'];
  for (const prefix of vmPrefixes) {
    if (path.startsWith(prefix)) {
      const tail = path.slice(prefix.length);
      // Heuristic: the compose directory's basename is the same in both
      // worlds, so tail under the prefix maps 1:1 to ``%USERPROFILE%\<tail>``
      // on Windows (or ``~/<tail>`` on macOS) for the default install.
      const winPath = '%USERPROFILE%\\' + tail.replace(/\//g, '\\');
      const macPath = '~/' + tail;
      return `Windows: ${winPath}   ·   macOS: ${macPath}`;
    }
  }
  if (path.startsWith('/var/lib/docker/volumes/')) {
    return (
      'This is a Docker NAMED VOLUME, not a bind mount — the backup lives ' +
      "inside Docker Desktop's VM and isn't visible in Windows Explorer. " +
      'Set BACKUP_DIRECTORY in .env to a bind-mounted path, or use ' +
      '"docker cp drevalis-app-1:<path> ." to pull files to your host.'
    );
  }
  return null;
}

interface RepairReport {
  scanned: number;
  already_ok: number;
  relinked: number;
  unresolved: number;
  relinked_paths: Array<{ from: string; to: string }>;
  unresolved_paths: Array<{ path: string; basename_on_disk: boolean }>;
  storage_base_abs?: string;
  indexed_files?: number;
  sample_db_paths?: string[];
  sample_disk_paths?: string[];
}

interface StorageProbe {
  storage_base_path: string;
  storage_base_exists: boolean;
  storage_base_is_symlink: boolean;
  episodes_dir_exists: boolean;
  episodes_dir_is_symlink: boolean;
  audiobooks_dir_exists: boolean;
  api_auth_token_configured: boolean;
  api_auth_blocks_storage: boolean;
  process_uid: number | null;
  process_gid: number | null;
  mount_fs: string | null;
  host_source_path: string | null;
  top_level_entries?: Array<{
    name?: string;
    kind?: 'file' | 'dir' | 'other';
    size_bytes?: number;
    child_count?: number;
    child_count_capped?: boolean;
    error?: string;
  }>;
  total_visible_bytes?: number;
  total_visible_count?: number;
  samples: Array<{
    asset_type: string;
    file_path: string;
    episode_id: string | null;
    abs_path: string | null;
    exists: boolean;
    readable: boolean;
    is_symlink: boolean;
    size_bytes: number | null;
    url_served_at: string | null;
    error: string | null;
  }>;
  hints: string[];
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
  const [probing, setProbing] = useState(false);
  const [probeReport, setProbeReport] = useState<StorageProbe | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [allowKeyMismatch, setAllowKeyMismatch] = useState(false);
  const [restoreDb, setRestoreDb] = useState(true);
  const [restoreMedia, setRestoreMedia] = useState(true);
  const [restoreProgress, setRestoreProgress] = useState<{
    stage: string;
    progress_pct: number;
    message: string;
  } | null>(null);
  const [selectedExisting, setSelectedExisting] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

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

  // Resume polling on mount if a restore was in flight when the user
  // navigated away. Survives full-page reloads + tab switches up to
  // the Redis status TTL (1h on the worker side).
  useEffect(() => {
    let stashed: string | null = null;
    try {
      stashed = window.localStorage.getItem('restoreJobId');
    } catch {
      stashed = null;
    }
    if (!stashed) return;
    setRestoring(true);
    setRestoreProgress({
      stage: 'resuming',
      progress_pct: 0,
      message: 'Reconnecting to in-flight restore…',
    });
    pollRestoreStatus(stashed);
    // pollRestoreStatus is stable (useCallback) so empty-deps is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const onProbe = async () => {
    setProbing(true);
    setProbeReport(null);
    try {
      const res = await fetch('/api/v1/backup/storage-probe');
      if (!res.ok) throw new ApiError(res.status, res.statusText, await res.text());
      const data: StorageProbe = await res.json();
      setProbeReport(data);
    } catch (err) {
      toast.error('Storage probe failed', { description: formatError(err) });
    } finally {
      setProbing(false);
    }
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

  // Cleanup poll timer on unmount so a tab navigation away doesn't
  // leak setInterval handlers. The active job_id is stashed in
  // localStorage so a re-mount (or re-load) can pick the poll back up.
  useEffect(() => {
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const pollRestoreStatus = useCallback(
    (jobId: string) => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
      }
      try {
        window.localStorage.setItem('restoreJobId', jobId);
      } catch {
        // Private browsing / quota — non-fatal.
      }
      const tick = async () => {
        try {
          const res = await fetch(`/api/v1/backup/restore-status/${jobId}`);
          if (!res.ok) return;
          const data = await res.json();
          if (data.status === 'running' || data.status === 'queued') {
            setRestoreProgress({
              stage: data.stage ?? data.status,
              progress_pct: data.progress_pct ?? 0,
              message: data.message ?? 'Restoring…',
            });
          } else if (data.status === 'done') {
            if (pollRef.current != null) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
            try {
              window.localStorage.removeItem('restoreJobId');
            } catch {
              /* ignore */
            }
            setRestoreProgress({
              stage: 'done',
              progress_pct: 100,
              message: data.message ?? 'Restore complete.',
            });
            const result = data.result ?? {};
            const totalRows = Object.values(
              (result.rows_inserted ?? {}) as Record<string, number>,
            ).reduce((a, b) => a + b, 0);
            const storageCount = (result.storage_paths_restored ?? []).length;
            toast.success('Restore complete', {
              description: `${totalRows} rows + ${storageCount} storage dirs. Reload the page to pick up the new state.`,
            });
            setRestoring(false);
            setRestoreConfirm('');
            if (fileInputRef.current) fileInputRef.current.value = '';
            await refresh();
            // Leave the progress bar visible at 100% so the user sees the
            // success state until they navigate / refresh.
          } else if (data.status === 'failed') {
            if (pollRef.current != null) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
            try {
              window.localStorage.removeItem('restoreJobId');
            } catch {
              /* ignore */
            }
            setRestoreProgress({
              stage: 'failed',
              progress_pct: data.progress_pct ?? 0,
              message: data.message ?? data.error ?? 'Restore failed',
            });
            toast.error('Restore failed', {
              description: data.error ?? data.message ?? 'see worker logs',
            });
            setRestoring(false);
          } else if (data.status === 'unknown') {
            // Status key not in Redis — TTL expired (1h) or worker died
            // before writing the first progress event. Without this
            // branch the poll loop runs forever and ``restoring`` stays
            // true, locking the UI. Treat as terminal: clear the
            // stashed job_id, drop the bar, let the user start fresh.
            if (pollRef.current != null) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
            try {
              window.localStorage.removeItem('restoreJobId');
            } catch {
              /* ignore */
            }
            setRestoring(false);
            setRestoreProgress(null);
            toast.error('Restore status lost', {
              description:
                'The worker either never picked up the job or the status TTL expired. Try again.',
            });
          }
        } catch {
          // Network blip — keep polling. The job is on the worker side
          // so a transient API blip doesn't lose progress.
        }
      };
      // Kick off an immediate first poll so the bar appears within a
      // second of the upload finishing, then settle into a 2s cadence.
      void tick();
      pollRef.current = window.setInterval(() => void tick(), 2000);
    },
    [toast, refresh],
  );

  // F-USER-FIX (v0.29.5): browser-blocking guard during the upload
  // phase. The 22GB single-POST upload dies on tab navigation and on
  // any reverse-proxy timeout, so we set up beforeunload + a confirm
  // dialog while ``restoring`` is true AND the stage is still
  // "uploading". After enqueue (stage transitions to "queued" /
  // "extract" / etc.) the work is fully on the worker — the user can
  // navigate freely and the resume-on-mount effect picks the bar
  // back up.
  useEffect(() => {
    if (!restoring || restoreProgress?.stage !== 'uploading') return;
    const handler = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue =
        'Restore upload is in progress. Leaving this page aborts the upload — you will have to start over.';
      return ev.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [restoring, restoreProgress?.stage]);

  const onRestoreFromExisting = async () => {
    if (!selectedExisting) {
      toast.error('Pick an existing archive from the dropdown first');
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
    setRestoreProgress({
      stage: 'queued',
      progress_pct: 0,
      message: 'Enqueueing restore from existing archive…',
    });
    try {
      const params = new URLSearchParams();
      if (allowKeyMismatch) params.set('allow_key_mismatch', 'true');
      if (!restoreDb) params.set('restore_db', 'false');
      if (!restoreMedia) params.set('restore_media', 'false');
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(
        `/api/v1/backup/restore-existing/${encodeURIComponent(selectedExisting)}${qs}`,
        {
          method: 'POST',
          headers: { 'X-Confirm-Restore': 'i-understand' },
        },
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new ApiError(res.status, res.statusText, detail.detail ?? res.statusText);
      }
      const data = await res.json();
      if (!data.job_id) throw new ApiError(0, 'no job_id', JSON.stringify(data));
      setRestoreProgress({
        stage: 'queued',
        progress_pct: 0,
        message: 'Restore enqueued. Waiting for worker…',
      });
      pollRestoreStatus(data.job_id);
    } catch (err) {
      toast.error('Restore enqueue failed', { description: formatError(err) });
      setRestoring(false);
      setRestoreProgress(null);
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
    setRestoreProgress({
      stage: 'uploading',
      progress_pct: 0,
      message: `Uploading ${file.name}…`,
    });
    try {
      const fd = new FormData();
      fd.append('file', file);
      const params = new URLSearchParams();
      if (allowKeyMismatch) params.set('allow_key_mismatch', 'true');
      if (!restoreDb) params.set('restore_db', 'false');
      if (!restoreMedia) params.set('restore_media', 'false');
      const qs = params.toString() ? `?${params.toString()}` : '';

      // XHR (not fetch) so we get an upload-progress event for the
      // multi-GB body. fetch() doesn't expose upload progress in any
      // browser today.
      const xhr = new XMLHttpRequest();
      const responseText: string = await new Promise((resolve, reject) => {
        xhr.open('POST', `/api/v1/backup/restore${qs}`);
        xhr.setRequestHeader('X-Confirm-Restore', 'i-understand');
        xhr.upload.addEventListener('progress', (ev) => {
          if (ev.lengthComputable) {
            const pct = Math.round((ev.loaded / ev.total) * 100);
            setRestoreProgress({
              stage: 'uploading',
              progress_pct: pct,
              message: `Uploading ${file.name} (${pct}%)…`,
            });
          }
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
          else reject(new ApiError(xhr.status, xhr.statusText, xhr.responseText));
        });
        xhr.addEventListener('error', () =>
          reject(new ApiError(xhr.status || 0, 'network error', xhr.responseText)),
        );
        xhr.send(fd);
      });

      const data = JSON.parse(responseText) as { job_id?: string };
      if (!data.job_id) {
        throw new ApiError(0, 'no job_id', responseText);
      }
      setRestoreProgress({
        stage: 'queued',
        progress_pct: 0,
        message: 'Upload complete — restore enqueued. Waiting for worker…',
      });
      pollRestoreStatus(data.job_id);
    } catch (err) {
      toast.error('Restore upload failed', { description: formatError(err) });
      setRestoring(false);
      setRestoreProgress(null);
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
            <div className="text-txt-muted uppercase tracking-wider mb-1">Directory (container)</div>
            <div className="text-txt-primary font-mono break-all">
              {state.backup_directory_abs || state.backup_directory}
            </div>
            {state.backup_directory_host_source && (
              <>
                <div className="text-txt-muted uppercase tracking-wider mt-3 mb-1">On host</div>
                <div className="text-accent font-mono break-all">
                  {state.backup_directory_host_source}
                </div>
                {hostHintFromVmLabel(state.backup_directory_host_source) && (
                  <div className="mt-2 text-[11px] text-txt-secondary leading-relaxed">
                    {hostHintFromVmLabel(state.backup_directory_host_source)}
                  </div>
                )}
              </>
            )}
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
          Can't find a backup on your host? Run{' '}
          <code className="text-[11px]">
            docker inspect -f &quot;&#123;&#123;range .Mounts&#125;&#125;&#123;&#123;if eq .Destination
            \&quot;/app/storage\&quot;&#125;&#125;&#123;&#123;.Source&#125;&#125;&#123;&#123;end&#125;&#125;&#123;&#123;end&#125;&#125;&quot;
            $(docker ps -q --filter &quot;name=app&quot;)
          </code>{' '}
          to see the exact host directory Docker bound when the container started.
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
          <div className="flex gap-2">
            <Button onClick={onProbe} disabled={probing} variant="ghost">
              {probing ? 'Probing...' : 'Diagnose serving'}
            </Button>
            <Button onClick={onRepair} disabled={repairing} variant="primary">
              {repairing ? 'Scanning...' : 'Repair now'}
            </Button>
          </div>
        </div>
        {probeReport && (
          <div className="mt-4 space-y-3 rounded bg-bg-elevated p-3 text-xs">
            <div className="font-mono text-txt-primary space-y-0.5">
              <div>
                inside container: {probeReport.storage_base_path}
                {probeReport.process_uid !== null && (
                  <> · uid={probeReport.process_uid}</>
                )}
                {probeReport.mount_fs && (
                  <> · fs={probeReport.mount_fs}
                    {(probeReport.mount_fs === 'cifs' ||
                      probeReport.mount_fs === 'smb3' ||
                      probeReport.mount_fs === 'nfs' ||
                      probeReport.mount_fs === 'nfs4') && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent/10 text-accent">
                        {probeReport.mount_fs === 'cifs' || probeReport.mount_fs === 'smb3'
                          ? 'SMB/CIFS share'
                          : 'NFS share'}
                      </span>
                    )}
                  </>
                )}
              </div>
              {probeReport.host_source_path && (
                <div className="text-accent">
                  on host: {probeReport.host_source_path}
                </div>
              )}
            </div>
            {probeReport.hints.length > 0 && (
              <ul className="space-y-2">
                {probeReport.hints.map((h, i) => (
                  <li
                    key={i}
                    className="rounded bg-amber-500/10 border border-amber-500/30 p-2 text-amber-200"
                  >
                    {h}
                  </li>
                ))}
              </ul>
            )}
            {probeReport.top_level_entries && (
              <details className="rounded bg-bg-base p-2" open>
                <summary className="cursor-pointer text-txt-secondary">
                  What the container sees at /app/storage
                  {typeof probeReport.total_visible_count === 'number' && (
                    <span className="ml-2 text-txt-muted">
                      ({probeReport.total_visible_count} entries,{' '}
                      {formatBytes(probeReport.total_visible_bytes || 0)} visible)
                    </span>
                  )}
                </summary>
                {probeReport.top_level_entries.length === 0 ? (
                  <div className="mt-2 text-txt-muted">
                    No top-level entries. The storage directory is empty inside the
                    container — whatever you have on the host is not reaching this
                    bind mount.
                  </div>
                ) : (
                  <div className="mt-2 space-y-1 font-mono text-[11px]">
                    {probeReport.top_level_entries.map((e, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <span
                          className={[
                            'shrink-0 w-10 text-[10px] uppercase font-sans tracking-wider',
                            e.kind === 'dir'
                              ? 'text-accent'
                              : e.kind === 'file'
                                ? 'text-txt-secondary'
                                : 'text-txt-muted',
                          ].join(' ')}
                        >
                          {e.kind || '?'}
                        </span>
                        <span className="min-w-0 truncate text-txt-primary">
                          {e.name}
                        </span>
                        <span className="ml-auto shrink-0 text-txt-muted">
                          {e.kind === 'file' && typeof e.size_bytes === 'number'
                            ? formatBytes(e.size_bytes)
                            : e.kind === 'dir'
                              ? `${e.child_count}${e.child_count_capped ? '+' : ''} children`
                              : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[10px] text-txt-muted">
                  If what you see here doesn't match what's in{' '}
                  <code className="bg-bg-elevated px-1 rounded">
                    %USERPROFILE%\Drevalis\storage\
                  </code>{' '}
                  on your host, the running container was started from a
                  different directory than the one you copied files into. In a
                  terminal at <code className="bg-bg-elevated px-1 rounded">
                    %USERPROFILE%\Drevalis\
                  </code>: <code className="bg-bg-elevated px-1 rounded">
                    docker compose down; docker compose up -d
                  </code>.
                </div>
              </details>
            )}
            {probeReport.samples.length > 0 && (
              <details className="rounded bg-bg-base p-2">
                <summary className="cursor-pointer text-txt-secondary">
                  Probe samples ({probeReport.samples.length})
                </summary>
                <div className="mt-2 space-y-1 font-mono">
                  {probeReport.samples.map((s, i) => (
                    <div key={i} className="truncate flex items-start gap-2">
                      <span className="shrink-0 w-16 font-sans text-[10px] uppercase tracking-wider text-txt-tertiary">
                        {s.asset_type}
                      </span>
                      <span
                        className={[
                          'shrink-0 w-16 font-sans text-[10px] uppercase tracking-wider',
                          s.readable
                            ? 'text-emerald-300'
                            : s.exists
                              ? 'text-amber-300'
                              : 'text-error',
                        ].join(' ')}
                      >
                        {s.readable ? 'readable' : s.exists ? 'exists' : 'missing'}
                      </span>
                      <span className="min-w-0 truncate text-txt-secondary">
                        {s.abs_path}
                        {s.error && <> — {s.error}</>}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
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
                    <div key={i} className="truncate flex items-start gap-2">
                      <span className="shrink-0 font-sans text-[10px] uppercase tracking-wider">
                        {p.basename_on_disk ? (
                          <span className="text-amber-300">bytes nearby</span>
                        ) : (
                          <span className="text-error">missing</span>
                        )}
                      </span>
                      <span className="min-w-0 truncate">{p.path}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-txt-muted">
                  <strong className="text-txt-primary">bytes nearby</strong> — the filename exists
                  somewhere under the storage root but the repair couldn't confidently match it
                  (ambiguous duplicates, missing size on DB row). You can often recover by
                  regenerating the specific scene; safe to ignore otherwise.
                  <br />
                  <strong className="text-txt-primary">missing</strong> — the file truly isn't on
                  disk. Regenerate the affected episode or delete the orphan row.
                </p>
              </details>
            )}
            {repairReport.storage_base_abs && (
              <p className="text-[11px] text-txt-tertiary mt-2 font-mono">
                storage root: {repairReport.storage_base_abs}
                {typeof repairReport.indexed_files === 'number' && (
                  <> · indexed {repairReport.indexed_files} files</>
                )}
              </p>
            )}
            {(repairReport.sample_db_paths?.length ||
              repairReport.sample_disk_paths?.length) ? (
              <div className="mt-3 grid md:grid-cols-2 gap-3">
                <div className="rounded bg-bg-elevated p-3">
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-2">
                    Sample DB paths ({repairReport.sample_db_paths?.length ?? 0})
                  </div>
                  <div className="font-mono text-[11px] text-txt-primary space-y-1 break-all">
                    {(repairReport.sample_db_paths || []).length === 0 ? (
                      <div className="text-txt-muted">No media_assets rows with a file_path.</div>
                    ) : (
                      (repairReport.sample_db_paths || []).map((p, i) => (
                        <div key={i}>{p}</div>
                      ))
                    )}
                  </div>
                </div>
                <div className="rounded bg-bg-elevated p-3">
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-2">
                    Sample disk paths ({repairReport.sample_disk_paths?.length ?? 0})
                  </div>
                  <div className="font-mono text-[11px] text-txt-primary space-y-1 break-all">
                    {(repairReport.sample_disk_paths || []).length === 0 ? (
                      <div className="text-txt-muted">
                        Index empty — container sees no files under storage_root. The
                        bind mount is pointing at the wrong directory.
                      </div>
                    ) : (
                      (repairReport.sample_disk_paths || []).map((p, i) => (
                        <div key={i}>{p}</div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : null}
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
          {/* Path A — pick an archive already in BACKUP_DIRECTORY (no upload). */}
          {state && state.archives.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-txt-secondary mb-1">
                1a. Pick an archive already on disk{' '}
                <span className="text-txt-muted font-normal">
                  (recommended for archives &gt;5 GB)
                </span>
              </label>
              <select
                value={selectedExisting}
                onChange={(e) => {
                  setSelectedExisting(e.target.value);
                  // Clear the file picker so the two paths stay mutually exclusive.
                  if (e.target.value && fileInputRef.current) {
                    fileInputRef.current.value = '';
                  }
                }}
                disabled={restoring}
                className="block w-full text-sm bg-bg-elevated text-txt-primary rounded p-2 border border-bg-hover"
              >
                <option value="">— pick an archive —</option>
                {state.archives.map((a) => (
                  <option key={a.filename} value={a.filename}>
                    {a.filename} · {formatBytes(a.size_bytes)} ·{' '}
                    {new Date(a.created_at).toLocaleString()}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-txt-muted leading-relaxed">
                Place multi-GB archives directly in{' '}
                <span className="font-mono">BACKUP_DIRECTORY</span> via{' '}
                <span className="font-mono">docker cp</span> or the host bind-mount, then refresh
                the list. This skips the browser upload entirely — no proxy timeouts, no
                navigation issues.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-txt-secondary mb-1">
              1b. …or upload a new archive (.tar.gz){' '}
              <span className="text-txt-muted font-normal">(only safe for &lt;5 GB)</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tar.gz,application/gzip"
              disabled={restoring}
              onChange={() => {
                // Mutually exclusive with the existing-archive picker.
                if (fileInputRef.current?.files?.[0]) setSelectedExisting('');
              }}
              className="block w-full text-sm text-txt-primary file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-bg-elevated file:text-txt-primary hover:file:bg-bg-hover disabled:opacity-50"
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
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={onRestoreFromExisting}
              disabled={
                restoring ||
                !selectedExisting ||
                restoreConfirm !== 'RESTORE' ||
                (!restoreDb && !restoreMedia)
              }
              variant="primary"
              className="bg-amber-500 hover:bg-amber-400 text-bg-base"
            >
              <Archive className="w-4 h-4 mr-1" />
              {restoring && selectedExisting
                ? 'Restoring...'
                : 'Restore from picked archive'}
            </Button>
            <Button
              onClick={onRestore}
              disabled={
                restoring ||
                restoreConfirm !== 'RESTORE' ||
                (!restoreDb && !restoreMedia)
              }
              variant="primary"
              className="bg-amber-500/80 hover:bg-amber-500 text-bg-base"
            >
              <Upload className="w-4 h-4 mr-1" />
              {restoring && !selectedExisting ? 'Restoring...' : 'Upload + restore'}
            </Button>
          </div>

          {restoreProgress && (
            <div
              className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-3"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center justify-between text-xs text-txt-secondary mb-1">
                <span>
                  Stage: <span className="font-mono text-txt-primary">{restoreProgress.stage}</span>
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-txt-primary">
                    {restoreProgress.progress_pct}%
                  </span>
                  {(restoreProgress.stage === 'done' ||
                    restoreProgress.stage === 'failed' ||
                    restoreProgress.stage === 'resuming') && (
                    <button
                      type="button"
                      onClick={() => {
                        if (pollRef.current != null) {
                          window.clearInterval(pollRef.current);
                          pollRef.current = null;
                        }
                        try {
                          window.localStorage.removeItem('restoreJobId');
                        } catch {
                          /* ignore */
                        }
                        setRestoring(false);
                        setRestoreProgress(null);
                      }}
                      className="text-[10px] text-txt-muted hover:text-txt-primary underline"
                    >
                      dismiss
                    </button>
                  )}
                </div>
              </div>
              <div
                className="h-2 w-full rounded bg-bg-elevated overflow-hidden"
                role="progressbar"
                aria-valuenow={restoreProgress.progress_pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={
                    restoreProgress.stage === 'failed'
                      ? 'h-full bg-red-500 transition-all duration-200'
                      : restoreProgress.stage === 'done'
                        ? 'h-full bg-green-500 transition-all duration-200'
                        : 'h-full bg-amber-500 transition-all duration-200'
                  }
                  style={{ width: `${restoreProgress.progress_pct}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-txt-secondary">{restoreProgress.message}</div>
              {restoreProgress.stage === 'uploading' ? (
                <div className="mt-1 text-[11px] text-red-400 leading-relaxed">
                  <strong>Don't navigate away.</strong> The upload is browser-bound — leaving
                  this page aborts it and you'll have to start over. For multi-GB archives,
                  cancel and use "Restore from picked archive" instead.
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-txt-muted">
                  Safe to navigate away — the restore runs in the background on the worker.
                  Come back to this page to see progress.
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
