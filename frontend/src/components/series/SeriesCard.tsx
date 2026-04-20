import { useNavigate } from 'react-router-dom';
import { Film, Clock, Layers } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { SeriesListItem } from '@/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SeriesCardProps {
  series: SeriesListItem;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function SeriesCard({ series, className = '' }: SeriesCardProps) {
  const navigate = useNavigate();

  return (
    <Card
      interactive
      padding="none"
      className={className}
      onClick={() => navigate(`/series/${series.id}`)}
    >
      {/* Thumbnail / Placeholder */}
      <div className="h-32 bg-bg-base relative overflow-hidden rounded-t-md">
        <div className="absolute inset-0 flex items-center justify-center">
          <Layers size={32} className="text-txt-tertiary opacity-50" />
        </div>
        {/* Gradient overlay at bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-bg-surface to-transparent" />
      </div>

      {/* Content */}
      <div className="p-3">
        <h3 className="text-md font-semibold text-txt-primary text-truncate">
          {series.name}
        </h3>
        {series.description && (
          <p className="mt-1 text-xs text-txt-secondary text-clamp-2">
            {series.description}
          </p>
        )}

        {/* Meta row */}
        <div className="mt-3 flex items-center gap-3 text-xs text-txt-tertiary">
          <span className="inline-flex items-center gap-1">
            <Film size={12} />
            {series.episode_count}{' '}
            {series.episode_count === 1 ? 'episode' : 'episodes'}
          </span>
          <Badge variant="neutral">
            <Clock size={10} />
            {formatDuration(series.target_duration_seconds)}
          </Badge>
        </div>

        <p className="mt-2 text-xs text-txt-tertiary">
          Created {formatDate(series.created_at)}
        </p>
      </div>
    </Card>
  );
}

export { SeriesCard };
export type { SeriesCardProps };
