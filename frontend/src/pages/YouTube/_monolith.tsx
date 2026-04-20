import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useNavigate } from 'react-router-dom';
import {
  Youtube,
  Upload,
  ListVideo,
  BarChart3,
  Plus,
  Trash2,
  ExternalLink,
  Eye,
  ThumbsUp,
  MessageSquare,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Globe,
  TrendingUp,
  Share2,
  Percent,
  ImageOff,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { youtube as youtubeApi, social as socialApi } from '@/lib/api';
import type {
  SocialPlatform,
  SocialUpload,
  SocialPlatformStats,
} from '@/lib/api';
import type {
  YouTubeChannel,
  YouTubeUpload,
  YouTubePlaylist,
  YouTubeVideoStats,
} from '@/types';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: Youtube },
  { id: 'uploads', label: 'Uploads', icon: Upload },
  { id: 'playlists', label: 'Playlists', icon: ListVideo },
  { id: 'analytics', label: 'Analytics', icon: TrendingUp },
  { id: 'social', label: 'All Platforms', icon: Globe },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function uploadStatusVariant(status: YouTubeUpload['upload_status']): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'uploading':
      return 'generating';
    default:
      return 'neutral';
  }
}

/**
 * Returns the standard YouTube mqdefault thumbnail URL (320x180) for a video ID.
 * Returns null when no videoId is available so callers can render a fallback.
 */
