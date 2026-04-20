import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Film,
  Filter,
  Play,
  Copy,
  Trash2,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Input';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { EpisodeCard } from '@/components/episodes/EpisodeCard';
import { useActiveJobsProgress } from '@/lib/websocket';
import { useToast } from '@/components/ui/Toast';
import {
  episodes as episodesApi,
  series as seriesApi,
} from '@/lib/api';
import type {
  EpisodeListItem,
  SeriesListItem,
  EpisodeCreate,
} from '@/types';

// ---------------------------------------------------------------------------
// Status filter tabs
// ---------------------------------------------------------------------------

const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'generating', label: 'Generating' },
  { value: 'review', label: 'Review' },
  { value: 'failed', label: 'Failed' },
] as const;

// ---------------------------------------------------------------------------
// Episodes List Page
// ---------------------------------------------------------------------------

function EpisodesList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [episodesList, setEpisodesList] = useState<EpisodeListItem[]>([]);
  const [seriesList, setSeriesList] = useState<SeriesListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('');

  // Create episode dialog
  const showCreate = searchParams.get('create') === 'true';
  const [createDialogOpen, setCreateDialogOpen] = useState(showCreate);
  const [creating, setCreating] = useState(false);
  const [newSeriesId, setNewSeriesId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newTopic, setNewTopic] = useState('');

  // Delete confirm dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingEpisodeId, setDeletingEpisodeId] = useState<string | null>(null);
  const [deletingEpisodeTitle, setDeletingEpisodeTitle] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Duplicate loading
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  // Generate all drafts
  const [generatingAllDrafts, setGeneratingAllDrafts] = useState(false);

  // Toast notifications
  const { toast } = useToast();

  // WebSocket progress
  const { latestByEpisode } = useActiveJobsProgress();

  const fetchData = useCallback(async () => {
    try {
      const [eps, ser] = await Promise.all([
        episodesApi.list({
          series_id: seriesFilter || undefined,
          status: statusFilter || undefined,
        }),
        seriesApi.list(),
      ]);
      setEpisodesList(eps);
      setSeriesList(ser);
    } catch (err) {
      toast.error('Failed to load episodes', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, seriesFilter]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (showCreate) setCreateDialogOpen(true);
  }, [showCreate]);

  const seriesOptions = [
    { value: '', label: 'All Series' },
    ...seriesList.map((s) => ({ value: s.id, label: s.name })),
  ];

  const handleCreate = async () => {
    if (!newSeriesId || !newTitle.trim()) return;
    setCreating(true);
    try {
      const payload: EpisodeCreate = {
        series_id: newSeriesId,
        title: newTitle.trim(),
        topic: newTopic.trim() || undefined,
      };
      const ep = await episodesApi.create(payload);
      setCreateDialogOpen(false);
      setNewTitle('');
      setNewTopic('');
      navigate(`/episodes/${ep.id}`);
    } catch (err) {
      toast.error('Failed to create episode', { description: String(err) });
    } finally {
      setCreating(false);
    }
  };

  const handleCancelEpisode = async (episodeId: string) => {
    try {
      await episodesApi.cancel(episodeId);
      void fetchData();
    } catch (err) {
      toast.error('Failed to cancel episode', { description: String(err) });
    }
  };

  const handleGenerateEpisode = async (episodeId: string) => {
    try {
      await episodesApi.generate(episodeId);
      toast.success('Episode generation started');
      void fetchData();
    } catch (err) {
      toast.error('Failed to start generation', { description: String(err) });
    }
  };

  const handleDuplicateEpisode = async (episodeId: string) => {
    setDuplicatingId(episodeId);
    try {
      const dup = await episodesApi.duplicate(episodeId);
      navigate(`/episodes/${dup.id}`);
    } catch (err) {
      toast.error('Failed to duplicate episode', { description: String(err) });
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDeleteEpisode = async () => {
    if (!deletingEpisodeId) return;
    setDeleting(true);
    try {
      await episodesApi.delete(deletingEpisodeId);
      setDeleteDialogOpen(false);
      setDeletingEpisodeId(null);
      toast.success('Episode deleted');
      void fetchData();
    } catch (err) {
      toast.error('Failed to delete episode', { description: String(err) });
    } finally {
      setDeleting(false);
    }
  };

  const handleGenerateAllDrafts = async () => {
    const drafts = episodesList.filter((ep) => ep.status === 'draft');
    if (drafts.length === 0) return;
    setGeneratingAllDrafts(true);
    try {
      await Promise.all(drafts.map((ep) => episodesApi.generate(ep.id)));
      toast.success('Episode generation started', { description: `${drafts.length} draft${drafts.length === 1 ? '' : 's'} queued` });
      void fetchData();
    } catch (err) {
      toast.error('Failed to generate all drafts', { description: String(err) });
    } finally {
      setGeneratingAllDrafts(false);
    }
  };

  // Count drafts for the "Generate All Draft" button
  const draftCount = episodesList.filter((ep) => ep.status === 'draft').length;

  // Status counts for tab badges
  const statusCounts: Record<string, number> = {};
  for (const ep of episodesList) {
    statusCounts[ep.status] = (statusCounts[ep.status] ?? 0) + 1;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-txt-primary">Episodes</h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Browse and manage all episodes across your series.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {draftCount > 0 && (
            <Button
              variant="secondary"
              loading={generatingAllDrafts}
              onClick={() => void handleGenerateAllDrafts()}
            >
              <Play size={14} />
              Generate All Draft ({draftCount})
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus size={14} />
            New Episode
          </Button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-white/[0.06]">
        {STATUS_TABS.map((tab) => {
          const isActive = statusFilter === tab.value;
          // For the "All" tab, use total; for specific statuses, use current unfiltered count
          // (We show the count from currently fetched list which respects series filter)
          const count = tab.value === ''
            ? episodesList.length
            : episodesList.filter((ep) => ep.status === tab.value).length;

          return (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={[
                'flex items-center gap-1.5 px-4 py-2.5 text-sm font-display font-medium transition-colors duration-fast',
                'border-b-2 -mb-px',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.04]',
              ].join(' ')}
            >
              {tab.label}
              {count > 0 && (
                <span className={[
                  'text-xs px-1.5 py-0.5 rounded-full',
                  isActive ? 'bg-accent/20 text-accent' : 'bg-bg-hover text-txt-tertiary',
                ].join(' ')}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Series filter */}
      <div className="flex items-center gap-3 mb-6">
        <Filter size={14} className="text-txt-tertiary" />
        <div className="w-48">
          <Select
            options={seriesOptions}
            value={seriesFilter}
            onChange={(e) => setSeriesFilter(e.target.value)}
          />
        </div>
        <span className="text-xs text-txt-tertiary ml-2">
          {episodesList.length}{' '}
          {episodesList.length === 1 ? 'episode' : 'episodes'}
        </span>
      </div>

      {/* Grid */}
      {episodesList.length === 0 ? (
        <div className="empty-state py-16">
          <Film size={40} />
          <p className="text-sm font-display">No episodes found</p>
          <p className="text-xs font-display">
            {statusFilter || seriesFilter
              ? 'Try clearing your filters'
              : 'Create your first episode to get started'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {episodesList.map((ep) => (
            <div key={ep.id} className="relative group">
              <EpisodeCard
                episode={ep}
                stepProgress={latestByEpisode[ep.id]}
              />
              {/* Per-episode action buttons overlay */}
              <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                {(ep.status === 'draft' || ep.status === 'failed') && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleGenerateEpisode(ep.id);
                    }}
                    className="p-1.5 rounded bg-accent/90 text-white hover:bg-accent transition-colors"
                    title="Generate"
                  >
                    <Play size={12} />
                  </button>
                )}
                {ep.status === 'generating' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCancelEpisode(ep.id);
                    }}
                    className="p-1.5 rounded bg-red-600/80 text-white hover:bg-red-500 transition-colors"
                    title="Cancel Generation"
                  >
                    <Square size={12} />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDuplicateEpisode(ep.id);
                  }}
                  className="p-1.5 rounded bg-black/60 text-white hover:bg-black/80 backdrop-blur-sm transition-colors"
                  title="Duplicate"
                  disabled={duplicatingId === ep.id}
                >
                  <Copy size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingEpisodeId(ep.id);
                    setDeletingEpisodeTitle(ep.title);
                    setDeleteDialogOpen(true);
                  }}
                  className="p-1.5 rounded bg-black/60 text-red-400 hover:bg-red-600/80 hover:text-white backdrop-blur-sm transition-colors"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Episode Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        title="Create New Episode"
      >
        <div className="space-y-4">
          <Select
            label="Series"
            placeholder="Select a series..."
            options={seriesList.map((s) => ({ value: s.id, label: s.name }))}
            value={newSeriesId}
            onChange={(e) => setNewSeriesId(e.target.value)}
          />
          <Input
            label="Title"
            placeholder="Episode title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Textarea
            label="Topic"
            placeholder="What should this episode be about?"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCreateDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={creating}
            disabled={!newSeriesId || !newTitle.trim()}
            onClick={() => void handleCreate()}
          >
            Create Episode
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Episode Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => {
          setDeleteDialogOpen(false);
          setDeletingEpisodeId(null);
        }}
        title="Delete Episode?"
      >
        <p className="text-sm text-txt-secondary">
          This will permanently delete <strong>{deletingEpisodeTitle}</strong> and
          all generated media. This action cannot be undone.
        </p>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setDeleteDialogOpen(false);
              setDeletingEpisodeId(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deleting}
            onClick={() => void handleDeleteEpisode()}
          >
            <Trash2 size={14} />
            Delete Forever
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

export default EpisodesList;
