import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Clock,
  Trash2,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { schedule as scheduleApi, episodes as episodesApi } from '@/lib/api';
import type { EpisodeListItem } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM_COLORS: Record<string, string> = {
  youtube: 'bg-red-500',
  tiktok: 'bg-cyan-500',
  instagram: 'bg-pink-500',
  facebook: 'bg-blue-500',
  x: 'bg-gray-400',
};

const PLATFORM_TEXT_COLORS: Record<string, string> = {
  youtube: 'text-red-400',
  tiktok: 'text-cyan-400',
  instagram: 'text-pink-400',
  facebook: 'text-blue-400',
  x: 'text-gray-400',
};

const PLATFORM_OPTIONS = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'x', label: 'X (Twitter)' },
];

// Lookup proper-cased label from a lowercase platform key. Avoids
// CSS ``capitalize`` producing "Youtube" / "Tiktok" — those are
// brand wordmarks, not English words, and need explicit casing.
const PLATFORM_LABELS: Record<string, string> = Object.fromEntries(
  PLATFORM_OPTIONS.map((p) => [p.value, p.label]),
);
function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? p;
}

const PRIVACY_OPTIONS = [
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'public', label: 'Public' },
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledPost {
  id: string;
  content_type: string;
  content_id: string;
  platform: string;
  scheduled_at: string;
  title: string;
  description?: string;
  tags?: string;
  privacy?: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

function formatDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface PostPillProps {
  post: ScheduledPost;
  onCancel: (id: string) => void;
  onDragStart?: (e: React.DragEvent, post: ScheduledPost) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

function PostPill({ post, onCancel, onDragStart, onDragEnd }: PostPillProps) {
  const dotColor = PLATFORM_COLORS[post.platform] ?? 'bg-gray-500';
  const draggable = post.status === 'scheduled';
  // Status drives chrome — red is reserved for failure/conflict; the
  // platform identity is communicated via the small colored dot, not
  // the whole pill. (Default pills used to be solid red because
  // YouTube → bg-red-500, which looked like every entry was failing.)
  const isFailed = post.status === 'failed';
  const isPublished = post.status === 'published' || post.status === 'done';
  const surfaceClass = isFailed
    ? 'bg-error/10 border border-error/30 text-error'
    : isPublished
      ? 'bg-accent/10 border border-accent/30 text-accent'
      : 'bg-bg-elevated border border-border text-txt-primary';
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.stopPropagation();
        onDragStart?.(e, post);
      }}
      onDragEnd={(e) => {
        e.stopPropagation();
        onDragEnd?.(e);
      }}
      className={[
        'group flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        'truncate max-w-full',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        surfaceClass,
      ].join(' ')}
      title={
        draggable
          ? `${post.title} — ${formatTime(post.scheduled_at)} · ${platformLabel(post.platform)} · drag to reschedule`
          : `${post.title} — ${formatTime(post.scheduled_at)} · ${platformLabel(post.platform)}`
      }
    >
      <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      <span className="truncate flex-1">{post.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCancel(post.id);
        }}
        className="opacity-0 group-hover:opacity-100 shrink-0 hover:text-txt-secondary transition-opacity"
        aria-label={`Remove schedule for ${post.title}`}
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule Dialog
// ---------------------------------------------------------------------------

interface ScheduleDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  preselectedDate?: Date | null;
  episodes: EpisodeListItem[];
}

