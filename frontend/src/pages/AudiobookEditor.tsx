/**
 * Audiobook Editor (placeholder for v0.24.0).
 *
 * The full multi-track editor (per-clip volume / mute / fade across
 * voice, SFX, and music tracks, modelled on the existing
 * VideoEditor) is scheduled for v0.25.0.
 *
 * v0.24.0 ships:
 *  - The route + a discoverable Edit button on AudiobookDetail.
 *  - The Mix Controls card on AudiobookDetail (track-level gains +
 *    Remix endpoint) — covers 80% of what most users want today
 *    without needing the timeline UI.
 *
 * This page surfaces the same Mix Controls so anyone who clicks
 * "Edit" lands somewhere useful, plus a clear note about what's
 * coming.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Music, Mic, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { audiobooks as audiobooksApi } from '@/lib/api';
import type { Audiobook } from '@/types';

type MixState = {
  voice_db: number;
  music_db: number;
  sfx_db: number;
  voice_mute: boolean;
  music_mute: boolean;
  sfx_mute: boolean;
};

const TRACKS: Array<{
  key: 'voice' | 'music' | 'sfx';
  label: string;
  description: string;
  icon: typeof Music;
}> = [
  {
    key: 'voice',
    label: 'Voice',
    description: 'Narration + speaker dialogue',
    icon: Mic,
  },
  {
    key: 'music',
    label: 'Music',
    description: 'Background bed (ducked under voice)',
    icon: Music,
  },
  {
    key: 'sfx',
    label: 'SFX',
    description: 'Sound effects from [SFX:] tags',
    icon: Sparkles,
  },
];

export default function AudiobookEditor() {
  const { audiobookId = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [audiobook, setAudiobook] = useState<Audiobook | null>(null);
  const [loading, setLoading] = useState(true);
  const [mix, setMix] = useState<MixState>({
    voice_db: 0,
    music_db: 0,
    sfx_db: 0,
    voice_mute: false,
    music_mute: false,
    sfx_mute: false,
  });
  const [remixing, setRemixing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    audiobooksApi
      .get(audiobookId)
      .then((ab) => {
        if (cancelled) return;
        setAudiobook(ab);
        const tm = ab.track_mix || {};
        setMix({
          voice_db: tm.voice_db ?? 0,
          music_db: tm.music_db ?? 0,
          sfx_db: tm.sfx_db ?? 0,
          voice_mute: tm.voice_mute ?? false,
          music_mute: tm.music_mute ?? false,
          sfx_mute: tm.sfx_mute ?? false,
        });
      })
      .catch((err) =>
        toast.error('Failed to load audiobook', { description: String(err) }),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [audiobookId, toast]);

  const handleRemix = async () => {
    setRemixing(true);
    try {
      await audiobooksApi.remix(audiobookId, mix);
      toast.success('Remix queued', {
        description: 'Reusing cached audio — should complete in seconds.',
      });
      setTimeout(() => navigate(`/audiobooks/${audiobookId}`), 600);
    } catch (err) {
      toast.error('Remix failed', { description: String(err) });
    } finally {
      setRemixing(false);
    }
  };

  if (loading || !audiobook) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-base p-6 pb-32">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/audiobooks/${audiobookId}`)}
          >
            <ArrowLeft size={14} /> Back to audiobook
          </Button>
          <div className="text-sm text-txt-tertiary">
            Audiobook Editor
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-display font-bold text-txt-primary">
            {audiobook.title}
          </h1>
          <p className="text-sm text-txt-secondary mt-1">
            Multi-track timeline coming in v0.25.0. For now, adjust the
            track-level gains below and Remix to re-render the audio mix
            without re-running TTS or image generation.
          </p>
        </div>

        <Card padding="lg">
          <h2 className="text-sm font-semibold text-txt-primary mb-4 uppercase tracking-wider">
            Track levels
          </h2>
          <div className="space-y-5">
            {TRACKS.map(({ key, label, description, icon: Icon }) => {
              const dbKey = `${key}_db` as const;
              const muteKey = `${key}_mute` as const;
              const value = mix[dbKey];
              const muted = mix[muteKey];
              return (
                <div key={key} className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-bg-elevated flex items-center justify-center shrink-0">
                    <Icon size={20} className="text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <p className="text-sm font-semibold text-txt-primary">
                          {label}
                        </p>
                        <p className="text-[11px] text-txt-tertiary">
                          {description}
                        </p>
                      </div>
                      <span className="tabular-nums text-sm text-txt-primary">
                        {muted
                          ? 'Muted'
                          : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={-20}
                        max={12}
                        step={0.5}
                        value={value}
                        disabled={muted}
                        onChange={(e) =>
                          setMix((p) => ({
                            ...p,
                            [dbKey]: parseFloat(e.target.value),
                          }))
                        }
                        className="flex-1 accent-accent disabled:opacity-30"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setMix((p) => ({ ...p, [muteKey]: !p[muteKey] }))
                        }
                        className={[
                          'px-3 py-1 rounded text-xs font-medium uppercase tracking-wide transition-colors',
                          muted
                            ? 'bg-error/15 text-error'
                            : 'bg-bg-elevated text-txt-secondary hover:text-txt-primary',
                        ].join(' ')}
                      >
                        {muted ? 'Unmute' : 'Mute'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card padding="md" className="border-info/20 bg-info/[0.04]">
          <p className="text-xs text-txt-secondary leading-relaxed">
            <strong className="text-txt-primary">Coming soon (v0.25.0):</strong>{' '}
            multi-track timeline with per-clip controls. Drag-to-select
            individual voice / SFX / music clips, set per-clip gain, mute,
            fade-in/out. Per-clip overrides will live under{' '}
            <code className="text-accent">track_mix.clips</code> on the
            same audiobook record so this Mix Controls panel and the
            timeline editor stay in sync.
          </p>
        </Card>

        <div className="flex items-center justify-end gap-2 sticky bottom-6 bg-bg-base/90 backdrop-blur p-3 rounded-xl border border-border">
          <Button
            variant="ghost"
            onClick={() =>
              setMix({
                voice_db: 0,
                music_db: 0,
                sfx_db: 0,
                voice_mute: false,
                music_mute: false,
                sfx_mute: false,
              })
            }
          >
            Reset to passthrough
          </Button>
          <Button
            variant="primary"
            loading={remixing}
            onClick={() => void handleRemix()}
          >
            Save & Remix
          </Button>
        </div>
      </div>
    </div>
  );
}
