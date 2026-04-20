import { useNavigate } from 'react-router-dom';
import { Film } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { JobProgressBar } from '@/components/jobs/JobProgressBar';
import type { EpisodeListItem, ProgressMessage } from '@/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EpisodeCardProps {
  episode: EpisodeListItem;
  /** Real-time progress keyed by step, if available */
  stepProgress?: Record<string, ProgressMessage>;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function EpisodeCard({
  episode,
  stepProgress,
  className = '',
}: EpisodeCardProps) {
  const navigate = useNavigate();

  const isGenerating = episode.status === 'generating';

  return (
    <Card
      interactive
      padding="none"
      className={className}
      onClick={() => navigate(`/episodes/${episode.id}`)}
      aria-label={`Episode: ${episode.title} — ${episode.status}`}
    >
      {/* 9:16 Thumbnail area */}
      <div className="aspect-video-short bg-gradient-to-b from-bg-elevated to-bg-base relative overflow-hidden rounded-t-xl max-h-48 thumb-zoom">
        {episode.status === 'review' || episode.status === 'exported' ? (
          <img
            src={`/storage/episodes/${episode.id}/output/thumbnail.jpg`}
            alt={episode.title}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : null}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {episode.status !== 'review' && episode.status !== 'exported' && (
            <Film size={28} className="text-txt-tertiary opacity-40" />
          )}
        </div>
        {/* Bottom gradient overlay */}
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-bg-surface/90 to-transparent pointer-events-none" />
      </div>

      {/* Content */}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-display font-medium text-txt-primary text-truncate flex-1">
            {episode.title}
          </h4>
          <div className="flex items-center gap-1 shrink-0">
            {typeof (episode.metadata_?.seo as Record<string, unknown> | undefined)?.virality_score === 'number' && (
              <Badge
                variant={
                  ((episode.metadata_!.seo as Record<string, unknown>).virality_score as number) >= 7
                    ? 'success'
                    : ((episode.metadata_!.seo as Record<string, unknown>).virality_score as number) >= 5
                      ? 'warning'
                      : 'neutral'
                }
                aria-label={`Virality score: ${(episode.metadata_!.seo as Record<string, unknown>).virality_score} out of 10`}
              >
                {((episode.metadata_!.seo as Record<string, unknown>).virality_score as number)}/10
              </Badge>
            )}
            <Badge variant={episode.status} dot>
              {episode.status}
            </Badge>
          </div>
        </div>

        {episode.topic && (
          <p className="mt-1 text-xs text-txt-tertiary text-truncate">
            {episode.topic}
          </p>
        )}

        {/* Progress bar when generating */}
        {isGenerating && stepProgress && (
          <div className="mt-2">
            <JobProgressBar stepProgress={stepProgress} compact />
          </div>
        )}

        <p className="mt-2 text-xs font-display text-txt-tertiary">
          {formatDate(episode.updated_at)}
        </p>
      </div>
    </Card>
  );
}

export { EpisodeCard };
export type { EpisodeCardProps };