function ytThumb(videoId: string | null | undefined): string | null {
  if (!videoId) return null;
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * Computes engagement rate as a percentage: (likes + comments) / views * 100.
 * Returns null when views is 0 to avoid division by zero.
 */
function engagementRate(views: number, likes: number, comments: number): number | null {
  if (views === 0) return null;
  return ((likes + comments) / views) * 100;
}

function formatEngagement(rate: number | null): string {
  if (rate === null) return '—';
  return `${rate.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// VideoThumbnail — shared thumbnail component with fallback
// ---------------------------------------------------------------------------

interface VideoThumbnailProps {
  videoId: string | null | undefined;
  title: string;
  width?: number;
  height?: number;
  className?: string;
}

function VideoThumbnail({ videoId, title, width = 120, height = 68, className = '' }: VideoThumbnailProps) {
  const [imgError, setImgError] = useState(false);
  const src = ytThumb(videoId);

  const baseStyle: React.CSSProperties = { width, height, minWidth: width };

  if (!src || imgError) {
    return (
      <div
        className={['bg-bg-active rounded flex items-center justify-center shrink-0', className].join(' ')}
        style={baseStyle}
        aria-hidden="true"
      >
        <ImageOff size={16} className="text-txt-tertiary" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={`Thumbnail for ${title}`}
      width={width}
      height={height}
      className={['object-cover rounded shrink-0', className].join(' ')}
      style={baseStyle}
      onError={() => setImgError(true)}
      loading="lazy"
    />
  );
}

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

interface PlatformConfig {
  id: string;
  label: string;
  dotClass: string;
  bgClass: string;
  textClass: string;
}

const PLATFORM_CONFIGS: PlatformConfig[] = [
  { id: 'youtube', label: 'YouTube', dotClass: 'bg-red-500', bgClass: 'bg-red-500/10', textClass: 'text-red-400' },
  { id: 'tiktok', label: 'TikTok', dotClass: 'bg-cyan-400', bgClass: 'bg-cyan-500/10', textClass: 'text-cyan-400' },
  { id: 'instagram', label: 'Instagram', dotClass: 'bg-pink-400', bgClass: 'bg-pink-500/10', textClass: 'text-pink-400' },
  { id: 'x', label: 'X', dotClass: 'bg-gray-300', bgClass: 'bg-gray-500/10', textClass: 'text-gray-300' },
];

function getPlatformConfig(platformId: string): PlatformConfig {
  return (
    PLATFORM_CONFIGS.find((p) => p.id === platformId.toLowerCase()) ?? {
      id: platformId,
      label: platformId,
      dotClass: 'bg-txt-tertiary',
      bgClass: 'bg-bg-active',
      textClass: 'text-txt-secondary',
    }
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  const config = getPlatformConfig(platform);
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
        config.bgClass,
        config.textClass,
      ].join(' ')}
    >
      <span className={['w-1.5 h-1.5 rounded-full shrink-0', config.dotClass].join(' ')} />
      {config.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Not-connected state
// ---------------------------------------------------------------------------

interface NotConnectedBannerProps {
  onConnect: () => void;
  connecting: boolean;
}

function NotConnectedBanner({ onConnect, connecting }: NotConnectedBannerProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-5">
      <div className="w-16 h-16 rounded-full bg-accent-muted flex items-center justify-center">
        <Youtube size={32} className="text-accent" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-txt-primary">
          YouTube not connected
        </h2>
        <p className="text-sm text-txt-secondary mt-1 max-w-xs">
          Connect your YouTube channel to upload videos, manage playlists, and
          view analytics.
        </p>
      </div>
      <Button variant="primary" loading={connecting} onClick={onConnect}>
        <Youtube size={14} />
        Connect YouTube
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard tab
// ---------------------------------------------------------------------------

interface DashboardTabProps {
  channel: YouTubeChannel;
  allChannels: YouTubeChannel[];
  uploads: YouTubeUpload[];
  stats: YouTubeVideoStats[];
  socialStats: SocialPlatformStats[];
  socialStatsLoading: boolean;
}

function DashboardTab({
  channel,
  allChannels,
  uploads,
  stats,
  socialStats,
  socialStatsLoading,
}: DashboardTabProps) {
  const totalViews = stats.reduce((sum, s) => sum + s.views, 0);
  const totalLikes = stats.reduce((sum, s) => sum + s.likes, 0);
  const totalComments = stats.reduce((sum, s) => sum + s.comments, 0);
  const overallEngagement = engagementRate(totalViews, totalLikes, totalComments);

  const recentUploads = [...uploads]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, 5);

  // Stats lookup by video ID for recent uploads section
  const statsByVideoId = new Map<string, YouTubeVideoStats>(
    stats.map((s) => [s.video_id, s]),
  );

  // Build a lookup for social stats by platform name
  const socialStatsByPlatform = new Map<string, SocialPlatformStats>(
    socialStats.map((s) => [s.platform.toLowerCase(), s]),
  );

  // Cross-platform totals (including YouTube row injected from props)
  const crossPlatformRows = PLATFORM_CONFIGS.map((cfg) => {
    if (cfg.id === 'youtube') {
      return {
        config: cfg,
        data: {
          total_uploads: uploads.length,
          total_views: totalViews,
          total_likes: totalLikes,
          total_comments: totalComments,
          total_shares: 0,
        } as SocialPlatformStats,
        connected: true,
      };
    }
    const data = socialStatsByPlatform.get(cfg.id) ?? null;
    return { config: cfg, data, connected: data !== null };
  });

  // Per-channel upload counts
  const uploadsByChannel = new Map<string, number>();
  uploads.forEach((u) => {
    const chId = (u as any).channel_id as string | undefined;
    if (chId) uploadsByChannel.set(chId, (uploadsByChannel.get(chId) ?? 0) + 1);
  });

  // Last upload date per channel
  const lastUploadByChannel = new Map<string, string>();
  [...uploads]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .forEach((u) => {
      const chId = (u as any).channel_id as string | undefined;
      if (chId && !lastUploadByChannel.has(chId)) lastUploadByChannel.set(chId, u.created_at);
    });

  const displayChannels = allChannels.length > 0 ? allChannels : [channel];

  return (
    <div className="space-y-6">
      {/* Per-channel overview cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {displayChannels.map((ch) => {
          const count = uploadsByChannel.get(ch.id) ?? 0;
          const lastDate = lastUploadByChannel.get(ch.id);
          return (
            <Card key={ch.id} padding="md">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-accent-muted flex items-center justify-center shrink-0">
                  <Youtube size={20} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-txt-primary truncate">
                      {ch.channel_name}
                    </p>
                    <Badge variant="success" dot>
                      Connected
                    </Badge>
                  </div>
                  <p className="text-xs text-txt-tertiary truncate mt-0.5">
                    {ch.channel_id}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-txt-secondary">
                      <span className="font-semibold text-txt-primary">{count}</span>{' '}
                      upload{count !== 1 ? 's' : ''}
                    </span>
                    {lastDate && (
                      <span className="text-xs text-txt-tertiary">
                        Last: {formatDate(lastDate)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* YouTube aggregate stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card padding="md">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent-muted flex items-center justify-center shrink-0">
              <Upload size={16} className="text-accent" />
            </div>
            <div>
              <p className="text-2xl font-bold text-txt-primary">
                {formatNumber(uploads.length)}
              </p>
              <p className="text-xs text-txt-secondary">Total Uploads</p>
            </div>
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-info-muted flex items-center justify-center shrink-0">
              <Eye size={16} className="text-info" />
            </div>
            <div>
              <p className="text-2xl font-bold text-txt-primary">
                {formatNumber(totalViews)}
              </p>
              <p className="text-xs text-txt-secondary">Total Views</p>
            </div>
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-success-muted flex items-center justify-center shrink-0">
              <ThumbsUp size={16} className="text-success" />
            </div>
            <div>
              <p className="text-2xl font-bold text-txt-primary">
                {formatNumber(totalLikes)}
              </p>
              <p className="text-xs text-txt-secondary">Total Likes</p>
            </div>
          </div>
        </Card>

        <Card padding="md">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-warning-muted flex items-center justify-center shrink-0">
              <Percent size={16} className="text-warning" />
            </div>
            <div>
              <p className="text-2xl font-bold text-txt-primary">
                {formatEngagement(overallEngagement)}
              </p>
              <p className="text-xs text-txt-secondary">Engagement Rate</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Cross-platform performance */}
      <Card padding="md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-txt-secondary" />
            <CardTitle>Cross-Platform Performance</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {socialStatsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div className="grid grid-cols-12 gap-3 px-1 pb-2 mb-1 border-b border-border">
                <span className="col-span-3 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
                  Platform
                </span>
                <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
                  <Upload size={10} />
                  Uploads
                </span>
                <span className="col-span-3 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
                  <Eye size={10} />
                  Views
                </span>
                <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
                  <ThumbsUp size={10} />
                  Likes
                </span>
                <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
                  <Share2 size={10} />
                  Shares
                </span>
              </div>

              <div className="space-y-1">
                {crossPlatformRows.map(({ config, data, connected }) => (
                  <div
                    key={config.id}
                    className="grid grid-cols-12 gap-3 items-center px-1 py-2 rounded hover:bg-bg-hover transition-colors duration-fast"
                  >
                    <div className="col-span-3 flex items-center gap-2 min-w-0">
                      <span
                        className={[
                          'w-2 h-2 rounded-full shrink-0',
                          config.dotClass,
                        ].join(' ')}
                      />
                      <span className={['text-sm font-medium truncate', config.textClass].join(' ')}>
                        {config.label}
                      </span>
                    </div>

                    {connected && data ? (
                      <>
                        <div className="col-span-2">
                          <span className="text-sm text-txt-primary font-medium">
                            {formatNumber(data.total_uploads)}
                          </span>
                        </div>
                        <div className="col-span-3">
                          <span className="text-sm text-txt-primary">
                            {formatNumber(data.total_views)}
                          </span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-sm text-txt-primary">
                            {formatNumber(data.total_likes)}
                          </span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-sm text-txt-primary">
                            {formatNumber(data.total_shares)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="col-span-9">
                        <span className="text-xs text-txt-tertiary italic">
                          Not connected
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent uploads */}
      <Card padding="md">
        <CardHeader>
          <CardTitle>Recent Uploads</CardTitle>
        </CardHeader>
        <CardContent>
          {recentUploads.length === 0 ? (
            <p className="text-sm text-txt-tertiary py-4 text-center">
              No uploads yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {recentUploads.map((u) => {
                const videoStats = u.youtube_video_id
                  ? statsByVideoId.get(u.youtube_video_id)
                  : undefined;
                return (
                  <li
                    key={u.id}
                    className="flex items-center gap-3 py-2 border-b border-border last:border-0"
                  >
                    {/* Thumbnail */}
                    <VideoThumbnail
                      videoId={u.youtube_video_id}
                      title={u.title}
                      width={96}
                      height={54}
                      className="rounded"
                    />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-txt-primary truncate">
                        {u.title}
                      </p>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        <span className="text-xs text-txt-tertiary">
                          {formatDate(u.created_at)}
                        </span>
                        {videoStats && videoStats.views > 0 && (
                          <span className="flex items-center gap-1 text-xs text-txt-secondary">
                            <Eye size={10} className="shrink-0" />
                            {formatNumber(videoStats.views)}
                          </span>
                        )}
                        {videoStats && videoStats.likes > 0 && (
                          <span className="flex items-center gap-1 text-xs text-txt-secondary">
                            <ThumbsUp size={10} className="shrink-0" />
                            {formatNumber(videoStats.likes)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Right side */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={uploadStatusVariant(u.upload_status)} dot>
                        {u.upload_status}
                      </Badge>
                      {u.youtube_url && (
                        <a
                          href={u.youtube_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-txt-tertiary hover:text-accent transition-colors duration-fast"
                          aria-label={`Open ${u.title} on YouTube`}
                        >
                          <ExternalLink size={13} />
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Uploads tab
// ---------------------------------------------------------------------------

interface UploadsTabProps {
  uploads: YouTubeUpload[];
  loading: boolean;
  channelMap?: Record<string, string>;
}

function UploadsTab({ uploads, loading, channelMap }: UploadsTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    );
  }

  if (uploads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Upload size={32} className="text-txt-tertiary" />
        <p className="text-sm text-txt-secondary">No uploads found.</p>
        <p className="text-xs text-txt-tertiary">
          Upload an episode from the Episodes page.
        </p>
      </div>
    );
  }

  const sorted = [...uploads].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="space-y-3">
      {sorted.map((upload) => {
        const channelName = channelMap?.[(upload as any).channel_id] ?? null;
        return (
          <Card key={upload.id} padding="md">
            <div className="flex items-start gap-4">
              {/* Thumbnail */}
              <VideoThumbnail
                videoId={upload.youtube_video_id}
                title={upload.title}
                width={120}
                height={68}
                className="mt-0.5"
              />

              {/* Main info */}
              <div className="flex-1 min-w-0 space-y-1.5">
                {/* Row 1: title + channel badge + status badge */}
                <div className="flex items-start gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-txt-primary leading-snug">
                    {upload.title}
                  </p>
                  {channelName && (
                    <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent-muted text-accent font-medium">
                      <Youtube size={10} />
                      {channelName}
                    </span>
                  )}
                  <Badge variant={uploadStatusVariant(upload.upload_status)} dot className="shrink-0">
                    {upload.upload_status}
                  </Badge>
                </div>

                {/* Row 2: description (1-line truncate) */}
                {(upload as any).description && (
                  <p className="text-xs text-txt-secondary truncate max-w-prose">
                    {(upload as any).description}
                  </p>
                )}

                {/* Row 3: error message if any */}
                {upload.error_message && (
                  <p className="text-xs text-error truncate">
                    {upload.error_message}
                  </p>
                )}

                {/* Row 4: meta — privacy, date, stats */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-txt-tertiary capitalize">
                    {upload.privacy_status}
                  </span>
                  <span className="text-txt-tertiary text-xs">·</span>
                  <span className="text-xs text-txt-tertiary">
                    {formatDate(upload.created_at)}
                  </span>
                  {(upload as any).views != null && (upload as any).views > 0 && (
                    <>
                      <span className="text-txt-tertiary text-xs">·</span>
                      <span className="flex items-center gap-1 text-xs text-txt-secondary">
                        <Eye size={10} className="shrink-0" />
                        {formatNumber((upload as any).views)}
                      </span>
                    </>
                  )}
                  {(upload as any).likes != null && (upload as any).likes > 0 && (
                    <span className="flex items-center gap-1 text-xs text-txt-secondary">
                      <ThumbsUp size={10} className="shrink-0" />
                      {formatNumber((upload as any).likes)}
                    </span>
                  )}
                  {(upload as any).comments != null && (upload as any).comments > 0 && (
                    <span className="flex items-center gap-1 text-xs text-txt-secondary">
                      <MessageSquare size={10} className="shrink-0" />
                      {formatNumber((upload as any).comments)}
                    </span>
                  )}
                </div>
              </div>

              {/* External link */}
              {upload.youtube_url && (
                <a
                  href={upload.youtube_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 p-1.5 rounded text-txt-tertiary hover:text-accent hover:bg-accent-muted transition-colors duration-fast mt-0.5"
                  aria-label={`Open ${upload.title} on YouTube`}
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlists tab
// ---------------------------------------------------------------------------

interface PlaylistsTabProps {
  playlists: YouTubePlaylist[];
  loading: boolean;
  onPlaylistCreated: () => void;
}

function PlaylistsTab({
  playlists,
  loading,
  onPlaylistCreated,
}: PlaylistsTabProps) {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<'public' | 'unlisted' | 'private'>('private');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await youtubeApi.createPlaylist({
        title: title.trim(),
        description: description.trim() || undefined,
        privacy_status: privacy,
      });
      setTitle('');
      setDescription('');
      setPrivacy('private');
      setCreateOpen(false);
      onPlaylistCreated();
      toast.success('Playlist created', { description: title.trim() });
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : 'Failed to create playlist.',
      );
      toast.error('Failed to create playlist', { description: String(err) });
    } finally {
      setCreating(false);
    }
  }, [title, description, privacy, onPlaylistCreated, toast]);

  const handleDelete = useCallback(
    async (playlistId: string) => {
      setDeletingId(playlistId);
      try {
        await youtubeApi.deletePlaylist(playlistId);
        toast.success('Playlist deleted');
        onPlaylistCreated(); // reuse refresh callback
      } catch (err) {
        toast.error('Failed to delete playlist', { description: String(err) });
      } finally {
        setDeletingId(null);
        setConfirmDeleteId(null);
      }
    },
    [onPlaylistCreated, toast],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    );
  }

  const playlistToDelete = playlists.find((p) => p.id === confirmDeleteId);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-txt-secondary">
          {playlists.length} playlist{playlists.length !== 1 ? 's' : ''}
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} />
          Create Playlist
        </Button>
      </div>

      {/* List */}
      {playlists.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <ListVideo size={32} className="text-txt-tertiary" />
          <p className="text-sm text-txt-secondary">No playlists yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {playlists.map((pl) => (
            <Card key={pl.id} padding="md">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 rounded-md bg-accent-muted flex items-center justify-center shrink-0">
                  <ListVideo size={15} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-txt-primary truncate">
                    {pl.title}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-txt-tertiary capitalize">
                      {pl.privacy_status}
                    </span>
                    <span className="text-txt-tertiary text-xs">·</span>
                    <span className="text-xs text-txt-tertiary">
                      {pl.item_count} video{pl.item_count !== 1 ? 's' : ''}
                    </span>
                    {pl.description && (
                      <>
                        <span className="text-txt-tertiary text-xs">·</span>
                        <span className="text-xs text-txt-tertiary truncate max-w-[200px]">
                          {pl.description}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <a
                    href={`https://www.youtube.com/playlist?list=${pl.youtube_playlist_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 rounded text-txt-tertiary hover:text-accent hover:bg-accent-muted transition-colors duration-fast"
                    aria-label={`Open playlist ${pl.title} on YouTube`}
                  >
                    <ExternalLink size={13} />
                  </a>
                  <button
                    onClick={() => setConfirmDeleteId(pl.id)}
                    disabled={deletingId === pl.id}
                    className="p-1.5 rounded text-txt-tertiary hover:text-error hover:bg-error-muted transition-colors duration-fast disabled:opacity-50"
                    aria-label={`Delete playlist ${pl.title}`}
                  >
                    {deletingId === pl.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreateError(null);
        }}
        title="Create Playlist"
        maxWidth="sm"
      >
        <div className="space-y-3">
          <div>
            <label
              htmlFor="playlist-title"
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              Title
            </label>
            <Input
              id="playlist-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My Shorts Playlist"
              aria-required="true"
            />
          </div>
          <div>
            <label
              htmlFor="playlist-description"
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              Description (optional)
            </label>
            <Input
              id="playlist-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A collection of shorts..."
            />
          </div>
          <div>
            <label
              htmlFor="playlist-privacy"
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              Privacy
            </label>
            <Select
              id="playlist-privacy"
              value={privacy}
              onChange={(e) =>
                setPrivacy(e.target.value as 'public' | 'unlisted' | 'private')
              }
              options={[
                { value: 'private', label: 'Private' },
                { value: 'unlisted', label: 'Unlisted' },
                { value: 'public', label: 'Public' },
              ]}
            />
          </div>
          {createError && (
            <div
              className="flex items-center gap-2 text-sm text-error"
              role="alert"
              aria-live="polite"
            >
              <AlertTriangle size={14} className="shrink-0" />
              {createError}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCreateOpen(false);
              setCreateError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={creating}
            disabled={!title.trim()}
            onClick={() => void handleCreate()}
          >
            Create
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={confirmDeleteId !== null}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete Playlist"
        maxWidth="sm"
      >
        <p className="text-sm text-txt-secondary">
          Are you sure you want to delete{' '}
          <span className="font-medium text-txt-primary">
            {playlistToDelete?.title}
          </span>
          ? This action cannot be undone.
        </p>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDeleteId(null)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            loading={deletingId === confirmDeleteId}
            onClick={() =>
              confirmDeleteId !== null && void handleDelete(confirmDeleteId)
            }
          >
            <Trash2 size={14} />
            Delete
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics tab
// ---------------------------------------------------------------------------

interface AnalyticsTabProps {
  uploads: YouTubeUpload[];
  loading: boolean;
  channelMap?: Record<string, string>;
}

function AnalyticsTab({ uploads, loading, channelMap }: AnalyticsTabProps) {
  const [stats, setStats] = useState<YouTubeVideoStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const completedUploads = uploads.filter(
    (u) => u.upload_status === 'done' && u.youtube_video_id,
  );

  const fetchStats = useCallback(async () => {
    if (completedUploads.length === 0) return;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const videoIds = completedUploads
        .map((u) => u.youtube_video_id!)
        .filter(Boolean);
      const data = await youtubeApi.getVideoStats(videoIds);
      // Sort by views descending
      setStats([...data].sort((a, b) => b.views - a.views));
    } catch (err) {
      setStatsError(
        err instanceof Error ? err.message : 'Failed to load analytics.',
      );
    } finally {
      setStatsLoading(false);
    }
  }, [completedUploads.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  if (loading || statsLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    );
  }

  if (completedUploads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <BarChart3 size={32} className="text-txt-tertiary" />
        <p className="text-sm text-txt-secondary">No published videos yet.</p>
        <p className="text-xs text-txt-tertiary">
          Analytics will appear here once videos finish uploading.
        </p>
      </div>
    );
  }

  if (statsError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <AlertTriangle size={28} className="text-error" />
        <p className="text-sm text-error">{statsError}</p>
        <Button variant="secondary" size="sm" onClick={() => void fetchStats()}>
          Retry
        </Button>
      </div>
    );
  }

  if (stats.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    );
  }

  // Compute averages for trending detection
  const avgViews =
    stats.length > 0 ? stats.reduce((s, v) => s + v.views, 0) / stats.length : 0;

  const totalViews = stats.reduce((s, v) => s + v.views, 0);
  const totalLikes = stats.reduce((s, v) => s + v.likes, 0);
  const totalComments = stats.reduce((s, v) => s + v.comments, 0);
  const overallEngagement = engagementRate(totalViews, totalLikes, totalComments);

  // Build a lookup: video ID -> upload record (for channel + thumbnail)
  const uploadByVideoId = new Map<string, YouTubeUpload>(
    uploads
      .filter((u) => u.youtube_video_id)
      .map((u) => [u.youtube_video_id!, u]),
  );

  const getChannelForVideo = (videoId: string): string => {
    const upload = uploadByVideoId.get(videoId);
    if (upload && channelMap) return channelMap[(upload as any).channel_id] ?? '';
    return '';
  };

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card padding="md">
          <p className="text-xs text-txt-tertiary">Total Videos</p>
          <p className="text-2xl font-bold text-txt-primary">{stats.length}</p>
        </Card>
        <Card padding="md">
          <p className="text-xs text-txt-tertiary">Total Views</p>
          <p className="text-2xl font-bold text-txt-primary">
            {formatNumber(totalViews)}
          </p>
        </Card>
        <Card padding="md">
          <p className="text-xs text-txt-tertiary">Total Likes</p>
          <p className="text-2xl font-bold text-txt-primary">
            {formatNumber(totalLikes)}
          </p>
        </Card>
        <Card padding="md">
          <p className="text-xs text-txt-tertiary">Engagement Rate</p>
          <p className="text-2xl font-bold text-txt-primary">
            {formatEngagement(overallEngagement)}
          </p>
        </Card>
      </div>

      {/* Video table */}
      <div className="space-y-2">
        {/* Header row */}
        <div className="grid grid-cols-12 gap-3 px-3 py-1.5">
          <span className="col-span-4 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
            Video
          </span>
          <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
            Channel
          </span>
          <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
            <Eye size={11} />
            Views
          </span>
          <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
            <ThumbsUp size={11} />
            Likes
          </span>
          <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
            <MessageSquare size={11} />
            Cmts
          </span>
          <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-1">
            <Percent size={11} />
            Eng.
          </span>
          <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
            Published
          </span>
        </div>

        {stats.map((s, idx) => {
          const isTrending = s.views > avgViews * 1.5;
          const isTopPerformer = idx < 3;
          const eng = engagementRate(s.views, s.likes, s.comments);
          const upload = uploadByVideoId.get(s.video_id);
          return (
            <Card
              key={s.video_id}
              padding="sm"
              className={isTrending ? 'ring-1 ring-accent/30 bg-accent/5' : ''}
            >
              <div className="grid grid-cols-12 gap-3 items-center">
                {/* Thumbnail + rank + title */}
                <div className="col-span-4 flex items-center gap-2 min-w-0">
                  <span
                    className={[
                      'text-xs font-mono w-4 shrink-0 text-center',
                      isTopPerformer ? 'text-accent font-bold' : 'text-txt-tertiary',
                    ].join(' ')}
                  >
                    {idx + 1}
                  </span>
                  <VideoThumbnail
                    videoId={s.video_id}
                    title={s.title}
                    width={64}
                    height={36}
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-txt-primary truncate leading-snug">
                      {s.title}
                    </p>
                    {isTrending && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] text-accent font-medium">
                        <TrendingUp size={9} /> Trending
                      </span>
                    )}
                  </div>
                </div>

                {/* Channel */}
                <div className="col-span-2 min-w-0">
                  <p className="text-xs text-txt-secondary truncate">
                    {getChannelForVideo(s.video_id)}
                  </p>
                </div>

                {/* Views */}
                <div className="col-span-1">
                  <span
                    className={[
                      'text-sm font-medium',
                      isTrending ? 'text-accent' : 'text-txt-primary',
                    ].join(' ')}
                  >
                    {formatNumber(s.views)}
                  </span>
                </div>

                {/* Likes */}
                <div className="col-span-1">
                  <span className="text-sm text-txt-primary">
                    {formatNumber(s.likes)}
                  </span>
                </div>

                {/* Comments */}
                <div className="col-span-1">
                  <span className="text-sm text-txt-primary">
                    {formatNumber(s.comments)}
                  </span>
                </div>

                {/* Engagement rate */}
                <div className="col-span-1">
                  <span
                    className={[
                      'text-sm',
                      eng !== null && eng >= 5
                        ? 'text-success font-medium'
                        : eng !== null && eng >= 2
                        ? 'text-txt-primary'
                        : 'text-txt-secondary',
                    ].join(' ')}
                  >
                    {formatEngagement(eng)}
                  </span>
                </div>

                {/* Published + external link */}
                <div className="col-span-2 flex items-center gap-2">
                  <span className="text-xs text-txt-secondary">
                    {s.published_at ? formatDate(s.published_at) : '—'}
                  </span>
                  {upload?.youtube_url && (
                    <a
                      href={upload.youtube_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-txt-tertiary hover:text-accent transition-colors duration-fast"
                      aria-label={`Open ${s.title} on YouTube`}
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Social tab
// ---------------------------------------------------------------------------

interface SocialTabProps {
  platforms: SocialPlatform[];
  uploads: SocialUpload[];
  loading: boolean;
}

function SocialTab({ platforms, uploads, loading }: SocialTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    );
  }

  const sortedUploads = [...uploads].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="space-y-6">
      {/* Connected platforms */}
      <Card padding="md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-txt-secondary" />
            <CardTitle>Connected Platforms</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {platforms.length === 0 ? (
            <p className="text-sm text-txt-tertiary py-4 text-center">
              No platforms connected. Connect accounts in Settings.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {platforms.map((p) => {
                const config = getPlatformConfig(p.platform);
                return (
                  <div
                    key={p.id}
                    className={[
                      'flex items-center gap-3 px-4 py-3 rounded-lg border border-border',
                      config.bgClass,
                    ].join(' ')}
                  >
                    <span className={['w-2.5 h-2.5 rounded-full shrink-0', config.dotClass].join(' ')} />
                    <div className="min-w-0 flex-1">
                      <p className={['text-sm font-semibold truncate', config.textClass].join(' ')}>
                        {config.label}
                      </p>
                      {p.account_name && (
                        <p className="text-xs text-txt-tertiary truncate">
                          @{p.account_name}
                        </p>
                      )}
                    </div>
                    <Badge variant="success" dot>
                      Active
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* All uploads across platforms */}
      <Card padding="md">
        <CardHeader>
          <CardTitle>All Platform Uploads</CardTitle>
        </CardHeader>
        <CardContent>
          {sortedUploads.length === 0 ? (
            <p className="text-sm text-txt-tertiary py-4 text-center">
              No uploads found across platforms.
            </p>
          ) : (
            <>
              {/* Column headers */}
              <div className="grid grid-cols-12 gap-3 px-1 pb-2 mb-1 border-b border-border">
                <span className="col-span-4 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
                  Title
                </span>
                <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
                  Platform
                </span>
                <span className="col-span-2 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
                  Status
                </span>
                <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-0.5">
                  <Eye size={10} />
                </span>
                <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-0.5">
                  <ThumbsUp size={10} />
                </span>
                <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider flex items-center gap-0.5">
                  <MessageSquare size={10} />
                </span>
                <span className="col-span-1 text-xs font-medium text-txt-tertiary uppercase tracking-wider">
                  Date
                </span>
              </div>

              <div className="space-y-1">
                {sortedUploads.map((u) => (
                  <div
                    key={u.id}
                    className="grid grid-cols-12 gap-3 items-center px-1 py-2 rounded hover:bg-bg-hover transition-colors duration-fast"
                  >
                    {/* Title */}
                    <div className="col-span-4 min-w-0">
                      <p className="text-sm text-txt-primary truncate font-medium">
                        {u.title}
                      </p>
                    </div>

                    {/* Platform */}
                    <div className="col-span-2">
                      <PlatformBadge platform={u.platform} />
                    </div>

                    {/* Status */}
                    <div className="col-span-2">
                      <Badge
                        variant={
                          u.upload_status === 'done'
                            ? 'done'
                            : u.upload_status === 'failed'
                            ? 'failed'
                            : 'neutral'
                        }
                        dot
                      >
                        {u.upload_status}
                      </Badge>
                    </div>

                    {/* Views */}
                    <div className="col-span-1">
                      <span className="text-xs text-txt-secondary">
                        {formatNumber(u.views)}
                      </span>
                    </div>

                    {/* Likes */}
                    <div className="col-span-1">
                      <span className="text-xs text-txt-secondary">
                        {formatNumber(u.likes)}
                      </span>
                    </div>

                    {/* Comments */}
                    <div className="col-span-1">
                      <span className="text-xs text-txt-secondary">
                        {formatNumber(u.comments)}
                      </span>
                    </div>

                    {/* Date + link */}
                    <div className="col-span-1 flex items-center gap-1 min-w-0">
                      <span className="text-xs text-txt-tertiary truncate">
                        {formatDate(u.created_at)}
                      </span>
                      {u.remote_url && (
                        <a
                          href={u.remote_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-txt-tertiary hover:text-accent transition-colors duration-fast"
                          aria-label={`Open ${u.title} on ${u.platform}`}
                        >
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// YouTube Page
// ---------------------------------------------------------------------------

function YouTubePage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [connected, setConnected] = useState(false);
  const [channel, setChannel] = useState<YouTubeChannel | null>(null);
  const [allChannels, setAllChannels] = useState<YouTubeChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('all');
  const [uploads, setUploads] = useState<YouTubeUpload[]>([]);
  const [playlists, setPlaylists] = useState<YouTubePlaylist[]>([]);
  const [stats, setStats] = useState<YouTubeVideoStats[]>([]);

  // Social state
  const [socialPlatforms, setSocialPlatforms] = useState<SocialPlatform[]>([]);
  const [socialUploads, setSocialUploads] = useState<SocialUpload[]>([]);
  const [socialStats, setSocialStats] = useState<SocialPlatformStats[]>([]);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialStatsLoading, setSocialStatsLoading] = useState(false);

  const [statusLoading, setStatusLoading] = useState(true);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // ---- Fetch connection status ----

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const result = await youtubeApi.getStatus();
      setConnected(result.connected);
      setChannel(result.channel);
      const channels = (result as any).channels ?? [];
      if (Array.isArray(channels)) setAllChannels(channels);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status.');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // ---- Fetch uploads ----

  const fetchUploads = useCallback(async () => {
    setUploadsLoading(true);
    try {
      const data = await youtubeApi.getUploads();
      setUploads(data);
    } catch (err) {
      toast.error('Failed to load uploads', { description: String(err) });
    } finally {
      setUploadsLoading(false);
    }
  }, [toast]);

  // ---- Fetch playlists ----

  const fetchPlaylists = useCallback(async () => {
    setPlaylistsLoading(true);
    try {
      const data = await youtubeApi.listPlaylists();
      setPlaylists(data);
    } catch (err) {
      toast.error('Failed to load playlists', { description: String(err) });
    } finally {
      setPlaylistsLoading(false);
    }
  }, [toast]);

  // ---- Fetch stats for dashboard ----

  const fetchStats = useCallback(
    async (currentUploads: YouTubeUpload[]) => {
      const completedUploads = currentUploads.filter(
        (u) => u.upload_status === 'done' && u.youtube_video_id,
      );
      if (completedUploads.length === 0) return;
      try {
        const videoIds = completedUploads
          .map((u) => u.youtube_video_id!)
          .filter(Boolean);
        const data = await youtubeApi.getVideoStats(videoIds);
        setStats(data);
      } catch (err) {
        toast.error('Failed to load video stats', { description: String(err) });
      }
    },
    [toast],
  );

  // ---- Fetch social data ----

  const fetchSocialData = useCallback(async () => {
    setSocialLoading(true);
    try {
      const [platforms, uploads] = await Promise.all([
        socialApi.listPlatforms(),
        socialApi.listUploads(),
      ]);
      setSocialPlatforms(platforms);
      setSocialUploads(uploads);
    } catch (err) {
      toast.error('Failed to load social data', { description: String(err) });
    } finally {
      setSocialLoading(false);
    }
  }, [toast]);

  const fetchSocialStats = useCallback(async () => {
    setSocialStatsLoading(true);
    try {
      const data = await socialApi.getStats();
      setSocialStats(Array.isArray(data) ? data : (data as any).platforms ?? []);
    } catch (err) {
      toast.error('Failed to load social stats', { description: String(err) });
    } finally {
      setSocialStatsLoading(false);
    }
  }, [toast]);

  // Load data once connected
  useEffect(() => {
    if (!connected) return;
    void fetchUploads().then((result) => {
      void result;
    });
    void fetchPlaylists();
    void fetchSocialData();
    void fetchSocialStats();
  }, [connected, fetchUploads, fetchPlaylists, fetchSocialData, fetchSocialStats]);

  // Fetch stats whenever uploads change
  useEffect(() => {
    if (!connected || uploads.length === 0) return;
    void fetchStats(uploads);
  }, [connected, uploads, fetchStats]);

  // ---- Connect OAuth ----

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const { auth_url } = await youtubeApi.getAuthUrl();
      window.location.href = auth_url;
    } catch (err) {
      toast.error('Failed to start YouTube OAuth', { description: String(err) });
      setConnecting(false);
    }
  }, [toast]);

  // ---- Render loading ----

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  // ---- Render top-level error ----

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <AlertTriangle size={28} className="text-error" />
        <p className="text-sm text-error">{error}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchStatus()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent-muted flex items-center justify-center">
            <Youtube size={18} className="text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-txt-primary">YouTube</h1>
            {connected && allChannels.length > 0 && (
              <p className="text-xs text-txt-secondary">
                {allChannels.length} channel{allChannels.length !== 1 ? 's' : ''} connected
              </p>
            )}
          </div>
          {/* Channel filter */}
          {connected && allChannels.length > 1 && (
            <select
              value={selectedChannelId}
              onChange={(e) => setSelectedChannelId(e.target.value)}
              className="bg-bg-elevated border border-border rounded-lg px-3 py-1.5 text-sm text-txt-primary"
              aria-label="Filter by channel"
            >
              <option value="all">All Channels</option>
              {allChannels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.channel_name}
                </option>
              ))}
            </select>
          )}
        </div>
        {connected && (
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-success" />
            <span className="text-xs text-success font-medium">Connected</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 text-txt-tertiary hover:text-txt-primary"
              onClick={() => navigate('/settings')}
            >
              Manage in Settings
            </Button>
          </div>
        )}
      </div>

      {/* Not connected: full-page prompt */}
      {!connected ? (
        <NotConnectedBanner
          onConnect={() => void handleConnect()}
          connecting={connecting}
        />
      ) : (
        <>
          {/* Tab bar */}
          <div className="flex border-b border-border">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors duration-fast',
                    'border-b-2 -mb-px',
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
          {(() => {
            const filteredUploads =
              selectedChannelId === 'all'
                ? uploads
                : uploads.filter((u) => (u as any).channel_id === selectedChannelId);
            const filteredPlaylists =
              selectedChannelId === 'all'
                ? playlists
                : playlists.filter((p) => p.channel_id === selectedChannelId);
            const activeChannel =
              selectedChannelId === 'all'
                ? channel
                : allChannels.find((c) => c.id === selectedChannelId) ?? channel;
            const channelMap = Object.fromEntries(
              allChannels.map((c) => [c.id, c.channel_name]),
            );

            return (
              <div>
                {activeTab === 'dashboard' && activeChannel && (
                  <DashboardTab
                    channel={activeChannel}
                    allChannels={
                      selectedChannelId === 'all'
                        ? allChannels
                        : allChannels.filter((c) => c.id === selectedChannelId)
                    }
                    uploads={filteredUploads}
                    stats={stats.filter((s) => {
                      if (selectedChannelId === 'all') return true;
                      const upload = uploads.find(
                        (u) => u.youtube_video_id === s.video_id,
                      );
                      return upload && (upload as any).channel_id === selectedChannelId;
                    })}
                    socialStats={socialStats}
                    socialStatsLoading={socialStatsLoading}
                  />
                )}
                {activeTab === 'uploads' && (
                  <UploadsTab
                    uploads={filteredUploads}
                    loading={uploadsLoading}
                    channelMap={channelMap}
                  />
                )}
                {activeTab === 'playlists' && (
                  <PlaylistsTab
                    playlists={filteredPlaylists}
                    loading={playlistsLoading}
                    onPlaylistCreated={() => {
                      void fetchPlaylists();
                    }}
                  />
                )}
                {activeTab === 'analytics' && (
                  <AnalyticsTab
                    uploads={filteredUploads}
                    loading={uploadsLoading}
                    channelMap={channelMap}
                  />
                )}
                {activeTab === 'social' && (
                  <SocialTab
                    platforms={socialPlatforms}
                    uploads={socialUploads}
                    loading={socialLoading}
                  />
                )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

export default YouTubePage;
