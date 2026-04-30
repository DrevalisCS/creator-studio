import { useState } from 'react';
import { RefreshCw, Replace, ImageOff, Clock } from 'lucide-react';
import { Button } from '@/components/ui/Button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SceneData {
  sceneNumber: number;
  imageUrl: string | null;
  prompt: string;
  durationSeconds: number;
}

interface SceneGridProps {
  scenes: SceneData[];
  onRegenerate?: (sceneNumber: number) => void;
  onReplace?: (sceneNumber: number) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function SceneGrid({
  scenes,
  onRegenerate,
  onReplace,
  className = '',
}: SceneGridProps) {
  const [hoveredScene, setHoveredScene] = useState<number | null>(null);

  if (scenes.length === 0) {
    return (
      <div className={`empty-state min-h-[200px] ${className}`}>
        <ImageOff size={32} className="text-txt-tertiary" />
        <p className="text-sm text-txt-tertiary">No scenes generated yet</p>
        <p className="text-xs text-txt-tertiary">
          Generate the script and scenes to see thumbnails here
        </p>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-2 gap-3 ${className}`}>
      {scenes.map((scene) => (
        <div
          key={scene.sceneNumber}
          className="surface-interactive relative overflow-hidden group"
          onMouseEnter={() => setHoveredScene(scene.sceneNumber)}
          onMouseLeave={() => setHoveredScene(null)}
        >
          {/* Thumbnail — design system §3 specifies 9:16 (vertical), matching
              the dominant 9:16 short-form output. The previous aspect-video
              (16:9) was leftover from an earlier landscape-first grid layout. */}
          <div className="aspect-[9/16] bg-bg-base relative overflow-hidden">
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

            {/* Hover overlay */}
            {hoveredScene === scene.sceneNumber && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center gap-2 animate-fade-in">
                {onRegenerate && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRegenerate(scene.sceneNumber);
                    }}
                  >
                    <RefreshCw size={12} />
                    Regenerate
                  </Button>
                )}
                {onReplace && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReplace(scene.sceneNumber);
                    }}
                  >
                    <Replace size={12} />
                    Replace
                  </Button>
                )}
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
      ))}
    </div>
  );
}

export { SceneGrid };
export type { SceneGridProps, SceneData };
