import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  RefreshCw,
  Download,
  FileText,
  ImageIcon,
  Subtitles,
  Info,
  RotateCcw,
  AlertTriangle,
  Copy,
  Trash2,
  Mic,
  Loader2,
  Square,
  Film,
  Archive,
  Upload,
  ChevronDown,
  Music,
  CalendarDays,
  Search,
  Scissors,
  ListChecks,
  MoreHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { ThumbnailEditor } from '@/components/episode/ThumbnailEditor';
import { Spinner } from '@/components/ui/Spinner';
import { VideoPlayer } from '@/components/video/VideoPlayer';
import { JobProgressBar } from '@/components/jobs/JobProgressBar';
import * as Popover from '@radix-ui/react-popover';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { Tooltip } from '@/components/ui/Tooltip';
import { episodes as episodesApi, youtube as youtubeApi, voiceProfiles as voiceProfilesApi, schedule as scheduleApi } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { useEpisodeProgress } from '@/lib/websocket';
import type { Episode, MediaAsset, PipelineStep, YouTubeUploadRequest, VoiceProfile } from '@/types';
import type { SceneDataExtended } from './sections/helpers';

// ---------------------------------------------------------------------------
// Lazy-loaded tab components
// ---------------------------------------------------------------------------

const ScriptTab = lazy(() =>
  import('./sections/ScriptTab').then((m) => ({ default: m.ScriptTab })),
);
const ScenesTab = lazy(() =>
  import('./sections/ScenesTab').then((m) => ({ default: m.ScenesTab })),
);
const CaptionsTab = lazy(() =>
  import('./sections/CaptionsTab').then((m) => ({ default: m.CaptionsTab })),
);
const MusicTab = lazy(() =>
  import('./sections/MusicTab').then((m) => ({ default: m.MusicTab })),
);
const MetadataTab = lazy(() =>
  import('./sections/MetadataTab').then((m) => ({ default: m.MetadataTab })),
);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'script', label: 'Script', icon: FileText },
  { id: 'scenes', label: 'Scenes', icon: ImageIcon },
  { id: 'captions', label: 'Captions', icon: Subtitles },
  { id: 'music', label: 'Music', icon: Music },
  { id: 'metadata', label: 'Metadata', icon: Info },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ---------------------------------------------------------------------------
// Action state — discriminated union replaces 12 separate booleans
// ---------------------------------------------------------------------------

type ActionState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'retrying' }
  | { kind: 'reassembling' }
  | { kind: 'revoicing' }
  | { kind: 'duplicating' }
  | { kind: 'resetting' }
  | { kind: 'cancelling' }
  | { kind: 'deleting' }
  | { kind: 'uploading' }
  | { kind: 'scheduling' }
  | { kind: 'publishingAll' }
  | { kind: 'generatingSeo' };

// ---------------------------------------------------------------------------
// Episode Detail Page
// ---------------------------------------------------------------------------

