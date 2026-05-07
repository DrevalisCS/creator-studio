// ---------------------------------------------------------------------------
// TimelineGrid — 24-hour timeline grid used by DayView and WeekView.
//
// Layout approach:
//   A fixed-height scrollable container (24 * HOUR_HEIGHT_PX tall).
//   Inside it, hour-rule lines are stacked via absolute positioning.
//   Columns are laid out with flex; each column is also position:relative
//   so post cards can be absolutely positioned within them.
//   A fixed left gutter shows hour labels.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { isSameDay, isToday } from '../types';
import { PostChip } from '../PostChip';
import type { ScheduledPost } from '../types';

export const HOUR_HEIGHT_PX = 60;
const TOTAL_HEIGHT_PX = HOUR_HEIGHT_PX * 24;
const GUTTER_WIDTH = 56; // px

const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface TimelineGridProps {
  columns: Date[];
  posts: ScheduledPost[];
  onCancel: (id: string) => void;
}

function minuteToTopPx(minuteOfDay: number): number {
  return (minuteOfDay / 60) * HOUR_HEIGHT_PX;
}

function toMinuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function postsForColumn(posts: ScheduledPost[], col: Date): ScheduledPost[] {
  return posts.filter((p) => isSameDay(new Date(p.scheduled_at), col));
}

export function TimelineGrid({ columns, posts, onCancel }: TimelineGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const now = new Date();
  const showNowLine = columns.some((c) => isSameDay(c, now));
  const nowTopPx = minuteToTopPx(toMinuteOfDay(now));

  // Scroll current time to ~1/3 from top on mount
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, nowTopPx - el.clientHeight / 3);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
      {/* Column headers row */}
      <div
        className="flex shrink-0 border-b border-border"
        role="row"
        aria-label="Week days"
      >
        {/* Gutter spacer */}
        <div style={{ width: GUTTER_WIDTH, minWidth: GUTTER_WIDTH }} aria-hidden="true" />
        {columns.map((col) => (
          <div
            key={col.toISOString()}
            className={[
              'flex-1 min-w-0 py-2 flex flex-col items-center border-l border-border',
              isToday(col) ? 'text-accent' : 'text-txt-secondary',
            ].join(' ')}
            role="columnheader"
            aria-label={col.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          >
            <span className="text-[10px] uppercase tracking-wider">
              {col.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
            <span
              className={[
                'w-7 h-7 flex items-center justify-center rounded-full text-sm font-semibold mt-0.5',
                isToday(col) ? 'bg-accent text-white' : '',
              ].join(' ')}
              aria-current={isToday(col) ? 'date' : undefined}
            >
              {col.getDate()}
            </span>
          </div>
        ))}
      </div>

      {/* Scrollable timeline body */}
      <div ref={scrollRef} className="overflow-y-auto flex-1 relative" aria-label="24-hour timeline">
        <div
          className="flex"
          style={{ height: `${TOTAL_HEIGHT_PX}px`, position: 'relative' }}
        >
          {/* Hour-rule lines + gutter labels (absolutely positioned full-width stripes) */}
          <div
            className="absolute inset-0 pointer-events-none"
            aria-hidden="true"
          >
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="absolute left-0 right-0 border-b border-border/40"
                style={{ top: `${hour * HOUR_HEIGHT_PX}px`, height: `${HOUR_HEIGHT_PX}px` }}
              />
            ))}
          </div>

          {/* Gutter — hour labels */}
          <div
            className="relative shrink-0 select-none"
            style={{ width: GUTTER_WIDTH, minWidth: GUTTER_WIDTH }}
            aria-hidden="true"
          >
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="absolute right-2 text-[10px] text-txt-tertiary tabular-nums"
                style={{ top: `${hour * HOUR_HEIGHT_PX - 8}px` }}
              >
                {hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`}
              </div>
            ))}
          </div>

          {/* Current-time line */}
          {showNowLine && (
            <div
              className="absolute pointer-events-none z-10"
              style={{
                top: `${nowTopPx}px`,
                left: GUTTER_WIDTH,
                right: 0,
              }}
              aria-hidden="true"
            >
              <div className="absolute -left-1.5 -top-1.5 w-3 h-3 rounded-full bg-accent" />
              <div className="h-0.5 bg-accent/70 w-full" />
            </div>
          )}

          {/* Data columns */}
          <div className="flex flex-1 min-w-0">
            {columns.map((col) => {
              const colPosts = postsForColumn(posts, col);
              return (
                <div
                  key={col.toISOString()}
                  className="relative flex-1 min-w-0 border-l border-border"
                  style={{ height: `${TOTAL_HEIGHT_PX}px` }}
                  aria-label={col.toLocaleDateString(undefined, {
                    weekday: 'long',
                    month: 'short',
                    day: 'numeric',
                  })}
                >
                  {colPosts.map((post) => {
                    const topPx = minuteToTopPx(toMinuteOfDay(new Date(post.scheduled_at)));
                    return (
                      <div
                        key={post.id}
                        className="absolute left-1 right-1 z-20"
                        style={{ top: `${topPx}px` }}
                      >
                        <PostChip
                          post={post}
                          variant="full"
                          onCancel={onCancel}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
