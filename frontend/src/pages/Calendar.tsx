import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Clock,
  Trash2,
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
  x: 'bg-gray-400',
};

const PLATFORM_TEXT_COLORS: Record<string, string> = {
  youtube: 'text-red-400',
  tiktok: 'text-cyan-400',
  instagram: 'text-pink-400',
  x: 'text-gray-400',
};

const PLATFORM_OPTIONS = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'x', label: 'X (Twitter)' },
];

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
}

function PostPill({ post, onCancel }: PostPillProps) {
  const colorClass = PLATFORM_COLORS[post.platform] ?? 'bg-gray-500';
  return (
    <div
      className={[
        'group flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-white',
        'truncate max-w-full cursor-default',
        colorClass,
      ].join(' ')}
      title={`${post.title} — ${formatTime(post.scheduled_at)}`}
    >
      <span className="truncate flex-1">{post.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCancel(post.id);
        }}
        className="opacity-0 group-hover:opacity-100 shrink-0 hover:text-white/70 transition-opacity"
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
                    <p className={`text-xs font-medium capitalize mt-0.5 ${colorClass}`}>
                      {post.platform}
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

  const handleCreated = () => {
    void fetchPosts();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isCurrentMonth = (date: Date) => date.getMonth() === currentMonth;

  const postsForDay = (date: Date): ScheduledPost[] =>
    posts.filter((p) => isSameDay(new Date(p.scheduled_at), date));

  return (
    <div className="flex gap-6 h-full" aria-label="Content Calendar">
      {/* ------------------------------------------------------------------ */}
      {/* Main calendar                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CalendarDays size={20} className="text-accent" aria-hidden="true" />
            <h1 className="text-xl font-bold text-txt-primary">Content Calendar</h1>
          </div>
          <div className="flex items-center gap-2">
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
          </div>
        </div>

        {/* Calendar grid */}
        <Card padding="none">
          {loading ? (
            <div className="flex items-center justify-center py-24" aria-busy="true">
              <Spinner size="lg" />
            </div>
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

                  return (
                    <div
                      key={day.toISOString()}
                      role="gridcell"
                      aria-label={`${day.toLocaleDateString()}${dayPosts.length > 0 ? `, ${dayPosts.length} post${dayPosts.length !== 1 ? 's' : ''}` : ''}`}
                      onClick={() => handleDayClick(day)}
                      className={[
                        'min-h-[100px] p-1.5 border-border flex flex-col gap-1 transition-colors',
                        !isLastInRow && 'border-r',
                        !isLastRow && 'border-b',
                        inMonth
                          ? 'cursor-pointer hover:bg-bg-hover'
                          : 'bg-bg-elevated/30 cursor-default',
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
                          />
                        ))}
                        {dayPosts.length > 3 && (
                          <p className="text-[10px] text-txt-tertiary px-1">
                            +{dayPosts.length - 3} more
                          </p>
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