function ScheduleDialog({
  open,
  onClose,
  onCreated,
  preselectedDate,
  episodes,
}: ScheduleDialogProps) {
  const { toast } = useToast();
  const [contentId, setContentId] = useState('');
  const [platform, setPlatform] = useState('youtube');
  const [scheduledAt, setScheduledAt] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState('public');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      const base = preselectedDate ?? new Date();
      // Default to noon on selected day
      const noon = new Date(base);
      noon.setHours(12, 0, 0, 0);
      setScheduledAt(formatDatetimeLocal(noon));
      setContentId('');
      setPlatform('youtube');
      setTitle('');
      setDescription('');
      setTags('');
      setPrivacy('public');
      setError('');
    }
  }, [open, preselectedDate]);

  // Auto-fill title when episode is selected
  useEffect(() => {
    if (contentId) {
      const ep = episodes.find((e) => e.id === contentId);
      if (ep) setTitle(ep.title ?? '');
    }
  }, [contentId, episodes]);

  const handleCreate = async () => {
    if (!contentId) { setError('Select an episode.'); return; }
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!scheduledAt) { setError('Scheduled date/time is required.'); return; }

    setSaving(true);
    setError('');
    try {
      await scheduleApi.create({
        content_type: 'episode',
        content_id: contentId,
        platform,
        scheduled_at: new Date(scheduledAt).toISOString(),
        title: title.trim(),
        description: description.trim() || undefined,
        tags: tags.trim() || undefined,
        privacy,
      });
      onCreated();
      onClose();
      toast.success('Post scheduled', { description: `${title.trim()} on ${platform}` });
    } catch (err: any) {
      const msg = err?.detail ?? err?.message ?? 'Failed to schedule post.';
      setError(msg);
      toast.error('Failed to schedule post', { description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const episodeOptions = [
    { value: '', label: 'Select an episode...' },
    ...episodes
      .filter((e) => e.status === 'review' || e.status === 'exported')
      .map((e) => ({ value: e.id, label: e.title ?? e.id })),
  ];

  return (
    <Dialog open={open} onClose={onClose} title="Schedule Post">
      <div className="space-y-4">
        <Select
          label="Episode"
          value={contentId}
          onChange={(e) => setContentId(e.target.value)}
          options={episodeOptions}
        />
        <Select
          label="Platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          options={PLATFORM_OPTIONS}
        />
        <Input
          label="Scheduled date & time"
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
        />
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Post title"
        />
        <Textarea
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="min-h-[80px]"
          placeholder="Post description..."
        />
        <Input
          label="Tags (optional, comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="shorts, tutorial, comedy"
        />
        <Select
          label="Privacy"
          value={privacy}
          onChange={(e) => setPrivacy(e.target.value)}
          options={PRIVACY_OPTIONS}
        />
        {error && (
          <p className="text-sm text-error" role="alert" aria-live="polite">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void handleCreate()}>
          <CalendarDays size={14} />
          Schedule
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Upcoming posts sidebar
// ---------------------------------------------------------------------------

interface UpcomingPanelProps {
  posts: ScheduledPost[];
  onSchedule: () => void;
  onCancel: (id: string) => void;
}

function UpcomingPanel({ posts, onSchedule, onCancel }: UpcomingPanelProps) {
  const now = new Date();
  const upcoming = [...posts]
    .filter((p) => new Date(p.scheduled_at) >= now)
    .sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    )
    .slice(0, 10);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-txt-primary">Upcoming</h2>
        <Button variant="primary" size="sm" onClick={onSchedule}>
          <Plus size={14} />
          Schedule
        </Button>
      </div>

      {upcoming.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
          <Clock size={28} className="text-txt-tertiary mb-2" />
          <p className="text-sm text-txt-tertiary">No upcoming posts</p>
          <p className="text-xs text-txt-tertiary mt-1">
            Click Schedule to add one
          </p>
        </div>
      ) : (
        <ul className="space-y-2 overflow-y-auto flex-1 pr-0.5" aria-label="Upcoming scheduled posts">
          {upcoming.map((post) => {
            const colorClass = PLATFORM_TEXT_COLORS[post.platform] ?? 'text-gray-400';
            return (
              <li
                key={post.id}
                className="bg-bg-elevated border border-border rounded-lg p-3 group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-txt-primary truncate">
                      {post.title}
                    </p>
                    <p className={`text-xs font-medium mt-0.5 ${colorClass}`}>
                      {platformLabel(post.platform)}
                    </p>
                    <p className="text-xs text-txt-tertiary mt-1 flex items-center gap-1">
                      <Clock size={11} />
                      {formatDate(post.scheduled_at)} at {formatTime(post.scheduled_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => onCancel(post.id)}
                    className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded hover:bg-error-muted text-txt-tertiary hover:text-error transition-all"
                    aria-label={`Cancel scheduled post: ${post.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar Page
// ---------------------------------------------------------------------------

function Calendar() {
  const { toast } = useToast();
  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  // Right Upcoming rail can be collapsed to reclaim grid space; the
  // calendar then uses the full main area. Persisted only in this
  // component's lifetime — cheap toggle, no need for localStorage.
  const [upcomingCollapsed, setUpcomingCollapsed] = useState(false);
  // Day cell that's currently expanded into a full popover (so the
  // user can read every post on a heavily-scheduled day instead of
  // staring at "+N more"). Keyed by ISO yyyy-mm-dd.
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  // View mode — Month grid is the default; List flattens every post
  // in the visible window into a single sorted feed (better for users
  // who think in "what's coming next" rather than dates).
  const [view, setView] = useState<'month' | 'list'>('month');
  // Quick filters — empty string means "all". Filters apply across
  // all views.
  const [platformFilter, setPlatformFilter] = useState<string>('');

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchPosts = useCallback(async () => {
    try {
      // Fetch a wide window (prev month through next month) so navigation
      // doesn't flash empty and the "Upcoming" sidebar has enough data.
      const rangeStart = new Date(currentYear, currentMonth - 1, 1);
      const rangeEnd = new Date(currentYear, currentMonth + 2, 0); // last day of next month
      const startStr = `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, '0')}-01`;
      const endStr = `${rangeEnd.getFullYear()}-${String(rangeEnd.getMonth() + 1).padStart(2, '0')}-${String(rangeEnd.getDate()).padStart(2, '0')}`;
      const calendarData = await scheduleApi.calendar(startStr, endStr);
      // calendar endpoint returns CalendarDay[] — flatten to ScheduledPost[]
      const flat: ScheduledPost[] = [];
      for (const day of calendarData) {
        for (const post of day.posts) {
          flat.push(post);
        }
      }
      setPosts(flat);
    } catch (err) {
      // Backend may not exist yet — show empty state gracefully
      setPosts([]);
      toast.error('Failed to load scheduled posts', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast, currentYear, currentMonth]);

  const fetchEpisodes = useCallback(async () => {
    try {
      const data = await episodesApi.list();
      setEpisodes(data);
    } catch (err) {
      setEpisodes([]);
      toast.error('Failed to load episodes', { description: String(err) });
    }
  }, [toast]);

  useEffect(() => {
    void fetchPosts();
    void fetchEpisodes();
  }, [fetchPosts, fetchEpisodes]);

  // ---------------------------------------------------------------------------
  // Calendar grid construction
  // ---------------------------------------------------------------------------

  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  // Monday-based: Sunday=0 in JS → make it index 6
  const startPadding = (firstDay.getDay() + 6) % 7;

  const days: Date[] = [];
  for (let i = -startPadding; i < lastDay.getDate(); i++) {
    days.push(new Date(currentYear, currentMonth, i + 1));
  }
  // Pad to complete the last row
  while (days.length % 7 !== 0) {
    const last = days[days.length - 1]!;
    days.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const goToPrev = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear((y) => y - 1);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  };

  const goToNext = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear((y) => y + 1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  };

  const goToToday = () => {
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth());
  };

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleDayClick = (day: Date) => {
    if (day.getMonth() !== currentMonth) return;
    setSelectedDay(day);
    setScheduleDialogOpen(true);
  };

  const handleCancel = async (id: string) => {
    try {
      await scheduleApi.cancel(id);
      setPosts((prev) => prev.filter((p) => p.id !== id));
      toast.success('Scheduled post cancelled');
    } catch (err) {
      toast.error('Failed to cancel scheduled post', { description: String(err) });
    }
  };

  // ── Drag-and-drop rescheduling ─────────────────────────────────────
  // Users drag a PostPill from one day cell to another. The target
  // day's date replaces the post's date component; the time-of-day
  // is preserved so a user who carefully picked 14:00 doesn't lose it.
  const [draggedPost, setDraggedPost] = useState<ScheduledPost | null>(null);
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, post: ScheduledPost) => {
    setDraggedPost(post);
    // Needed in Firefox — any data, value is irrelevant (we track the
    // dragged post in React state).
    try {
      e.dataTransfer.setData('text/plain', post.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* older browsers */
    }
  };

  const handleDragEnd = () => {
    setDraggedPost(null);
    setDragOverDay(null);
  };

  const handleDayDragOver = (e: React.DragEvent, day: Date) => {
    if (!draggedPost) return;
    if (day.getMonth() !== currentMonth) return;
    e.preventDefault(); // required to allow drop
    e.dataTransfer.dropEffect = 'move';
    const key = day.toISOString().slice(0, 10);
    if (dragOverDay !== key) setDragOverDay(key);
  };

  const handleDayDragLeave = (e: React.DragEvent, day: Date) => {
    // Only clear if leaving the cell itself, not a child.
    if (e.currentTarget === e.target) {
      const key = day.toISOString().slice(0, 10);
      if (dragOverDay === key) setDragOverDay(null);
    }
  };

  const handleDayDrop = async (e: React.DragEvent, day: Date) => {
    e.preventDefault();
    const post = draggedPost;
    setDraggedPost(null);
    setDragOverDay(null);
    if (!post) return;
    if (day.getMonth() !== currentMonth) return;

    // Preserve the original time-of-day; only the date changes.
    const original = new Date(post.scheduled_at);
    const nextDate = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      original.getHours(),
      original.getMinutes(),
      original.getSeconds(),
    );
    // No-op if user dropped on the same date.
    if (
      nextDate.getFullYear() === original.getFullYear() &&
      nextDate.getMonth() === original.getMonth() &&
      nextDate.getDate() === original.getDate()
    ) {
      return;
    }

    // Optimistic update.
    const nextIso = nextDate.toISOString();
    setPosts((prev) =>
      prev.map((p) => (p.id === post.id ? { ...p, scheduled_at: nextIso } : p)),
    );
    try {
      await scheduleApi.update(post.id, { scheduled_at: nextIso });
      toast.success('Rescheduled', {
        description: `${post.title} → ${formatDate(nextIso)} at ${formatTime(nextIso)}`,
      });
    } catch (err) {
      // Roll back on failure.
      setPosts((prev) =>
        prev.map((p) =>
          p.id === post.id ? { ...p, scheduled_at: post.scheduled_at } : p,
        ),
      );
      toast.error('Failed to reschedule', { description: String(err) });
    }
  };

  const handleCreated = () => {
    void fetchPosts();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isCurrentMonth = (date: Date) => date.getMonth() === currentMonth;

  // Filtered post universe — every code path below reads from this
  // so a single filter strip applies across Month, List, and the
  // Upcoming rail uniformly.
  const filteredPosts = platformFilter
    ? posts.filter((p) => p.platform === platformFilter)
    : posts;

  const postsForDay = (date: Date): ScheduledPost[] =>
    filteredPosts.filter((p) => isSameDay(new Date(p.scheduled_at), date));

  return (
    <div className="flex gap-6 h-full" aria-label="Content Calendar">
      {/* ------------------------------------------------------------------ */}
      {/* Main calendar                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Header — title + view toggle on the left, navigation +
            filters + rail toggle on the right. */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <CalendarDays size={20} className="text-accent" aria-hidden="true" />
            <h1 className="text-xl font-bold text-txt-primary">Content Calendar</h1>
            <div className="ml-2 inline-flex rounded-md border border-border p-0.5 bg-bg-elevated">
              {(['month', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={[
                    'text-xs px-2.5 py-1 rounded font-medium transition-colors',
                    view === v
                      ? 'bg-accent/15 text-accent'
                      : 'text-txt-secondary hover:text-txt-primary',
                  ].join(' ')}
                >
                  {v === 'month' ? 'Month' : 'List'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Platform filter — applies to every view. */}
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="text-xs h-8 px-2 bg-bg-base border border-white/[0.08] rounded text-txt-primary focus:outline-none focus:border-accent/40"
              aria-label="Filter by platform"
            >
              <option value="">All platforms</option>
              {PLATFORM_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {view === 'month' && (
              <>
                <Button variant="ghost" size="sm" onClick={goToPrev} aria-label="Previous month">
                  <ChevronLeft size={16} />
                </Button>
                <button
                  onClick={goToToday}
                  className="px-3 py-1.5 text-sm font-medium text-txt-secondary hover:text-txt-primary hover:bg-bg-hover rounded-md transition-colors"
                >
                  Today
                </button>
                <Button variant="ghost" size="sm" onClick={goToNext} aria-label="Next month">
                  <ChevronRight size={16} />
                </Button>
                <span className="text-base font-semibold text-txt-primary min-w-[160px] text-center">
                  {MONTH_NAMES[currentMonth]} {currentYear}
                </span>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setUpcomingCollapsed((v) => !v)}
              aria-label={upcomingCollapsed ? 'Show upcoming panel' : 'Hide upcoming panel'}
              title={upcomingCollapsed ? 'Show upcoming panel' : 'Hide upcoming panel'}
            >
              {upcomingCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
            </Button>
          </div>
        </div>

        {/* Calendar grid (Month) or flat list (List). */}
        <Card padding="none">
          {loading ? (
            <div className="flex items-center justify-center py-24" aria-busy="true">
              <Spinner size="lg" />
            </div>
          ) : view === 'list' ? (
            (() => {
              const sorted = [...filteredPosts].sort(
                (a, b) =>
                  new Date(a.scheduled_at).getTime() -
                  new Date(b.scheduled_at).getTime(),
              );
              if (sorted.length === 0) {
                return (
                  <div className="py-16 text-center text-sm text-txt-muted">
                    No scheduled posts in this view.
                  </div>
                );
              }
              // Group by ISO date so the list has natural day headers.
              const groups = new Map<string, ScheduledPost[]>();
              for (const p of sorted) {
                const key = new Date(p.scheduled_at).toISOString().slice(0, 10);
                const arr = groups.get(key) ?? [];
                arr.push(p);
                groups.set(key, arr);
              }
              return (
                <ul className="divide-y divide-border" aria-label="Scheduled posts">
                  {Array.from(groups.entries()).map(([dayKey, dayPosts]) => {
                    const d = new Date(`${dayKey}T00:00:00`);
                    const isTodayGroup = isSameDay(d, new Date());
                    return (
                      <li key={dayKey}>
                        <div
                          className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider ${
                            isTodayGroup ? 'text-accent' : 'text-txt-tertiary'
                          } bg-bg-elevated/40`}
                        >
                          {d.toLocaleDateString(undefined, {
                            weekday: 'long',
                            month: 'short',
                            day: 'numeric',
                          })}
                          {isTodayGroup && ' · Today'}
                        </div>
                        <ul className="divide-y divide-border/60">
                          {dayPosts.map((post) => (
                            <li
                              key={post.id}
                              className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover"
                            >
                              <span
                                className={`shrink-0 w-2 h-2 rounded-full ${PLATFORM_COLORS[post.platform] ?? 'bg-gray-500'}`}
                                aria-hidden="true"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="text-sm text-txt-primary truncate">
                                  {post.title}
                                </div>
                                <div className="text-[11px] text-txt-tertiary mt-0.5">
                                  {formatTime(post.scheduled_at)} ·{' '}
                                  {platformLabel(post.platform)} · {post.status}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleCancel(post.id)}
                                className="shrink-0 p-1 rounded text-txt-tertiary hover:text-error hover:bg-error/10"
                                aria-label={`Cancel ${post.title}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              );
            })()
          ) : (
            <div className="overflow-hidden rounded-xl">
              {/* Day-of-week headers */}
              <div
                className="grid grid-cols-7 border-b border-border"
                role="row"
                aria-label="Days of week"
              >
                {DAY_NAMES.map((day) => (
                  <div
                    key={day}
                    className="py-2 text-center text-xs font-semibold uppercase tracking-wider text-txt-tertiary"
                    role="columnheader"
                  >
                    {day}
                  </div>
                ))}
              </div>

              {/* Day cells — chunked into rows */}
              <div
                className="grid grid-cols-7"
                role="grid"
                aria-label={`${MONTH_NAMES[currentMonth]} ${currentYear}`}
              >
                {days.map((day, idx) => {
                  const dayPosts = postsForDay(day);
                  const inMonth = isCurrentMonth(day);
                  const todayFlag = isToday(day);
                  const isLastInRow = (idx + 1) % 7 === 0;
                  const isLastRow = idx >= days.length - 7;

                  const dayKey = day.toISOString().slice(0, 10);
                  const isDropTarget = dragOverDay === dayKey;
                  return (
                    <div
                      key={day.toISOString()}
                      role="gridcell"
                      aria-label={`${day.toLocaleDateString()}${dayPosts.length > 0 ? `, ${dayPosts.length} post${dayPosts.length !== 1 ? 's' : ''}` : ''}`}
                      onClick={() => handleDayClick(day)}
                      onDragOver={(e) => handleDayDragOver(e, day)}
                      onDragLeave={(e) => handleDayDragLeave(e, day)}
                      onDrop={(e) => void handleDayDrop(e, day)}
                      className={[
                        'min-h-[100px] p-1.5 border-border flex flex-col gap-1 transition-colors',
                        !isLastInRow && 'border-r',
                        !isLastRow && 'border-b',
                        inMonth
                          ? 'cursor-pointer hover:bg-bg-hover'
                          : 'bg-bg-elevated/30 cursor-default',
                        isDropTarget
                          ? 'bg-accent/10 outline outline-2 outline-accent/40 -outline-offset-2'
                          : '',
                      ].join(' ')}
                    >
                      {/* Day number */}
                      <div className="flex items-center justify-end mb-0.5">
                        <span
                          className={[
                            'text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full',
                            todayFlag
                              ? 'bg-accent text-white'
                              : inMonth
                              ? 'text-txt-primary'
                              : 'text-txt-tertiary',
                          ].join(' ')}
                          aria-current={todayFlag ? 'date' : undefined}
                        >
                          {day.getDate()}
                        </span>
                      </div>

                      {/* Post pills — show up to 3, then overflow */}
                      <div className="space-y-0.5 flex-1">
                        {dayPosts.slice(0, 3).map((post) => (
                          <PostPill
                            key={post.id}
                            post={post}
                            onCancel={handleCancel}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                          />
                        ))}
                        {dayPosts.length > 3 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedDay(dayKey);
                            }}
                            className="text-[10px] text-accent hover:underline px-1 self-start"
                            aria-label={`Show all ${dayPosts.length} posts on ${day.toLocaleDateString()}`}
                          >
                            +{dayPosts.length - 3} more
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>

        {/* Legend */}
        <div className="flex items-center gap-4 px-1">
          <span className="text-xs text-txt-tertiary font-medium">Platforms:</span>
          {PLATFORM_OPTIONS.map((p) => (
            <div key={p.value} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${PLATFORM_COLORS[p.value]}`} aria-hidden="true" />
              <span className="text-xs text-txt-secondary">{p.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Right sidebar — upcoming list                                        */}
      {/* ------------------------------------------------------------------ */}
      {!upcomingCollapsed && (
        <div className="w-72 shrink-0">
          <Card padding="md" className="h-full">
            <UpcomingPanel
              posts={posts}
              onSchedule={() => {
                setSelectedDay(null);
                setScheduleDialogOpen(true);
              }}
              onCancel={handleCancel}
            />
          </Card>
        </div>
      )}

      {/* "+N more" expansion — modal-ish overlay anchored by a backdrop.
          Lists every post on the chosen day so the user can act on
          anything without click-and-pray on the small day cells. */}
      {expandedDay && (() => {
        const dayPosts = posts.filter(
          (p) => new Date(p.scheduled_at).toISOString().slice(0, 10) === expandedDay,
        );
        const dayDate = new Date(`${expandedDay}T00:00:00`);
        return (
          <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setExpandedDay(null)}
            role="dialog"
            aria-label={`Posts on ${dayDate.toLocaleDateString()}`}
          >
            <div
              className="w-full max-w-sm rounded-xl border border-border bg-bg-surface shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div>
                  <h3 className="text-sm font-semibold text-txt-primary">
                    {dayDate.toLocaleDateString(undefined, {
                      weekday: 'long',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </h3>
                  <p className="text-xs text-txt-tertiary mt-0.5">
                    {dayPosts.length} scheduled post{dayPosts.length === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setExpandedDay(null)}
                  className="rounded p-1 text-txt-muted hover:text-txt-primary"
                  aria-label="Close"
                >
                  <X size={14} />
                </button>
              </div>
              <ul className="max-h-[60vh] overflow-y-auto divide-y divide-border">
                {dayPosts
                  .sort(
                    (a, b) =>
                      new Date(a.scheduled_at).getTime() -
                      new Date(b.scheduled_at).getTime(),
                  )
                  .map((post) => (
                    <li key={post.id} className="px-4 py-2.5 flex items-center gap-3">
                      <span
                        className={`shrink-0 w-2 h-2 rounded-full ${PLATFORM_COLORS[post.platform] ?? 'bg-gray-500'}`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-txt-primary truncate">
                          {post.title}
                        </div>
                        <div className="text-[11px] text-txt-tertiary mt-0.5">
                          {formatTime(post.scheduled_at)} ·{' '}
                          {platformLabel(post.platform)} · {post.status}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          handleCancel(post.id);
                        }}
                        className="shrink-0 p-1 rounded text-txt-tertiary hover:text-error hover:bg-error/10"
                        aria-label={`Cancel ${post.title}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        );
      })()}

      {/* ------------------------------------------------------------------ */}
      {/* Schedule dialog                                                      */}
      {/* ------------------------------------------------------------------ */}
      <ScheduleDialog
        open={scheduleDialogOpen}
        onClose={() => setScheduleDialogOpen(false)}
        onCreated={handleCreated}
        preselectedDate={selectedDay}
        episodes={episodes}
      />
    </div>
  );
}

export default Calendar;
