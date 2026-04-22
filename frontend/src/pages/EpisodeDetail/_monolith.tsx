import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useUnsavedWarning } from '@/hooks/useUnsavedWarning';
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
  Save,
  Copy,
  Trash2,
  Mic,
  ImageOff,
  Clock,
  Loader2,
  Square,
  Film,
  Archive,
  Upload,
  ChevronDown,
  Music,
  CheckCircle2,
  CalendarDays,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { SEOScorePanel } from '@/components/episode/SEOScorePanel';
import { Spinner } from '@/components/ui/Spinner';
import { VideoPlayer } from '@/components/video/VideoPlayer';
import VideoEditor from '@/components/video/VideoEditor';
import { JobProgressBar } from '@/components/jobs/JobProgressBar';
import * as Popover from '@radix-ui/react-popover';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { Tooltip } from '@/components/ui/Tooltip';
import { episodes as episodesApi, youtube as youtubeApi, voiceProfiles as voiceProfilesApi, schedule as scheduleApi } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { useEpisodeProgress } from '@/lib/websocket';
import type { Episode, MediaAsset, PipelineStep, YouTubeUploadRequest, VoiceProfile } from '@/types';

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
// Episode Detail Page
// ---------------------------------------------------------------------------

function EpisodeDetail() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();

  const [episode, setEpisode] = useState<Episode | null>(null);
  const [loading, setLoading] = useState(true);
  const prevEpisodeStatusRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('script');
  const [generating, setGenerating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [reassembling, setReassembling] = useState(false);
  const [revoicing, setRevoicing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Voice profiles and per-episode overrides
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [epVoiceId, setEpVoiceId] = useState<string>('');
  const [epCaptionStyle, setEpCaptionStyle] = useState<string>('');

  // YouTube upload state
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [ytTitle, setYtTitle] = useState('');
  const [ytDescription, setYtDescription] = useState('');
  const [ytTags, setYtTags] = useState('');
  const [ytPrivacy, setYtPrivacy] = useState('public');

  // Schedule dialog state
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [schedPlatform, setSchedPlatform] = useState('youtube');
  const [schedDatetime, setSchedDatetime] = useState('');
  const [schedTitle, setSchedTitle] = useState('');
  const [schedPrivacy, setSchedPrivacy] = useState('public');

  // SEO dialog state
  const [seoOpen, setSeoOpen] = useState(false);
  const [seoLoading, setSeoLoading] = useState(false);
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
        episodesApi.generateSeo(episodeId).then((seoData) => {
          return episodesApi.update(episodeId, {
            metadata_: {
              ...(ep.metadata_ as Record<string, unknown> ?? {}),
              seo: seoData,
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
    setGenerating(true);
    try {
      await episodesApi.generate(episodeId, steps ? { steps } : undefined);
      toast.success('Episode generation started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to start generation', { description: String(err) });
    } finally {
      setGenerating(false);
    }
  };

  const handleRetry = async () => {
    if (!episodeId) return;
    setRetrying(true);
    try {
      await episodesApi.retry(episodeId);
      toast.success('Episode generation started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to retry generation', { description: String(err) });
    } finally {
      setRetrying(false);
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
    setReassembling(true);
    try {
      await episodesApi.reassemble(episodeId);
      toast.success('Reassembly started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to reassemble episode', { description: String(err) });
    } finally {
      setReassembling(false);
    }
  };

  const handleRegenerateVoice = async () => {
    if (!episodeId) return;
    setRevoicing(true);
    try {
      await episodesApi.regenerateVoice(episodeId, epVoiceId || undefined);
      toast.success('Voice regeneration started');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to regenerate voice', { description: String(err) });
    } finally {
      setRevoicing(false);
    }
  };

  const handleDuplicate = async () => {
    if (!episodeId) return;
    setDuplicating(true);
    try {
      const dup = await episodesApi.duplicate(episodeId);
      navigate(`/episodes/${dup.id}`);
    } catch (err) {
      toast.error('Failed to duplicate episode', { description: String(err) });
    } finally {
      setDuplicating(false);
    }
  };

  const handleReset = async () => {
    if (!episodeId) return;
    setResetting(true);
    try {
      await episodesApi.resetToDraft(episodeId);
      toast.success('Episode reset to draft');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to reset episode', { description: String(err) });
    } finally {
      setResetting(false);
    }
  };

  const handleCancel = async () => {
    if (!episodeId) return;
    setCancelling(true);
    try {
      await episodesApi.cancel(episodeId);
      setCancelDialogOpen(false);
      toast.success('Generation cancelled');
      void fetchEpisode();
    } catch (err) {
      toast.error('Failed to cancel generation', { description: String(err) });
    } finally {
      setCancelling(false);
    }
  };

  const handleDelete = async () => {
    if (!episodeId) return;
    setDeleting(true);
    try {
      await episodesApi.delete(episodeId);
      navigate('/episodes');
    } catch (err) {
      toast.error('Failed to delete episode', { description: String(err) });
      setDeleting(false);
    }
  };

  const handleYouTubeUpload = async () => {
    if (!episodeId) return;
    setUploading(true);
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
      setUploading(false);
    }
  };

  const handleSeo = async () => {
    if (!episodeId) return;
    setSeoLoading(true);
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
      setSeoLoading(false);
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
  const scenes: SceneDataExtended[] = [];
  if (episode?.script) {
    const scriptData = episode.script as Record<string, unknown>;
    const segments = (scriptData['scenes'] ?? scriptData['segments']) as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(segments)) {
      segments.forEach((seg, idx) => {
        const sceneNum = idx + 1;
        const sceneAsset = episode.media_assets.find(
          (a: MediaAsset) =>
            a.asset_type === 'scene' && a.scene_number === sceneNum,
        );
        scenes.push({
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
        });
      });
    }
  }

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
            loading={generating}
            onClick={() => void handleGenerate()}
          >
            <Play size={14} />
            Generate All
          </Button>
        )}

        {episode.status === 'review' && (
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={reassembling}
              onClick={() => void handleReassemble()}
            >
              <RefreshCw size={14} />
              Reassemble
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={revoicing}
              onClick={() => void handleRegenerateVoice()}
            >
              <Mic size={14} />
              Re-voice
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={seoLoading}
              onClick={() => void handleSeo()}
              aria-label="Generate SEO optimization for this episode"
            >
              <Search size={14} />
              SEO
            </Button>
            <Button
              variant="secondary"
              size="sm"
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
            >
              <CalendarDays size={14} />
              Schedule
            </Button>
          </>
        )}

        {episode.status === 'generating' && (
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-300"
            loading={cancelling}
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
            loading={retrying}
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
            loading={duplicating}
            onClick={() => void handleDuplicate()}
          >
            <Copy size={14} />
            Duplicate
          </Button>

          {episode.status !== 'draft' && (
            <Button
              variant="ghost"
              size="sm"
              loading={resetting}
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
                        className="flex items-center gap-2 w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-bg-hover border-t border-border rounded-b-lg"
                      >
                        <Upload size={14} /> Upload to YouTube
                      </button>
                    </Popover.Close>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-300"
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
          {/* Video Editor */}
          {videoAsset && (
            <div className="mt-4">
              <VideoEditor
                episodeId={episodeId!}
                videoDuration={videoAsset.duration_seconds ?? 60}
                onEditApplied={() => void fetchEpisode()}
              />
            </div>
          )}
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
            {activeTab === 'script' && (
              <ScriptTab
                episode={episode}
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
            loading={cancelling}
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
            loading={deleting}
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
            loading={scheduling}
            onClick={async () => {
              if (!episodeId) return;
              setScheduling(true);
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
                setScheduling(false);
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
            loading={uploading}
            onClick={() => void handleYouTubeUpload()}
          >
            <Upload size={14} /> Upload
          </Button>
        </DialogFooter>
      </Dialog>

      {/* SEO Optimization Dialog */}
      <Dialog
        open={seoOpen}
        onClose={() => setSeoOpen(false)}
        title="SEO Optimization"
      >
        {seoLoading ? (
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

// ---------------------------------------------------------------------------
// Extended scene data
// ---------------------------------------------------------------------------

interface SceneDataExtended {
  sceneNumber: number;
  imageUrl: string | null;
  prompt: string;
  durationSeconds: number;
  narration: string;
  visualPrompt: string;
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Script Tab — Inline Scene Editor
// ---------------------------------------------------------------------------

interface EditedScene {
  narration?: string;
  visual_prompt?: string;
  duration_seconds?: number;
  keywords?: string[];
}

function ScriptTab({
  episode,
  onRefresh,
  episodeId,
  voiceProfiles,
  epVoiceId,
  setEpVoiceId,
}: {
  episode: Episode;
  onRefresh: () => void;
  episodeId: string;
  voiceProfiles: VoiceProfile[];
  epVoiceId: string;
  setEpVoiceId: (v: string) => void;
}) {
  const { toast } = useToast();
  const [revoicingInline, setRevoicingInline] = useState(false);
  const [editedScenes, setEditedScenes] = useState<Record<number, EditedScene>>({});
  const [savingScene, setSavingScene] = useState<number | null>(null);
  const [deletingScene, setDeletingScene] = useState<number | null>(null);
  const [regeneratingScene, setRegeneratingScene] = useState<number | null>(null);
  const [deleteConfirmScene, setDeleteConfirmScene] = useState<number | null>(null);
  const [showRawEditor, setShowRawEditor] = useState(false);
  const [rawText, setRawText] = useState('');
  const [savingRaw, setSavingRaw] = useState(false);

  // Warn about unsaved script edits
  const hasUnsavedScriptEdits = useMemo(
    () => Object.keys(editedScenes).length > 0 || showRawEditor,
    [editedScenes, showRawEditor],
  );
  useUnsavedWarning(hasUnsavedScriptEdits);

  if (!episode.script) {
    return (
      <div className="empty-state py-12">
        <FileText size={32} />
        <p className="text-sm">No script generated yet</p>
        <p className="text-xs">Generate the episode to create a script</p>
      </div>
    );
  }

  const scriptData = episode.script as Record<string, unknown>;
  const segments = (scriptData['scenes'] ?? scriptData['segments']) as
    | Array<Record<string, unknown>>
    | undefined;

  if (!Array.isArray(segments) || segments.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => {
            setRawText(JSON.stringify(episode.script, null, 2));
            setShowRawEditor(true);
          }}>
            Edit Raw JSON
          </Button>
        </div>
        <div className="empty-state py-12">
          <FileText size={32} />
          <p className="text-sm">Script has no scenes</p>
          <p className="text-xs">Edit the raw JSON to add scene data</p>
        </div>
        {showRawEditor && (
          <RawJsonEditor
            text={rawText}
            onChangeText={setRawText}
            saving={savingRaw}
            onSave={async () => {
              setSavingRaw(true);
              try {
                const parsed = JSON.parse(rawText);
                await episodesApi.updateScript(episode.id, { script: parsed });
                setShowRawEditor(false);
                toast.success('Script saved');
                onRefresh();
              } catch (err) {
                toast.error('Failed to save script', { description: String(err) });
              } finally {
                setSavingRaw(false);
              }
            }}
            onCancel={() => setShowRawEditor(false)}
          />
        )}
      </div>
    );
  }

  const updateEditedScene = (idx: number, field: string, value: unknown) => {
    setEditedScenes((prev) => ({
      ...prev,
      [idx]: {
        ...prev[idx],
        [field]: value,
      },
    }));
  };

  const isSceneModified = (idx: number) => {
    return editedScenes[idx] !== undefined && Object.keys(editedScenes[idx]).length > 0;
  };

  const saveScene = async (sceneNumber: number, idx: number) => {
    const edits = editedScenes[idx];
    if (!edits) return;
    setSavingScene(sceneNumber);
    try {
      await episodesApi.updateScene(episode.id, sceneNumber, edits);
      setEditedScenes((prev) => {
        const next = { ...prev };
        delete next[idx];
        return next;
      });
      toast.success('Script saved');
      onRefresh();
    } catch (err) {
      toast.error('Failed to save scene', { description: String(err) });
    } finally {
      setSavingScene(null);
    }
  };

  const handleDeleteScene = async (sceneNumber: number) => {
    setDeletingScene(sceneNumber);
    try {
      await episodesApi.deleteScene(episode.id, sceneNumber);
      setDeleteConfirmScene(null);
      toast.success('Scene deleted');
      onRefresh();
    } catch (err) {
      toast.error('Failed to delete scene', { description: String(err) });
    } finally {
      setDeletingScene(null);
    }
  };

  const handleRegenerateScene = async (sceneNumber: number) => {
    setRegeneratingScene(sceneNumber);
    try {
      const seg = segments[sceneNumber - 1];
      const prompt = seg ? (seg['visual_prompt'] as string | undefined) : undefined;
      await episodesApi.regenerateScene(episode.id, sceneNumber, prompt ?? undefined);
      toast.success('Scene regeneration started');
      onRefresh();
    } catch (err) {
      toast.error('Failed to regenerate scene', { description: String(err) });
    } finally {
      setRegeneratingScene(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* SEO heuristics — deterministic, no LLM call. Updates when the
          episode.updated_at changes (post-save, post-regeneration, etc.). */}
      <SEOScorePanel episodeId={episodeId} refreshKey={Date.parse(episode.updated_at)} />

      {/* Voice Control Panel */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-txt-secondary flex items-center gap-1.5">
            <Mic size={13} /> Voice Settings
          </h4>
        </div>
        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-txt-tertiary block mb-1">Voice Profile</label>
            <select
              value={epVoiceId}
              onChange={(e) => {
                setEpVoiceId(e.target.value);
                void episodesApi.update(episodeId, {
                  override_voice_profile_id: e.target.value || null,
                } as any);
              }}
              className="w-full bg-bg-elevated border border-border rounded px-2.5 py-1.5 text-sm text-txt-primary focus:outline-none focus:border-accent"
              aria-label="Select voice profile for this episode"
            >
              <option value="">Series default</option>
              {voiceProfiles.map(v => (
                <option key={v.id} value={v.id}>{v.name} ({v.provider})</option>
              ))}
            </select>
          </div>
          {(episode.status === 'review' || episode.status === 'exported') && (
            <Button
              variant="secondary"
              size="sm"
              loading={revoicingInline}
              onClick={async () => {
                setRevoicingInline(true);
                try {
                  await episodesApi.regenerateVoice(episodeId, epVoiceId || undefined);
                  toast.success('Voice regeneration started');
                  onRefresh();
                } catch (err) {
                  toast.error('Failed to regenerate voice', { description: String(err) });
                } finally {
                  setRevoicingInline(false);
                }
              }}
              aria-label="Regenerate voice audio for this episode"
            >
              <Mic size={12} />
              Regenerate Voice
            </Button>
          )}
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => {
          setRawText(JSON.stringify(episode.script, null, 2));
          setShowRawEditor(true);
        }}>
          Edit Raw JSON
        </Button>
      </div>

      {showRawEditor && (
        <RawJsonEditor
          text={rawText}
          onChangeText={setRawText}
          saving={savingRaw}
          onSave={async () => {
            setSavingRaw(true);
            try {
              const parsed = JSON.parse(rawText);
              await episodesApi.updateScript(episode.id, { script: parsed });
              setShowRawEditor(false);
              toast.success('Script saved');
              onRefresh();
            } catch (err) {
              toast.error('Failed to save script', { description: String(err) });
            } finally {
              setSavingRaw(false);
            }
          }}
          onCancel={() => setShowRawEditor(false)}
        />
      )}

      {segments.map((seg, idx) => {
        const sceneNumber = idx + 1;
        const narration = (seg['narration'] as string) ?? (seg['text'] as string) ?? '';
        const visualPrompt = (seg['visual_prompt'] as string) ?? '';
        const durationSeconds = (seg['duration_seconds'] as number) ?? 3;
        const keywords = (seg['keywords'] as string[]) ?? [];

        return (
          <Card key={sceneNumber} padding="md" className="relative group">
            {/* Scene header */}
            <div className="flex items-center justify-between mb-3">
              <Badge variant="script">Scene {sceneNumber}</Badge>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={regeneratingScene === sceneNumber}
                  onClick={() => void handleRegenerateScene(sceneNumber)}
                >
                  <RefreshCw size={12} />
                  Regenerate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300"
                  onClick={() => setDeleteConfirmScene(sceneNumber)}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>

            {/* Narration (editable) */}
            <div className="mb-3">
              <label className="text-xs text-txt-tertiary">Narration</label>
              <Textarea
                value={editedScenes[idx]?.narration ?? narration}
                onChange={(e) => updateEditedScene(idx, 'narration', e.target.value)}
                className="mt-1 text-sm min-h-[60px]"
                rows={2}
              />
            </div>

            {/* Visual Prompt (editable) */}
            <div className="mb-3">
              <label className="text-xs text-txt-tertiary">Visual Prompt</label>
              <Textarea
                value={editedScenes[idx]?.visual_prompt ?? visualPrompt}
                onChange={(e) => updateEditedScene(idx, 'visual_prompt', e.target.value)}
                className="mt-1 text-xs font-mono min-h-[60px]"
                rows={2}
              />
            </div>

            {/* Duration + Keywords */}
            <div className="flex gap-4">
              <div>
                <label className="text-xs text-txt-tertiary">Duration</label>
                <Input
                  type="number"
                  value={editedScenes[idx]?.duration_seconds ?? durationSeconds}
                  onChange={(e) =>
                    updateEditedScene(idx, 'duration_seconds', parseFloat(e.target.value) || 0)
                  }
                  className="w-20 text-sm"
                  step={0.5}
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-tertiary">Keywords</label>
                <Input
                  value={
                    editedScenes[idx]?.keywords !== undefined
                      ? editedScenes[idx].keywords!.join(', ')
                      : keywords.join(', ')
                  }
                  onChange={(e) =>
                    updateEditedScene(
                      idx,
                      'keywords',
                      e.target.value.split(',').map((k) => k.trim()).filter(Boolean),
                    )
                  }
                  className="text-sm"
                  placeholder="word1, word2, word3"
                />
              </div>
            </div>

            {/* Save button (shows when modified) */}
            {isSceneModified(idx) && (
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                loading={savingScene === sceneNumber}
                onClick={() => void saveScene(sceneNumber, idx)}
              >
                <Save size={12} />
                Save Changes
              </Button>
            )}
          </Card>
        );
      })}

      {/* Delete scene confirmation dialog */}
      <Dialog
        open={deleteConfirmScene !== null}
        onClose={() => setDeleteConfirmScene(null)}
        title={`Delete Scene ${deleteConfirmScene}?`}
      >
        <p className="text-sm text-txt-secondary">
          This will remove the scene from the script. This action cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteConfirmScene(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deletingScene === deleteConfirmScene}
            onClick={() => {
              if (deleteConfirmScene !== null) {
                void handleDeleteScene(deleteConfirmScene);
              }
            }}
          >
            <Trash2 size={14} />
            Delete Scene
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw JSON Editor (sub-component)
// ---------------------------------------------------------------------------

function RawJsonEditor({
  text,
  onChangeText,
  saving,
  onSave,
  onCancel,
}: {
  text: string;
  onChangeText: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <Card padding="md" className="border-accent/30">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-txt-secondary">Raw JSON Editor</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={onSave}
          >
            <Save size={12} />
            Save
          </Button>
        </div>
      </div>
      <Textarea
        value={text}
        onChange={(e) => onChangeText(e.target.value)}
        className="font-mono text-xs min-h-[300px]"
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Scenes Tab — Enhanced Grid
// ---------------------------------------------------------------------------

function ScenesTab({
  episode,
  scenes,
  onRefresh,
}: {
  episode: Episode;
  scenes: SceneDataExtended[];
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [regeneratingScene, setRegeneratingScene] = useState<number | null>(null);
  const [editPromptScene, setEditPromptScene] = useState<number | null>(null);
  const [editPromptText, setEditPromptText] = useState('');

  if (scenes.length === 0) {
    return (
      <div className="empty-state py-12">
        <ImageOff size={32} className="text-txt-tertiary" />
        <p className="text-sm text-txt-tertiary">No scenes generated yet</p>
        <p className="text-xs text-txt-tertiary">
          Generate the script and scenes to see thumbnails here
        </p>
      </div>
    );
  }

  const handleRegenerateScene = async (sceneNumber: number, prompt?: string) => {
    setRegeneratingScene(sceneNumber);
    try {
      await episodesApi.regenerateScene(episode.id, sceneNumber, prompt);
      toast.success('Scene regeneration started');
      onRefresh();
    } catch (err) {
      toast.error('Failed to regenerate scene', { description: String(err) });
    } finally {
      setRegeneratingScene(null);
    }
  };

  const handleEditPromptSubmit = async () => {
    if (editPromptScene === null) return;
    await handleRegenerateScene(editPromptScene, editPromptText || undefined);
    setEditPromptScene(null);
    setEditPromptText('');
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {scenes.map((scene) => {
          const isRegenerating = regeneratingScene === scene.sceneNumber;

          return (
            <div
              key={scene.sceneNumber}
              className="surface-interactive relative overflow-hidden group"
            >
              {/* Thumbnail */}
              <div className="aspect-video bg-bg-base relative overflow-hidden">
                {scene.imageUrl ? (
                  <img
                    src={scene.imageUrl}
                    alt={`Scene ${scene.sceneNumber}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageOff size={24} className="text-txt-tertiary" />
                  </div>
                )}

                {/* Scene number badge */}
                <div className="absolute top-2 left-2">
                  <span className="badge bg-black/60 text-white backdrop-blur-sm">
                    #{scene.sceneNumber}
                  </span>
                </div>

                {/* Duration badge */}
                <div className="absolute top-2 right-2">
                  <span className="badge bg-black/60 text-white backdrop-blur-sm">
                    <Clock size={10} />
                    {scene.durationSeconds.toFixed(1)}s
                  </span>
                </div>

                {/* Generating spinner overlay */}
                {isRegenerating && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 size={24} className="text-white animate-spin" />
                  </div>
                )}

                {/* Hover overlay */}
                {!isRegenerating && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRegenerateScene(scene.sceneNumber, scene.visualPrompt || undefined);
                      }}
                    >
                      <RefreshCw size={12} />
                      Regenerate
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditPromptScene(scene.sceneNumber);
                        setEditPromptText(scene.visualPrompt);
                      }}
                    >
                      <FileText size={12} />
                      Edit Prompt
                    </Button>
                  </div>
                )}
              </div>

              {/* Prompt text */}
              <div className="p-2">
                <p className="text-xs text-txt-secondary text-clamp-2 leading-relaxed">
                  {scene.prompt}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Edit Prompt Dialog */}
      <Dialog
        open={editPromptScene !== null}
        onClose={() => {
          setEditPromptScene(null);
          setEditPromptText('');
        }}
        title={`Edit Prompt - Scene ${editPromptScene}`}
      >
        <Textarea
          label="Visual Prompt"
          value={editPromptText}
          onChange={(e) => setEditPromptText(e.target.value)}
          className="font-mono text-xs min-h-[120px]"
          placeholder="Describe the visual for this scene..."
        />
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setEditPromptScene(null);
              setEditPromptText('');
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={regeneratingScene === editPromptScene}
            onClick={() => void handleEditPromptSubmit()}
          >
            <RefreshCw size={14} />
            Regenerate with Prompt
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Captions Tab — Editable
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared constants — declared here so CaptionsTab and MusicTab can both use them
// ---------------------------------------------------------------------------

const MUSIC_MOODS = [
  { value: 'epic', label: 'Epic', desc: 'Cinematic orchestral' },
  { value: 'calm', label: 'Calm', desc: 'Soft ambient piano' },
  { value: 'dark', label: 'Dark', desc: 'Suspenseful atmosphere' },
  { value: 'happy', label: 'Happy', desc: 'Bright cheerful' },
  { value: 'sad', label: 'Sad', desc: 'Melancholic emotional' },
  { value: 'mysterious', label: 'Mysterious', desc: 'Ethereal suspense' },
  { value: 'action', label: 'Action', desc: 'High-energy driving' },
  { value: 'romantic', label: 'Romantic', desc: 'Warm intimate' },
  { value: 'horror', label: 'Horror', desc: 'Dark creepy' },
  { value: 'comedy', label: 'Comedy', desc: 'Playful bouncy' },
  { value: 'inspiring', label: 'Inspiring', desc: 'Uplifting triumphant' },
  { value: 'chill', label: 'Chill', desc: 'Lo-fi relaxed' },
] as const;

interface MusicTrack {
  filename: string;
  path: string;
  mood: string;
  duration: number;
}

// Caption preset definitions — used both for display and for the override API call.
const CAPTION_PRESETS: Array<{ value: string | null; label: string; desc: string }> = [
  { value: '', label: 'Series Default', desc: 'Use the series setting' },
  { value: 'youtube_highlight', label: 'Highlight', desc: 'Words light up as spoken' },
  { value: 'karaoke', label: 'Karaoke', desc: 'One word at a time' },
  { value: 'tiktok_pop', label: 'TikTok Pop', desc: 'Words pop in with scale' },
  { value: 'buzzword', label: 'Buzzword', desc: 'Keywords pop up center' },
  { value: 'minimal', label: 'Minimal', desc: 'Small subtle text' },
  { value: 'classic', label: 'Classic', desc: 'White on black outline' },
  { value: null, label: 'No Captions', desc: 'Remove all captions' },
];

function CaptionsTab({
  episode,
  captionsAsset,
  onRefresh,
  episodeId,
  epCaptionStyle,
  setEpCaptionStyle,
}: {
  episode: Episode;
  captionsAsset: MediaAsset | undefined;
  onRefresh: () => void;
  episodeId: string;
  epCaptionStyle: string;
  setEpCaptionStyle: (v: string) => void;
}) {
  const { toast } = useToast();
  const [regeneratingCaptions, setRegeneratingCaptions] = useState(false);
  const [reassembling, setReassembling] = useState(false);

  // Inline music panel state (per-episode overrides only; full library is in Music tab)
  const meta = episode.metadata_ as Record<string, unknown> | null;
  const [musicEnabled, setMusicEnabled] = useState<boolean>(
    meta?.['music_enabled'] !== false,
  );
  const [musicMood, setMusicMood] = useState<string>(
    (meta?.['music_mood'] as string) || 'epic',
  );
  const [musicVolume, setMusicVolume] = useState<number>(
    typeof meta?.['music_volume_db'] === 'number' ? (meta['music_volume_db'] as number) : -14,
  );
  const [applyingMusic, setApplyingMusic] = useState(false);

  // Find ASS caption asset
  const assAsset = episode.media_assets.find(
    (a: MediaAsset) => a.asset_type === 'caption' && a.file_path.endsWith('.ass'),
  );

  // Extract caption entries from script for display
  const captionEntries: Array<{ index: number; start: string; end: string; text: string }> = [];
  if (episode.script) {
    const scriptData = episode.script as Record<string, unknown>;
    const segments = (scriptData['segments'] ?? scriptData['scenes']) as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(segments)) {
      let timeOffset = 0;
      segments.forEach((seg, idx) => {
        const duration = (seg['duration_seconds'] as number) ?? 3;
        const text = (seg['text'] as string) ?? (seg['narration'] as string) ?? '';
        if (text) {
          captionEntries.push({
            index: idx + 1,
            start: formatTimestamp(timeOffset),
            end: formatTimestamp(timeOffset + duration),
            text,
          });
        }
        timeOffset += duration;
      });
    }
  }

  const handleRegenerateCaptions = async () => {
    setRegeneratingCaptions(true);
    try {
      await episodesApi.retryStep(episode.id, 'captions');
      toast.success('Caption regeneration started');
      onRefresh();
    } catch (err) {
      toast.error('Failed to regenerate captions', { description: String(err) });
    } finally {
      setRegeneratingCaptions(false);
    }
  };

  const handleReassemble = async () => {
    setReassembling(true);
    try {
      await episodesApi.reassemble(episode.id);
      toast.success('Reassembly started');
      onRefresh();
    } catch (err) {
      toast.error('Failed to reassemble episode', { description: String(err) });
    } finally {
      setReassembling(false);
    }
  };

  if (!captionsAsset) {
    return (
      <div className="empty-state py-12">
        <Subtitles size={32} />
        <p className="text-sm">No captions generated yet</p>
        <p className="text-xs">Captions will appear after the captions step completes</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={regeneratingCaptions}
          onClick={() => void handleRegenerateCaptions()}
        >
          <RefreshCw size={14} />
          Regenerate Captions
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={reassembling}
          onClick={() => void handleReassemble()}
        >
          <RefreshCw size={14} />
          Reassemble Video
        </Button>
      </div>

      {/* Caption Style Panel */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-txt-secondary flex items-center gap-1.5">
            <Subtitles size={13} /> Caption Style
          </h4>
        </div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Caption style">
          {CAPTION_PRESETS.map((opt) => {
            // Normalise: null => sentinel '__none__', '' => '', string => string
            const optKey = opt.value === null ? '__none__' : opt.value;
            const isActive =
              opt.value === null
                ? epCaptionStyle === '__none__'
                : epCaptionStyle === opt.value;
            return (
              <button
                key={optKey}
                role="radio"
                aria-checked={isActive}
                onClick={() => {
                  const nextVal = opt.value === null ? '__none__' : opt.value;
                  setEpCaptionStyle(nextVal);
                  void episodesApi.update(episodeId, {
                    override_caption_style: opt.value === null ? '__none__' : opt.value || null,
                  } as any);
                }}
                className={[
                  'flex flex-col items-start px-2.5 py-2 rounded-lg border text-left transition-colors',
                  isActive
                    ? 'bg-accent/10 border-accent text-accent'
                    : 'bg-bg-elevated border-border text-txt-secondary hover:text-txt-primary hover:border-border-hover',
                ].join(' ')}
              >
                <span className="text-xs font-semibold leading-tight">{opt.label}</span>
                <span
                  className={`text-[10px] mt-0.5 leading-tight ${
                    isActive ? 'text-accent/70' : 'text-txt-tertiary'
                  }`}
                >
                  {opt.desc}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-txt-tertiary mt-2">
          Select a style, then click "Reassemble Video" to burn it into the video.
        </p>
      </Card>

      {/* Background Music Panel */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-semibold text-txt-secondary flex items-center gap-1.5">
            <Music size={13} /> Background Music
          </h4>
          <label
            className="flex items-center gap-1.5 cursor-pointer select-none"
            htmlFor="music-enabled-toggle"
          >
            <span className="text-xs text-txt-secondary">Enabled</span>
            <input
              id="music-enabled-toggle"
              type="checkbox"
              checked={musicEnabled}
              onChange={(e) => setMusicEnabled(e.target.checked)}
              className="accent-accent w-3.5 h-3.5"
              aria-label="Enable background music"
            />
          </label>
        </div>

        {musicEnabled && (
          <div className="space-y-3">
            {/* Mood selector */}
            <div>
              <label
                htmlFor="music-mood-select"
                className="text-[10px] text-txt-tertiary block mb-1"
              >
                Mood
              </label>
              <select
                id="music-mood-select"
                value={musicMood}
                onChange={(e) => setMusicMood(e.target.value)}
                className="w-full bg-bg-elevated border border-border rounded px-2.5 py-1.5 text-sm text-txt-primary focus:outline-none focus:border-accent"
                aria-label="Select background music mood"
              >
                {MUSIC_MOODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label} — {m.desc}
                  </option>
                ))}
              </select>
            </div>

            {/* Volume slider */}
            <div>
              <label
                htmlFor="music-volume-slider"
                className="text-[10px] text-txt-tertiary block mb-1"
              >
                Volume: {musicVolume} dB
              </label>
              <input
                id="music-volume-slider"
                type="range"
                min={-30}
                max={-3}
                step={1}
                value={musicVolume}
                onChange={(e) => setMusicVolume(parseInt(e.target.value))}
                className="w-full accent-accent h-1.5 rounded-lg cursor-pointer"
                aria-label={`Music volume: ${musicVolume} dB`}
                aria-valuemin={-30}
                aria-valuemax={-3}
                aria-valuenow={musicVolume}
              />
              <div className="flex justify-between text-[10px] text-txt-tertiary mt-0.5">
                <span>Quiet</span>
                <span>Loud</span>
              </div>
            </div>
          </div>
        )}

        <Button
          variant="primary"
          size="sm"
          className="mt-3 w-full"
          loading={applyingMusic}
          onClick={async () => {
            setApplyingMusic(true);
            try {
              // Persist overrides to episode metadata, then reassemble
              const currentMeta = (episode.metadata_ as Record<string, unknown>) || {};
              await episodesApi.update(episodeId, {
                metadata_: {
                  ...currentMeta,
                  music_enabled: musicEnabled,
                  music_mood: musicMood,
                  music_volume_db: musicVolume,
                },
              } as any);
              await episodesApi.reassemble(episodeId);
              toast.success('Reassembly started');
              onRefresh();
            } catch (err) {
              toast.error('Failed to apply music settings', { description: String(err) });
            } finally {
              setApplyingMusic(false);
            }
          }}
          aria-busy={applyingMusic}
        >
          <RefreshCw size={12} />
          Apply & Reassemble
        </Button>

        <p className="text-[10px] text-txt-tertiary mt-1.5">
          For full track selection and audio mix controls, use the Music tab.
        </p>
      </Card>

      {/* Caption entries list */}
      {captionEntries.length > 0 && (
        <Card padding="md">
          <h4 className="text-sm font-semibold text-txt-primary mb-3">
            Caption Entries ({captionEntries.length})
          </h4>
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
            {captionEntries.map((entry) => (
              <div
                key={entry.index}
                className="flex items-start gap-3 p-2 rounded bg-bg-hover text-xs"
              >
                <span className="text-txt-tertiary font-mono shrink-0 w-6 text-right">
                  {entry.index}
                </span>
                <span className="text-accent font-mono shrink-0 w-24">
                  {entry.start}
                </span>
                <span className="text-txt-tertiary font-mono shrink-0 w-2">
                  -
                </span>
                <span className="text-accent font-mono shrink-0 w-24">
                  {entry.end}
                </span>
                <span className="text-txt-primary flex-1">{entry.text}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Download buttons */}
      <Card padding="md">
        <h4 className="text-sm font-semibold text-txt-primary mb-3">
          Download Captions
        </h4>
        <p className="text-xs text-txt-tertiary mb-3">
          Captions file: <code className="text-accent">{captionsAsset.file_path}</code>
        </p>
        <div className="flex items-center gap-2">
          <a
            href={`/storage/${captionsAsset.file_path}`}
            download
            className="inline-flex items-center justify-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-sm bg-bg-elevated text-txt-primary border border-border hover:bg-bg-hover hover:border-border-hover transition-all duration-fast"
          >
            <Download size={14} />
            Download SRT
          </a>
          {assAsset && (
            <a
              href={`/storage/${assAsset.file_path}`}
              download
              className="inline-flex items-center justify-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-sm bg-bg-elevated text-txt-primary border border-border hover:bg-bg-hover hover:border-border-hover transition-all duration-fast"
            >
              <Download size={14} />
              Download ASS
            </a>
          )}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Music Tab
// ---------------------------------------------------------------------------

function MusicTab({
  episodeId,
  episode,
  onChanged,
}: {
  episodeId: string;
  episode: Episode;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [selectedMood, setSelectedMood] = useState<string>('epic');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [loadingTracks, setLoadingTracks] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const [musicVolume, setMusicVolume] = useState(-14);
  const [musicReverb, setMusicReverb] = useState(false);
  const [musicReverbDecay, setMusicReverbDecay] = useState(0.3);
  const [musicLowPass, setMusicLowPass] = useState(0);
  const [voiceEq, setVoiceEq] = useState(true);
  const [voiceCompressor, setVoiceCompressor] = useState(true);
  const [duckRatio, setDuckRatio] = useState(6);
  const [duckRelease, setDuckRelease] = useState(1000);
  const [reassembling, setReassembling] = useState(false);

  const meta = episode.metadata_ as Record<string, unknown> | null;
  const selectedMusicPath = meta?.['selected_music_path'] as string | undefined;

  // Init audio settings from episode metadata
  useEffect(() => {
    const vol = meta?.['music_volume_db'];
    if (typeof vol === 'number') setMusicVolume(vol);
    const audio = (meta?.['audio_settings'] || {}) as Record<string, unknown>;
    if (audio.music_reverb !== undefined) setMusicReverb(!!audio.music_reverb);
    if (typeof audio.music_reverb_decay === 'number') setMusicReverbDecay(audio.music_reverb_decay);
    if (typeof audio.music_low_pass === 'number') setMusicLowPass(audio.music_low_pass);
    if (audio.voice_eq !== undefined) setVoiceEq(!!audio.voice_eq);
    if (audio.voice_compressor !== undefined) setVoiceCompressor(!!audio.voice_compressor);
    if (typeof audio.duck_ratio === 'number') setDuckRatio(audio.duck_ratio);
    if (typeof audio.duck_release === 'number') setDuckRelease(audio.duck_release);
  }, [episode]);

  const fetchTracks = useCallback(async () => {
    setLoadingTracks(true);
    try {
      const res = await episodesApi.musicList(episodeId);
      setTracks(Array.isArray(res) ? res : (res as any).tracks ?? []);
    } catch {
      // non-fatal: endpoint may not exist yet
      setTracks([]);
    } finally {
      setLoadingTracks(false);
    }
  }, [episodeId]);

  useEffect(() => {
    void fetchTracks();
  }, [fetchTracks]);

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      await episodesApi.musicGenerate(episodeId, selectedMood, 30);
      await fetchTracks();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to generate music';
      setGenerateError(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleSelect = async (path: string) => {
    setSelecting(path);
    try {
      await episodesApi.musicSelect(episodeId, path);
      toast.success('Music track selected');
    } catch (err) {
      toast.error('Failed to select music track', { description: String(err) });
    } finally {
      setSelecting(null);
    }
  };

  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-4">
      {/* Mood selector */}
      <Card className="p-4">
        <h4 className="text-xs font-semibold text-txt-secondary flex items-center gap-1.5 mb-3">
          <Music size={13} />
          Select Mood
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {MUSIC_MOODS.map((mood) => (
            <button
              key={mood.value}
              onClick={() => setSelectedMood(mood.value)}
              className={[
                'flex flex-col items-start px-3 py-2 rounded-lg text-left transition-colors border',
                selectedMood === mood.value
                  ? 'bg-accent/10 border-accent text-accent'
                  : 'bg-bg-elevated border-border text-txt-secondary hover:text-txt-primary hover:border-border-hover',
              ].join(' ')}
              aria-pressed={selectedMood === mood.value}
            >
              <span className="text-xs font-semibold leading-tight">
                {mood.label}
              </span>
              <span
                className={`text-[10px] mt-0.5 leading-tight ${
                  selectedMood === mood.value
                    ? 'text-accent/70'
                    : 'text-txt-tertiary'
                }`}
              >
                {mood.desc}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {/* Generate button */}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="md"
          loading={generating}
          onClick={() => void handleGenerate()}
          aria-busy={generating}
        >
          <Music size={14} />
          {generating ? 'Generating via AceStep...' : 'Generate Music'}
        </Button>
        {generateError && (
          <p className="text-xs text-error" role="alert" aria-live="assertive">
            {generateError}
          </p>
        )}
      </div>

      {/* Audio Mix Settings + Reassemble */}
      {selectedMusicPath && (
        <Card className="p-3 border-accent/20 bg-accent/5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-accent shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-accent">Currently selected</p>
              <p className="text-[10px] text-txt-tertiary font-mono truncate mt-0.5">
                {selectedMusicPath.split('/').pop()}
              </p>
            </div>
          </div>

          {/* Music Volume */}
          <div>
            <label className="text-xs text-txt-secondary block mb-1">
              Music Volume: {musicVolume} dB
            </label>
            <input type="range" min={-30} max={-3} step={1} value={musicVolume}
              onChange={(e) => setMusicVolume(parseInt(e.target.value))}
              className="w-full accent-accent h-1.5 rounded-lg cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-txt-tertiary mt-0.5">
              <span>Quiet</span><span>Loud</span>
            </div>
          </div>

          {/* Music Effects */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-txt-secondary uppercase tracking-wider">Music Effects</p>
            <label className="flex items-center gap-2 text-xs text-txt-primary cursor-pointer">
              <input type="checkbox" checked={musicReverb} onChange={(e) => setMusicReverb(e.target.checked)} className="accent-accent" />
              Reverb / Hall
            </label>
            {musicReverb && (
              <div className="pl-5">
                <label className="text-[10px] text-txt-tertiary block mb-0.5">Decay: {(musicReverbDecay * 100).toFixed(0)}%</label>
                <input type="range" min={0.1} max={0.8} step={0.05} value={musicReverbDecay}
                  onChange={(e) => setMusicReverbDecay(parseFloat(e.target.value))}
                  className="w-full accent-accent h-1 rounded-lg cursor-pointer"
                />
              </div>
            )}
            <div>
              <label className="text-[10px] text-txt-tertiary block mb-0.5">
                Low-Pass Filter: {musicLowPass === 0 ? 'Off' : `${musicLowPass} Hz`}
              </label>
              <input type="range" min={0} max={12000} step={500} value={musicLowPass}
                onChange={(e) => setMusicLowPass(parseInt(e.target.value))}
                className="w-full accent-accent h-1 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-txt-tertiary">
                <span>Off</span><span>Muffled</span>
              </div>
            </div>
          </div>

          {/* Voice Processing */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-txt-secondary uppercase tracking-wider">Voice Processing</p>
            <label className="flex items-center gap-2 text-xs text-txt-primary cursor-pointer">
              <input type="checkbox" checked={voiceEq} onChange={(e) => setVoiceEq(e.target.checked)} className="accent-accent" />
              Voice EQ (presence boost + rumble cut)
            </label>
            <label className="flex items-center gap-2 text-xs text-txt-primary cursor-pointer">
              <input type="checkbox" checked={voiceCompressor} onChange={(e) => setVoiceCompressor(e.target.checked)} className="accent-accent" />
              Voice Compressor (even loudness)
            </label>
          </div>

          {/* Sidechain Ducking */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-txt-secondary uppercase tracking-wider">Music Ducking</p>
            <div>
              <label className="text-[10px] text-txt-tertiary block mb-0.5">Duck Strength: {duckRatio}:1</label>
              <input type="range" min={2} max={20} step={1} value={duckRatio}
                onChange={(e) => setDuckRatio(parseInt(e.target.value))}
                className="w-full accent-accent h-1 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-txt-tertiary">
                <span>Gentle</span><span>Aggressive</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-txt-tertiary block mb-0.5">Release: {duckRelease} ms</label>
              <input type="range" min={200} max={3000} step={100} value={duckRelease}
                onChange={(e) => setDuckRelease(parseInt(e.target.value))}
                className="w-full accent-accent h-1 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-txt-tertiary">
                <span>Fast</span><span>Slow</span>
              </div>
            </div>
          </div>

          {/* Reassemble button */}
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            loading={reassembling}
            onClick={async () => {
              setReassembling(true);
              // Save all audio settings to metadata before reassembling
              const currentMeta = (episode.metadata_ as Record<string, unknown>) || {};
              try {
                await episodesApi.update(episodeId, {
                  metadata_: {
                    ...currentMeta,
                    music_volume_db: musicVolume,
                    audio_settings: {
                      music_volume_db: musicVolume,
                      music_reverb: musicReverb,
                      music_reverb_decay: musicReverbDecay,
                      music_low_pass: musicLowPass,
                      voice_eq: voiceEq,
                      voice_compressor: voiceCompressor,
                      duck_ratio: duckRatio,
                      duck_release: duckRelease,
                    },
                  },
                } as any);
                await episodesApi.reassemble(episodeId);
                toast.success('Reassembly started');
                onChanged?.();
              } catch (err) {
                toast.error('Failed to reassemble with audio settings', { description: String(err) });
              } finally {
                setReassembling(false);
              }
            }}
          >
            <RefreshCw size={14} />
            Reassemble with Audio Settings
          </Button>
        </Card>
      )}

      {/* Track list */}
      <Card padding="md">
        <h4 className="text-sm font-semibold text-txt-primary mb-3 flex items-center gap-2">
          <Music size={14} className="text-txt-secondary" />
          Available Tracks
          {loadingTracks && (
            <Loader2 size={12} className="animate-spin text-txt-tertiary" />
          )}
        </h4>

        {!loadingTracks && tracks.length === 0 ? (
          <div className="empty-state py-8">
            <Music size={28} className="text-txt-tertiary" />
            <p className="text-sm text-txt-tertiary">No tracks generated yet</p>
            <p className="text-xs text-txt-tertiary">
              Choose a mood above and click Generate
            </p>
          </div>
        ) : (
          <div className="space-y-2" aria-live="polite">
            {tracks.map((track) => {
              const isSelected = selectedMusicPath === track.path;
              const isPlaying = playingPath === track.path;

              return (
                <div
                  key={track.path}
                  className={[
                    'flex items-center gap-3 p-3 rounded-lg border transition-colors',
                    isSelected
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border bg-bg-elevated hover:border-border-hover',
                  ].join(' ')}
                >
                  {/* Track info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-txt-primary truncate">
                      {track.filename}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="neutral" className="text-[10px]">
                        {track.mood}
                      </Badge>
                      <span className="text-xs text-txt-tertiary flex items-center gap-1">
                        <Clock size={10} />
                        {formatDuration(track.duration)}
                      </span>
                    </div>
                  </div>

                  {/* Audio player */}
                  <audio
                    src={`/storage/${track.path}`}
                    controls
                    onPlay={() => setPlayingPath(track.path)}
                    onPause={() => {
                      if (isPlaying) setPlayingPath(null);
                    }}
                    onEnded={() => setPlayingPath(null)}
                    aria-label={`Play ${track.filename}`}
                    className="h-8 w-36"
                    style={{ colorScheme: 'dark' }}
                  />

                  {/* Use This Track button */}
                  <Button
                    variant={isSelected ? 'primary' : 'secondary'}
                    size="sm"
                    loading={selecting === track.path}
                    onClick={() => void handleSelect(track.path)}
                    aria-pressed={isSelected}
                    aria-label={
                      isSelected
                        ? `${track.filename} is selected`
                        : `Use ${track.filename}`
                    }
                  >
                    {isSelected ? (
                      <>
                        <CheckCircle2 size={12} />
                        Selected
                      </>
                    ) : (
                      'Use This Track'
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format seconds to HH:MM:SS,mmm timestamp. */
function formatTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.round((totalSeconds % 1) * 1000);
  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    ',' +
    String(millis).padStart(3, '0')
  );
}

// ---------------------------------------------------------------------------
// Metadata Tab
// ---------------------------------------------------------------------------

function MetadataTab({ episode }: { episode: Episode }) {
  const seo = episode.metadata_?.seo as {
    virality_score?: number;
    title?: string;
    hook?: string;
    description?: string;
    hashtags?: string[];
    tags?: string[];
  } | undefined;

  return (
    <div className="space-y-4">
      {/* SEO Analysis — shown if SEO data has been generated */}
      {seo && (
        <Card padding="md" className="border-accent/20">
          <h4 className="text-sm font-semibold text-txt-primary mb-3 flex items-center gap-2">
            <Search size={14} className="text-accent" />
            SEO Analysis
          </h4>
          <div className="space-y-3">
            {typeof seo.virality_score === 'number' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-txt-secondary">Virality Score:</span>
                <Badge
                  variant={
                    seo.virality_score >= 7
                      ? 'success'
                      : seo.virality_score >= 5
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {seo.virality_score}/10
                </Badge>
              </div>
            )}
            {seo.title && (
              <div>
                <span className="text-xs text-txt-secondary block mb-0.5">Optimized Title:</span>
                <p className="text-sm text-txt-primary bg-bg-elevated px-2 py-1.5 rounded">
                  {seo.title}
                </p>
              </div>
            )}
            {seo.hook && (
              <div>
                <span className="text-xs text-txt-secondary block mb-0.5">Hook:</span>
                <p className="text-sm text-accent italic bg-bg-elevated px-2 py-1.5 rounded">
                  &quot;{seo.hook}&quot;
                </p>
              </div>
            )}
            {seo.hashtags && seo.hashtags.length > 0 && (
              <div>
                <span className="text-xs text-txt-secondary block mb-1">Hashtags:</span>
                <div className="flex flex-wrap gap-1">
                  {seo.hashtags.map((h) => (
                    <Badge key={h} variant="neutral">
                      {h}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card padding="md">
        <h4 className="text-sm font-semibold text-txt-primary mb-3">
          Episode Info
        </h4>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-txt-tertiary">ID</span>
            <p className="text-txt-secondary font-mono text-xs mt-0.5">
              {episode.id}
            </p>
          </div>
          <div>
            <span className="text-txt-tertiary">Series ID</span>
            <p className="text-txt-secondary font-mono text-xs mt-0.5">
              {episode.series_id}
            </p>
          </div>
          <div>
            <span className="text-txt-tertiary">Status</span>
            <div className="mt-0.5">
              <Badge variant={episode.status} dot>
                {episode.status}
              </Badge>
            </div>
          </div>
          <div>
            <span className="text-txt-tertiary">Base Path</span>
            <p className="text-txt-secondary font-mono text-xs mt-0.5">
              {episode.base_path ?? 'Not set'}
            </p>
          </div>
          <div>
            <span className="text-txt-tertiary">Created</span>
            <p className="text-txt-secondary text-xs mt-0.5">
              {new Date(episode.created_at).toLocaleString()}
            </p>
          </div>
          <div>
            <span className="text-txt-tertiary">Updated</span>
            <p className="text-txt-secondary text-xs mt-0.5">
              {new Date(episode.updated_at).toLocaleString()}
            </p>
          </div>
        </div>
      </Card>

      {/* Media Assets */}
      {episode.media_assets.length > 0 && (
        <Card padding="md">
          <h4 className="text-sm font-semibold text-txt-primary mb-3">
            Media Assets ({episode.media_assets.length})
          </h4>
          <div className="space-y-2">
            {episode.media_assets.map((asset) => (
              <div
                key={asset.id}
                className="flex items-center justify-between p-2 rounded bg-bg-hover text-xs"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="neutral">{asset.asset_type}</Badge>
                  <span className="text-txt-secondary font-mono">
                    {asset.file_path.split('/').pop()}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-txt-tertiary">
                  {asset.file_size_bytes && (
                    <span>
                      {(asset.file_size_bytes / 1024).toFixed(0)} KB
                    </span>
                  )}
                  {asset.duration_seconds && (
                    <span>{asset.duration_seconds.toFixed(1)}s</span>
                  )}
                  {asset.scene_number && (
                    <Badge variant="neutral">Scene {asset.scene_number}</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Generation Jobs */}
      {episode.generation_jobs.length > 0 && (
        <Card padding="md">
          <h4 className="text-sm font-semibold text-txt-primary mb-3">
            Generation Jobs ({episode.generation_jobs.length})
          </h4>
          <div className="space-y-2">
            {episode.generation_jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between p-2 rounded bg-bg-hover text-xs"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={job.step}>{job.step}</Badge>
                  <Badge variant={job.status as 'queued' | 'running' | 'done' | 'failed'} dot>
                    {job.status}
                  </Badge>
                  <span className="text-txt-tertiary font-mono">
                    {job.progress_pct}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-txt-tertiary">
                  {job.error_message && (
                    <span className="text-error max-w-xs text-truncate">
                      {job.error_message}
                    </span>
                  )}
                  {job.retry_count > 0 && (
                    <Badge variant="warning">
                      {job.retry_count} retries
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Generation Log */}
      {episode.generation_log && (
        <Card padding="md">
          <h4 className="text-sm font-semibold text-txt-primary mb-3">
            Generation Log
          </h4>
          <pre className="text-xs text-txt-secondary overflow-x-auto">
            {JSON.stringify(episode.generation_log, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}

export default EpisodeDetail;