function EpisodeDetail() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();

  const [episode, setEpisode] = useState<Episode | null>(null);
  const [loading, setLoading] = useState(true);
  const prevEpisodeStatusRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('script');

  // Single discriminated-union for all mutually-exclusive action states
  const [action, setAction] = useState<ActionState>({ kind: 'idle' });

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Voice profiles and per-episode overrides
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [epVoiceId, setEpVoiceId] = useState<string>('');
  const [epCaptionStyle, setEpCaptionStyle] = useState<string>('');

  // YouTube upload state
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [thumbEditorOpen, setThumbEditorOpen] = useState(false);
  const [publishAllOpen, setPublishAllOpen] = useState(false);
  const [publishAllPlatforms, setPublishAllPlatforms] = useState<
    Record<'youtube' | 'tiktok' | 'instagram', boolean>
  >({ youtube: true, tiktok: true, instagram: true });
  const [ytTitle, setYtTitle] = useState('');
  const [ytDescription, setYtDescription] = useState('');
  const [ytTags, setYtTags] = useState('');
  const [ytPrivacy, setYtPrivacy] = useState('public');

  // Schedule dialog state
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [schedPlatform, setSchedPlatform] = useState('youtube');
  const [schedDatetime, setSchedDatetime] = useState('');
  const [schedTitle, setSchedTitle] = useState('');
  const [schedPrivacy, setSchedPrivacy] = useState('public');

  // SEO dialog state
  const [seoOpen, setSeoOpen] = useState(false);
  const [seoData, setSeoData] = useState<{
    title: string;
    description: string;
    hashtags: string[];
    tags: string[];
    hook: string;
    virality_score?: number;
  } | null>(null);

  // Toast notifications
  const { toast } = useToast();

  // WebSocket progress
  const { latestByStep } = useEpisodeProgress(
    episode?.status === 'generating' ? episodeId : null,
  );

  // Fetch episode data
  const fetchEpisode = useCallback(async () => {
    if (!episodeId) return;
    try {
      const ep = await episodesApi.get(episodeId);
      const previousStatus = prevEpisodeStatusRef.current;
      prevEpisodeStatusRef.current = ep.status;
      setEpisode(ep);
      // Auto-generate SEO when generation completes and no SEO data yet
      if (
        previousStatus === 'generating' &&
        ep.status === 'review' &&
        !(ep.metadata_?.seo)
      ) {
        episodesApi.generateSeo(episodeId).then((seoResult) => {
          return episodesApi.update(episodeId, {
            metadata_: {
              ...(ep.metadata_ as Record<string, unknown> ?? {}),
              seo: seoResult,
            },
          } as any);
        }).catch(() => {
          // Non-fatal: SEO generation failure should not disrupt the UX
        });
      }
    } catch (err) {
      toast.error('Failed to load episode', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [episodeId]);

  useEffect(() => {
    void fetchEpisode();
  }, [fetchEpisode]);

  // Refresh when generation completes (WebSocket-based)
  useEffect(() => {
    if (!episode || episode.status !== 'generating') return;
    const allDone = Object.values(latestByStep).every(
      (msg) => msg.status === 'done' || msg.status === 'failed',
    );
    if (allDone && Object.keys(latestByStep).length > 0) {
      const timer = setTimeout(() => void fetchEpisode(), 2000);
      return () => clearTimeout(timer);
    }
  }, [latestByStep, episode, fetchEpisode]);

  // Polling fallback: re-fetch every 3s while generating
  // Catches cases where WebSocket messages are missed
  useEffect(() => {
    if (!episode || episode.status !== 'generating') return;
    const interval = setInterval(() => void fetchEpisode(), 3000);
    return () => clearInterval(interval);
  }, [episode?.status, fetchEpisode]);

  // Check YouTube connection status
  useEffect(() => {
    youtubeApi
      .getStatus()
      .then((res) => setYoutubeConnected(res.connected))
      .catch(() => setYoutubeConnected(false));
  }, []);

  // Load voice profiles on mount
  useEffect(() => {
    voiceProfilesApi.list().then(setVoiceProfiles).catch(() => {});
  }, []);

  // Sync per-episode overrides from episode data
  useEffect(() => {
    if (episode) {
      setEpVoiceId(episode.override_voice_profile_id || '');
      setEpCaptionStyle(episode.override_caption_style || '');
    }
  }, [episode]);

  // Pre-fill YouTube upload dialog from script metadata
  useEffect(() => {
    if (uploadDialogOpen && episode) {
      const script = (episode.script ?? {}) as Record<string, unknown>;
      // Title: prefer script title, fall back to episode title
      setYtTitle((script['title'] as string) || episode.title || '');
      // Description: prefer script description, fall back to empty
      setYtDescription((script['description'] as string) || '');
      // Tags: prefer script hashtags, fall back to empty
      const hashtags = script['hashtags'] as string[] | undefined;
      setYtTags(
        Array.isArray(hashtags) && hashtags.length > 0
          ? hashtags.join(', ')
          : '',
      );
    }
  }, [uploadDialogOpen, episode]);

  // ---- Handlers ----

  const handleGenerate = async (steps?: PipelineStep[]) => {
    if (!episodeId) return;
    setAction({ kind: 'generating' });
    try {
      await episodesApi.generate(episodeId, steps ? { steps } : undefined);
      toast.success('Episode generation started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to start generation', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleRetry = async () => {
    if (!episodeId) return;
    setAction({ kind: 'retrying' });
    try {
      await episodesApi.retry(episodeId);
      toast.success('Episode generation started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to retry generation', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleRetryStep = async (step: PipelineStep) => {
    if (!episodeId) return;
    try {
      await episodesApi.retryStep(episodeId, step);
      toast.success('Episode generation started');
      void fetchEpisode();
    } catch (err) {
      toast.error(`Failed to retry step: ${step}`, { description: String(err) });
    }
  };

  const handleReassemble = async () => {
    if (!episodeId) return;
    setAction({ kind: 'reassembling' });
    try {
      await episodesApi.reassemble(episodeId);
      toast.success('Reassembly started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to reassemble episode', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleRegenerateVoice = async () => {
    if (!episodeId) return;
    setAction({ kind: 'revoicing' });
    try {
      await episodesApi.regenerateVoice(episodeId, epVoiceId || undefined);
      toast.success('Voice regeneration started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to regenerate voice', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleDuplicate = async () => {
    if (!episodeId) return;
    setAction({ kind: 'duplicating' });
    try {
      const dup = await episodesApi.duplicate(episodeId);
      navigate(`/episodes/${dup.id}`);
    } catch (err) {
      toast.error('Failed to duplicate episode', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleReset = async () => {
    if (!episodeId) return;
    setAction({ kind: 'resetting' });
    try {
      await episodesApi.resetToDraft(episodeId);
      toast.success('Episode reset to draft');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to reset episode', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleCancel = async () => {
    if (!episodeId) return;
    setAction({ kind: 'cancelling' });
    try {
      await episodesApi.cancel(episodeId);
      setCancelDialogOpen(false);
      toast.success('Generation cancelled');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to cancel generation', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleDelete = async () => {
    if (!episodeId) return;
    setAction({ kind: 'deleting' });
    try {
      await episodesApi.delete(episodeId);
      navigate('/episodes');
    } catch (err) {
      toast.error('Failed to delete episode', { description: String(err) });
      setAction({ kind: 'idle' });
    }
  };

  const handleYouTubeUpload = async () => {
    if (!episodeId) return;
    setAction({ kind: 'uploading' });
    try {
      const data: YouTubeUploadRequest = {
        title: ytTitle,
        description: ytDescription,
        tags: ytTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        privacy_status: ytPrivacy as 'public' | 'unlisted' | 'private',
      };
      await youtubeApi.upload(episodeId, data);
      setUploadDialogOpen(false);
      toast.success('Upload to YouTube started');
    } catch (err) {
      toast.error('Failed to upload to YouTube', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  const handleSeo = async () => {
    if (!episodeId) return;
    setAction({ kind: 'generatingSeo' });
    try {
      const data = await episodesApi.generateSeo(episodeId);
      setSeoData(data);
      setSeoOpen(true);
      // Persist SEO data to episode metadata so it shows without re-generating
      await episodesApi.update(episodeId, {
        metadata_: {
          ...(episode?.metadata_ as Record<string, unknown> ?? {}),
          seo: data,
        },
      } as any);
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to generate SEO data', { description: String(err) });
    } finally {
      setAction({ kind: 'idle' });
    }
  };

  // ---- Derived data ----

  const videoAsset = episode?.media_assets.find(
    (a: MediaAsset) => a.asset_type === 'video',
  );
  const videoUrl = videoAsset?.file_path
    ? `/storage/${videoAsset.file_path}`
    : null;
  const captionsAsset = episode?.media_assets.find(
    (a: MediaAsset) => a.asset_type === 'caption' && a.file_path.endsWith('.srt'),
  );

  // Build scene data from script and media assets
  const scenes = useMemo<SceneDataExtended[]>(() => {
    if (!episode?.script) return [];
    const scriptData = episode.script as Record<string, unknown>;
    const segments = (scriptData['scenes'] ?? scriptData['segments']) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(segments)) return [];
    return segments.map((seg, idx) => {
      const sceneNum = idx + 1;
      const sceneAsset = episode.media_assets.find(
        (a: MediaAsset) =>
          a.asset_type === 'scene' && a.scene_number === sceneNum,
      );
      return {
        sceneNumber: sceneNum,
        imageUrl: sceneAsset?.file_path
          ? `/storage/${sceneAsset.file_path}`
          : null,
        prompt:
          (seg['visual_prompt'] as string) ?? (seg['narration'] as string) ?? '',
        durationSeconds: (seg['duration_seconds'] as number) ?? 3,
        narration: (seg['narration'] as string) ?? (seg['text'] as string) ?? '',
        visualPrompt: (seg['visual_prompt'] as string) ?? '',
        keywords: (seg['keywords'] as string[]) ?? [],
      };
    });
  }, [episode]);

  // Build step progress from generation_jobs (static) + WS (real-time)
  const jobStepProgress: Record<string, { status: string; progress_pct: number; message: string; step: string; job_id: string; episode_id: string; error: null; detail: null }> = {};
  if (episode) {
    for (const job of episode.generation_jobs) {
      jobStepProgress[job.step] = {
        status: job.status,
        progress_pct: job.progress_pct,
        message: job.error_message ?? '',
        step: job.step,
        job_id: job.id,
        episode_id: episode.id,
        error: null,
        detail: null,
      };
    }
  }
  const mergedProgress = { ...jobStepProgress, ...latestByStep };

  const hasFailed = episode?.status === 'failed';
  const canGenerate =
    episode?.status === 'draft' || episode?.status === 'failed';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!episode) {
    return (
      <div className="text-center py-20">
        <p className="text-txt-secondary">Episode not found</p>
        <Button
          variant="ghost"
          className="mt-4"
          onClick={() => navigate('/')}
        >
          <ArrowLeft size={14} />
          Back to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'Episodes', to: '/episodes' },
          { label: episode.title || 'Episode' },
        ]}
        className="mb-1"
      />

      {/* Back + Title */}
      <div className="flex items-center gap-3">
        <Tooltip content="Back">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="Go back">
            <ArrowLeft size={14} />
          </Button>
        </Tooltip>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg md:text-xl font-bold text-txt-primary">
              {episode.title}
            </h1>
            <Badge variant={episode.status} dot>
              {episode.status}
            </Badge>
            {typeof (episode.metadata_?.seo as Record<string, unknown> | undefined)?.virality_score === 'number' && (
              <Badge
                variant={
                  ((episode.metadata_!.seo as Record<string, unknown>).virality_score as number) >= 7
                    ? 'success'
                    : ((episode.metadata_!.seo as Record<string, unknown>).virality_score as number) >= 5
                      ? 'warning'
                      : 'neutral'
                }
              >
                {String.fromCodePoint(0x1F525)}{' '}
                {((episode.metadata_!.seo as Record<string, unknown>).virality_score as number)}/10
              </Badge>
            )}
          </div>
          {episode.topic && (
            <p className="text-sm text-txt-secondary mt-0.5">
              {episode.topic}
            </p>
          )}
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Primary actions */}
        {canGenerate && (
          <Button
            variant="primary"
            size="sm"
            loading={action.kind === 'generating'}
            onClick={() => void handleGenerate()}
          >
            <Play size={14} />
            Generate All
          </Button>
        )}

        {episode.status === 'review' && (
          <>
            {/* Primary actions — Edit + Storyboard, the two things a
                user typically does next. The pipeline-tweaking actions
                (Reassemble, Re-voice, SEO, Schedule) live behind the
                "More" menu so the toolbar fits at 1280px without
                clipping. */}
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate(`/episodes/${episode.id}/edit`)}
              aria-label="Open the video editor"
            >
              <Scissors size={14} />
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/episodes/${episode.id}/shot-list`)}
              aria-label="Open the shot list overview"
            >
              <ListChecks size={14} />
              Shot list
            </Button>
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button variant="secondary" size="sm" aria-label="More pipeline actions">
                  <MoreHorizontal size={14} />
                  More
                  <ChevronDown size={12} />
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  sideOffset={4}
                  className="w-52 bg-bg-surface border border-border rounded-lg shadow-xl z-[50] py-1 animate-fade-in"
                >
                  <Popover.Close asChild>
                    <button
                      type="button"
                      onClick={() => void handleReassemble()}
                      disabled={action.kind !== 'idle'}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-txt-primary hover:bg-bg-hover disabled:opacity-50"
                    >
                      <RefreshCw size={14} />
                      {action.kind === 'reassembling' ? 'Reassembling…' : 'Reassemble'}
                    </button>
                  </Popover.Close>
                  <Popover.Close asChild>
                    <button
                      type="button"
                      onClick={() => void handleRegenerateVoice()}
                      disabled={action.kind !== 'idle'}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-txt-primary hover:bg-bg-hover disabled:opacity-50"
                    >
                      <Mic size={14} />
                      {action.kind === 'revoicing' ? 'Re-voicing…' : 'Re-voice'}
                    </button>
                  </Popover.Close>
                  <Popover.Close asChild>
                    <button
                      type="button"
                      onClick={() => void handleSeo()}
                      disabled={action.kind !== 'idle'}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-txt-primary hover:bg-bg-hover disabled:opacity-50"
                      aria-label="Generate SEO optimization for this episode"
                    >
                      <Search size={14} />
                      {action.kind === 'generatingSeo' ? 'Generating SEO…' : 'SEO'}
                    </button>
                  </Popover.Close>
                  <Popover.Close asChild>
                    <button
                      type="button"
                      onClick={() => {
                        const script = (episode.script ?? {}) as Record<string, unknown>;
                        const pad = (n: number) => String(n).padStart(2, '0');
                        const now = new Date();
                        now.setDate(now.getDate() + 1);
                        now.setHours(12, 0, 0, 0);
                        const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T12:00`;
                        setSchedDatetime(iso);
                        setSchedTitle((script['title'] as string) || episode.title || '');
                        setSchedPlatform('youtube');
                        setSchedPrivacy('public');
                        setScheduleDialogOpen(true);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-txt-primary hover:bg-bg-hover"
                    >
                      <CalendarDays size={14} />
                      Schedule
                    </button>
                  </Popover.Close>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </>
        )}

        {episode.status === 'generating' && (
          <Button
            variant="ghost"
            size="sm"
            className="text-error hover:text-error/80"
            loading={action.kind === 'cancelling'}
            onClick={() => setCancelDialogOpen(true)}
          >
            <Square size={14} />
            Cancel
          </Button>
        )}

        {hasFailed && (
          <Button
            variant="secondary"
            size="sm"
            loading={action.kind === 'retrying'}
            onClick={() => void handleRetry()}
          >
            <RotateCcw size={14} />
            Retry Failed
          </Button>
        )}

        {/* Secondary actions (right-aligned) */}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={action.kind === 'duplicating'}
            onClick={() => void handleDuplicate()}
          >
            <Copy size={14} />
            Duplicate
          </Button>

          {episode.status !== 'draft' && (
            <Button
              variant="ghost"
              size="sm"
              loading={action.kind === 'resetting'}
              onClick={() => void handleReset()}
            >
              <RotateCcw size={14} />
              Reset to Draft
            </Button>
          )}

          {videoUrl && (
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button variant="secondary" size="sm">
                  <Download size={14} /> Export
                  <ChevronDown size={12} />
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={4}
                  className="w-48 bg-bg-surface border border-border rounded-lg shadow-xl z-[50] animate-fade-in"
                >
                  <a
                    href={`/api/v1/episodes/${episodeId}/export/video`}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-txt-primary hover:bg-bg-hover rounded-t-lg"
                  >
                    <Film size={14} /> Video (.mp4)
                  </a>
                  <a
                    href={`/api/v1/episodes/${episodeId}/export/thumbnail`}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-txt-primary hover:bg-bg-hover"
                  >
                    <ImageIcon size={14} /> Thumbnail (.jpg)
                  </a>
                  <Popover.Close asChild>
                    <button
                      onClick={() => setThumbEditorOpen(true)}
                      className="flex items-center gap-2 w-full text-left px-3 py-2.5 text-sm text-txt-primary hover:bg-bg-hover"
                    >
                      <ImageIcon size={14} /> Edit thumbnail…
                    </button>
                  </Popover.Close>
                  <a
                    href={`/api/v1/episodes/${episodeId}/export/description`}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-txt-primary hover:bg-bg-hover"
                  >
                    <FileText size={14} /> Description (.txt)
                  </a>
                  <a
                    href={`/api/v1/episodes/${episodeId}/export/bundle`}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-txt-primary hover:bg-bg-hover border-t border-border"
                  >
                    <Archive size={14} /> Download All (.zip)
                  </a>
                  <a
                    href={`/api/v1/episodes/${episodeId}/export/raw-assets`}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-txt-primary hover:bg-bg-hover border-t border-border"
                    title="Per-scene images, voice segments, captions — useful for debugging or hand-editing"
                  >
                    <Archive size={14} /> Raw assets (.zip)
                  </a>
                  {youtubeConnected && (
                    <Popover.Close asChild>
                      <button
                        onClick={() => setUploadDialogOpen(true)}
                        className="flex items-center gap-2 w-full text-left px-3 py-2.5 text-sm text-error hover:bg-bg-hover border-t border-border"
                      >
                        <Upload size={14} /> Upload to YouTube
                      </button>
                    </Popover.Close>
                  )}
                  <Popover.Close asChild>
                    <button
                      onClick={() => setPublishAllOpen(true)}
                      className="flex items-center gap-2 w-full text-left px-3 py-2.5 text-sm text-accent hover:bg-bg-hover border-t border-border rounded-b-lg"
                    >
                      <Upload size={14} /> Publish everywhere…
                    </button>
                  </Popover.Close>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="text-error hover:text-error/80"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 size={14} />
            Delete
          </Button>
        </div>
      </div>

      {/* Enhanced progress card when generating */}
      {episode.status === 'generating' && (() => {
        const STEP_ORDER = ['script', 'voice', 'scenes', 'captions', 'assembly', 'thumbnail'] as const;
        const STEP_ETA: Record<string, string> = {
          script: '~10s',
          voice: '~30s',
          scenes: '~2-5 min',
          captions: '~20s',
          assembly: '~30s',
          thumbnail: '~10s',
        };
        const activeEntry = STEP_ORDER.map((s) => [s, mergedProgress[s]] as const)
          .find(([, msg]) => msg?.status === 'running');
        const activeStepName = activeEntry?.[0] ?? null;
        const activeMsg = activeEntry?.[1] ?? null;
        const overallPct = Math.round(
          STEP_ORDER.reduce((sum, s) => {
            const m = mergedProgress[s];
            if (!m) return sum;
            return sum + (m.status === 'done' ? 100 : m.progress_pct ?? 0);
          }, 0) / STEP_ORDER.length
        );
        return (
          <Card padding="md" className="border-accent/20 bg-accent/5">
            <div className="flex items-center gap-3 mb-3">
              <Loader2 size={16} className="text-accent animate-spin shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-txt-primary capitalize">
                    {activeStepName
                      ? `Generating: ${activeStepName}`
                      : 'Generation in progress...'}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    {activeStepName && (
                      <span className="text-xs text-txt-tertiary">
                        ETA {STEP_ETA[activeStepName] ?? '...'}
                      </span>
                    )}
                    <span className="text-sm font-mono font-bold text-accent tabular-nums">
                      {overallPct}%
                    </span>
                  </div>
                </div>
                {activeMsg?.message && (
                  <p className="text-xs text-txt-secondary mt-0.5 truncate">
                    {activeMsg.message}
                  </p>
                )}
              </div>
            </div>
            <JobProgressBar stepProgress={mergedProgress as Record<string, import('@/types').ProgressMessage>} />
          </Card>
        );
      })()}

      {/* Error banner */}
      {hasFailed && (
        <Card padding="md" className="border-error/30 bg-error-muted">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-error shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-error">
                Generation failed
              </p>
              {episode.generation_jobs
                .filter((j) => j.status === 'failed')
                .map((j) => (
                  <div
                    key={j.id}
                    className="mt-1 flex items-center gap-2"
                  >
                    <Badge variant={j.step}>{j.step}</Badge>
                    <span className="text-xs text-error/80">
                      {j.error_message ?? 'Unknown error'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void handleRetryStep(j.step as PipelineStep)
                      }
                    >
                      <RefreshCw size={12} />
                      Retry
                    </Button>
                  </div>
                ))}
            </div>
          </div>
        </Card>
      )}

      {/* Main layout: video + right panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Video player */}
        <div className="lg:col-span-4">
          <VideoPlayer
            src={videoUrl}
            scenes={(() => {
              let cumTime = 0;
              return scenes.map((s) => {
                const seg = {
                  startTime: cumTime,
                  endTime: cumTime + s.durationSeconds,
                  label: `Scene ${s.sceneNumber}`,
                };
                cumTime += s.durationSeconds;
                return seg;
              });
            })()}
          />
          {/* The inline VideoEditor block that used to live here was
              removed in v0.20.30 — the dedicated /episodes/:id/edit
              route + "Edit" action button in the header (Scissors
              icon) cover the same surface, and having two editors
              on two pages complicated state sync. */}
        </div>

        {/* Right: Tabbed panel */}
        <div className="lg:col-span-8">
          {/* Tab bar — horizontally scrollable on mobile */}
          <div className="flex overflow-x-auto scrollbar-hidden border-b border-border mb-4 -mb-px snap-x snap-mandatory">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors duration-fast',
                    'border-b-2 whitespace-nowrap snap-start',
                    'min-h-[44px] md:min-h-0',
                    isActive
                      ? 'border-accent text-accent'
                      : 'border-transparent text-txt-tertiary hover:text-txt-secondary',
                  ].join(' ')}
                >
                  <tab.icon size={14} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div className="min-h-[400px]">
            <Suspense fallback={<div className="flex items-center justify-center h-40"><Spinner /></div>}>
              {activeTab === 'script' && (
                <ScriptTab
                  episode={episode}
                  scenes={scenes}
                  onRefresh={fetchEpisode}
                  episodeId={episodeId!}
                  voiceProfiles={voiceProfiles}
                  epVoiceId={epVoiceId}
                  setEpVoiceId={setEpVoiceId}
                />
              )}
              {activeTab === 'scenes' && (
                <ScenesTab
                  episode={episode}
                  scenes={scenes}
                  onRefresh={fetchEpisode}
                />
              )}
              {activeTab === 'captions' && (
                <CaptionsTab
                  episode={episode}
                  captionsAsset={captionsAsset}
                  onRefresh={fetchEpisode}
                  episodeId={episodeId!}
                  epCaptionStyle={epCaptionStyle}
                  setEpCaptionStyle={setEpCaptionStyle}
                />
              )}
              {activeTab === 'music' && (
                <MusicTab episodeId={episodeId!} episode={episode} onChanged={() => void fetchEpisode()} />
              )}
              {activeTab === 'metadata' && <MetadataTab episode={episode} />}
            </Suspense>
          </div>
        </div>
      </div>

      {/* Cancel confirmation dialog */}
      <Dialog
        open={cancelDialogOpen}
        onClose={() => setCancelDialogOpen(false)}
        title="Cancel Generation?"
      >
        <p className="text-sm text-txt-secondary">
          This will stop the current generation pipeline for this episode.
          Any completed steps will be preserved, but in-progress work will be lost.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCancelDialogOpen(false)}>
            Keep Running
          </Button>
          <Button
            variant="destructive"
            loading={action.kind === 'cancelling'}
            onClick={() => void handleCancel()}
          >
            <Square size={14} />
            Cancel Generation
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        title="Delete Episode?"
      >
        <p className="text-sm text-txt-secondary">
          This will permanently delete the episode and all generated media.
          This action cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={action.kind === 'deleting'}
            onClick={() => void handleDelete()}
          >
            <Trash2 size={14} />
            Delete Forever
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Schedule Dialog */}
      <Dialog
        open={scheduleDialogOpen}
        onClose={() => setScheduleDialogOpen(false)}
        title="Schedule Post"
      >
        <div className="space-y-4">
          <Select
            label="Platform"
            value={schedPlatform}
            onChange={(e) => setSchedPlatform(e.target.value)}
            options={[
              { value: 'youtube', label: 'YouTube' },
              { value: 'tiktok', label: 'TikTok' },
              { value: 'instagram', label: 'Instagram' },
              { value: 'x', label: 'X (Twitter)' },
            ]}
          />
          <Input
            label="Scheduled date & time"
            type="datetime-local"
            value={schedDatetime}
            onChange={(e) => setSchedDatetime(e.target.value)}
          />
          <Input
            label="Title"
            value={schedTitle}
            onChange={(e) => setSchedTitle(e.target.value)}
            placeholder="Post title"
          />
          <Select
            label="Privacy"
            value={schedPrivacy}
            onChange={(e) => setSchedPrivacy(e.target.value)}
            options={[
              { value: 'private', label: 'Private' },
              { value: 'unlisted', label: 'Unlisted' },
              { value: 'public', label: 'Public' },
            ]}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setScheduleDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={action.kind === 'scheduling'}
            onClick={async () => {
              if (!episodeId) return;
              setAction({ kind: 'scheduling' });
              try {
                await scheduleApi.create({
                  content_type: 'episode',
                  content_id: episodeId,
                  platform: schedPlatform,
                  scheduled_at: new Date(schedDatetime).toISOString(),
                  title: schedTitle,
                  privacy: schedPrivacy,
                });
                setScheduleDialogOpen(false);
                toast.success('Post scheduled');
              } catch (err) {
                toast.error('Failed to schedule post', { description: String(err) });
              } finally {
                setAction({ kind: 'idle' });
              }
            }}
          >
            <CalendarDays size={14} />
            Schedule
          </Button>
        </DialogFooter>
      </Dialog>

      {/* YouTube Upload Dialog */}
      <Dialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        title="Upload to YouTube"
      >
        <div className="space-y-4">
          <Input
            label="Title"
            value={ytTitle}
            onChange={(e) => setYtTitle(e.target.value)}
            placeholder="Video title for YouTube"
          />
          <Textarea
            label="Description"
            value={ytDescription}
            onChange={(e) => setYtDescription(e.target.value)}
            className="min-h-[100px]"
            placeholder="Video description..."
          />
          <Input
            label="Tags (comma-separated)"
            value={ytTags}
            onChange={(e) => setYtTags(e.target.value)}
            placeholder="shorts, tutorial, medieval"
          />
          <Select
            label="Privacy"
            value={ytPrivacy}
            onChange={(e) => setYtPrivacy(e.target.value)}
            options={[
              { value: 'private', label: 'Private' },
              { value: 'unlisted', label: 'Unlisted' },
              { value: 'public', label: 'Public' },
            ]}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setUploadDialogOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={action.kind === 'uploading'}
            onClick={() => void handleYouTubeUpload()}
          >
            <Upload size={14} /> Upload
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Publish-everywhere dialog */}
      <Dialog
        open={publishAllOpen}
        onClose={() => setPublishAllOpen(false)}
        title="Publish everywhere"
        description="Fan out this episode to every platform you've connected. Platforms without a connected account will be skipped with a clear reason."
      >
        <div className="space-y-3 text-sm">
          {(['youtube', 'tiktok', 'instagram'] as const).map((p) => (
            <label
              key={p}
              className="flex items-center gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-bg-hover"
            >
              <input
                type="checkbox"
                checked={publishAllPlatforms[p]}
                onChange={(e) =>
                  setPublishAllPlatforms((prev) => ({ ...prev, [p]: e.target.checked }))
                }
                className="accent-accent"
              />
              <span className="flex-1 text-txt-primary">
                {p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : 'Instagram'}
              </span>
              {p === 'youtube' && (
                <span className="text-[11px] text-txt-muted">all tiers</span>
              )}
              {(p === 'tiktok' || p === 'instagram') && (
                <span className="text-[11px] text-amber-300">Studio tier</span>
              )}
            </label>
          ))}
          <p className="text-[11px] text-txt-muted">
            Uses the episode's SEO title + description when available. Uploads go to the
            Activity Monitor — you can cancel individual uploads from there.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPublishAllOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={action.kind === 'publishingAll'}
            disabled={!Object.values(publishAllPlatforms).some(Boolean)}
            onClick={async () => {
              const platforms = (Object.entries(publishAllPlatforms) as [
                'youtube' | 'tiktok' | 'instagram',
                boolean,
              ][])
                .filter(([, v]) => v)
                .map(([k]) => k);
              setAction({ kind: 'publishingAll' });
              try {
                const result = await episodesApi.publishAll(episodeId!, { platforms });
                const accepted = result.accepted.map((a) => a.platform);
                const skipped = result.skipped;
                if (accepted.length > 0) {
                  toast.success(`Publishing to ${accepted.join(', ')}`, {
                    description: skipped.length
                      ? `Skipped: ${skipped.map((s) => `${s.platform} (${s.reason})`).join('; ')}`
                      : 'Watch progress in the Activity Monitor.',
                  });
                } else if (skipped.length > 0) {
                  toast.error('Nothing to publish', {
                    description: skipped.map((s) => `${s.platform}: ${s.reason}`).join('; '),
                  });
                }
                setPublishAllOpen(false);
              } catch (err) {
                toast.error('Publish-all failed', { description: String(err) });
              } finally {
                setAction({ kind: 'idle' });
              }
            }}
          >
            Publish
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Thumbnail editor */}
      <ThumbnailEditor
        open={thumbEditorOpen}
        onClose={() => setThumbEditorOpen(false)}
        episodeId={episodeId ?? ''}
        currentThumbnailUrl={
          episode?.metadata_?.thumbnail_path
            ? `/storage/${episode.metadata_.thumbnail_path}`
            : null
        }
        onSaved={() => void fetchEpisode()}
      />

      {/* SEO Optimization Dialog */}
      <Dialog
        open={seoOpen}
        onClose={() => setSeoOpen(false)}
        title="SEO Optimization"
      >
        {action.kind === 'generatingSeo' ? (
          <div className="flex items-center justify-center py-10 gap-3">
            <Loader2 size={20} className="animate-spin text-accent" />
            <p className="text-sm text-txt-secondary">Generating SEO content — this may take up to 30 seconds...</p>
          </div>
        ) : seoData ? (
          <div className="space-y-4">
            {seoData.virality_score !== undefined && (
              <div className="flex items-center gap-2 p-3 bg-bg-elevated rounded-lg border border-border">
                <span className="text-xs font-semibold text-txt-secondary uppercase tracking-wide">Virality Score</span>
                <span
                  className={[
                    'ml-auto text-lg font-bold',
                    seoData.virality_score >= 75
                      ? 'text-success'
                      : seoData.virality_score >= 50
                        ? 'text-warning'
                        : 'text-txt-secondary',
                  ].join(' ')}
                >
                  {seoData.virality_score}
                  <span className="text-xs font-normal text-txt-tertiary"> / 100</span>
                </span>
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-txt-secondary">Optimized Title</label>
              <p className="text-sm text-txt-primary mt-1 bg-bg-elevated p-2 rounded">{seoData.title}</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-txt-secondary">Hook Line</label>
              <p className="text-sm text-accent mt-1 italic bg-bg-elevated p-2 rounded">&quot;{seoData.hook}&quot;</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-txt-secondary">Description</label>
              <p className="text-xs text-txt-secondary mt-1 bg-bg-elevated p-2 rounded whitespace-pre-wrap">{seoData.description}</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-txt-secondary">Hashtags</label>
              <div className="flex flex-wrap gap-1 mt-1">
                {(seoData.hashtags || []).map((h, i) => (
                  <Badge key={i} variant="neutral" className="text-xs">{h}</Badge>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-txt-secondary">Tags</label>
              <div className="flex flex-wrap gap-1 mt-1">
                {(seoData.tags || []).map((t, i) => (
                  <span key={i} className="text-xs text-txt-tertiary bg-bg-hover px-2 py-0.5 rounded">{t}</span>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setSeoOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

export default EpisodeDetail;
