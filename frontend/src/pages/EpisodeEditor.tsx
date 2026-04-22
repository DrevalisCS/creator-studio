import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Pause,
  Trash2,
  Rocket,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Video as VideoIcon,
  Layers,
  Mic,
  Music2,
  Type,
  Image as ImageIcon,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import {
  editor as editorApi,
  formatError,
  type EditSession,
  type EditTimeline,
  type EditTimelineClip,
  type EditTimelineTrack,
} from '@/lib/api';

function waveformUrlFor(episodeId: string, trackId: string): string | null {
  if (trackId === 'voice') return `/api/v1/episodes/${episodeId}/editor/waveform?track=voice`;
  if (trackId === 'music') return `/api/v1/episodes/${episodeId}/editor/waveform?track=music`;
  return null;
}

// ─── Reducer for undo/redo ─────────────────────────────────────────

type Action =
  | { type: 'load'; timeline: EditTimeline }
  | { type: 'trim'; clipId: string; in_s?: number; out_s?: number }
  | { type: 'split'; clipId: string; at_s: number }
  | { type: 'delete'; clipId: string }
  | { type: 'reorder'; trackId: string; fromIndex: number; toIndex: number }
  | { type: 'add_overlay'; clip: EditTimelineClip }
  | { type: 'update_overlay'; clipId: string; patch: Partial<EditTimelineClip> }
  | { type: 'undo' }
  | { type: 'redo' };

interface HistoryState {
  past: EditTimeline[];
  present: EditTimeline;
  future: EditTimeline[];
}

function reflow(timeline: EditTimeline): EditTimeline {
  // Re-chain video-track clips so start_s / end_s are sequential. Audio
  // / overlay tracks keep user-authored starts.
  const tracks = timeline.tracks.map((t) => {
    if (t.kind !== 'video') return t;
    let cursor = 0;
    const clips = t.clips.map((c) => {
      const dur = Math.max(0, c.out_s - c.in_s);
      const next: EditTimelineClip = {
        ...c,
        start_s: Math.round(cursor * 1000) / 1000,
        end_s: Math.round((cursor + dur) * 1000) / 1000,
      };
      cursor += dur;
      return next;
    });
    return { ...t, clips };
  });
  const videoTrack = tracks.find((t) => t.kind === 'video');
  const dur = videoTrack
    ? videoTrack.clips.reduce((acc, c) => acc + (c.out_s - c.in_s), 0)
    : timeline.duration_s;
  return { ...timeline, tracks, duration_s: Math.round(dur * 1000) / 1000 };
}

function applyAction(timeline: EditTimeline, action: Action): EditTimeline {
  switch (action.type) {
    case 'trim': {
      const tracks = timeline.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== action.clipId) return c;
          const next: EditTimelineClip = { ...c };
          if (action.in_s !== undefined) next.in_s = Math.max(0, action.in_s);
          if (action.out_s !== undefined) next.out_s = Math.max(next.in_s + 0.1, action.out_s);
          return next;
        }),
      }));
      return reflow({ ...timeline, tracks });
    }
    case 'split': {
      const tracks = timeline.tracks.map((t) => {
        if (t.kind !== 'video') return t;
        const idx = t.clips.findIndex((c) => c.id === action.clipId);
        if (idx === -1) return t;
        const clip = t.clips[idx]!;
        const splitLocal = action.at_s - clip.start_s + clip.in_s;
        if (splitLocal <= clip.in_s || splitLocal >= clip.out_s) return t;
        const left: EditTimelineClip = { ...clip, out_s: splitLocal };
        const right: EditTimelineClip = {
          ...clip,
          id: `${clip.id}-s${Date.now()}`,
          in_s: splitLocal,
        };
        const clips = [...t.clips.slice(0, idx), left, right, ...t.clips.slice(idx + 1)];
        return { ...t, clips };
      });
      return reflow({ ...timeline, tracks });
    }
    case 'delete': {
      const tracks = timeline.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.id !== action.clipId),
      }));
      return reflow({ ...timeline, tracks });
    }
    case 'reorder': {
      const tracks = timeline.tracks.map((t) => {
        if (t.id !== action.trackId) return t;
        const clips = [...t.clips];
        const moved = clips.splice(action.fromIndex, 1)[0];
        if (!moved) return t;
        clips.splice(action.toIndex, 0, moved);
        return { ...t, clips };
      });
      return reflow({ ...timeline, tracks });
    }
    case 'add_overlay': {
      const tracks = timeline.tracks.map((t) =>
        t.id === 'overlay' ? { ...t, clips: [...t.clips, action.clip] } : t,
      );
      return { ...timeline, tracks };
    }
    case 'update_overlay': {
      const tracks = timeline.tracks.map((t) =>
        t.id === 'overlay'
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === action.clipId ? { ...c, ...action.patch } : c,
              ),
            }
          : t,
      );
      return { ...timeline, tracks };
    }
    default:
      return timeline;
  }
}

function historyReducer(state: HistoryState, action: Action): HistoryState {
  if (action.type === 'load') {
    return { past: [], present: action.timeline, future: [] };
  }
  if (action.type === 'undo') {
    if (!state.past.length) return state;
    const last = state.past[state.past.length - 1]!;
    return {
      past: state.past.slice(0, -1),
      present: last,
      future: [state.present, ...state.future],
    };
  }
  if (action.type === 'redo') {
    if (!state.future.length) return state;
    const nextState = state.future[0]!;
    return {
      past: [...state.past, state.present],
      present: nextState,
      future: state.future.slice(1),
    };
  }
  const nextTimeline = applyAction(state.present, action);
  if (nextTimeline === state.present) return state;
  return {
    past: [...state.past.slice(-49), state.present],
    present: nextTimeline,
    future: [],
  };
}

// ─── Page ──────────────────────────────────────────────────────────

export default function EpisodeEditor() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [session, setSession] = useState<EditSession | null>(null);
  const [history, dispatch] = useReducer(historyReducer, {
    past: [],
    present: { duration_s: 0, tracks: [] },
    future: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(60); // px per second
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const saveDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load session.
  useEffect(() => {
    if (!episodeId) return;
    setLoading(true);
    void editorApi
      .get(episodeId)
      .then((s) => {
        setSession(s);
        dispatch({ type: 'load', timeline: s.timeline });
      })
      .catch((e) => toast.error('Failed to open editor', { description: formatError(e) }))
      .finally(() => setLoading(false));
  }, [episodeId, toast]);

  // Debounced autosave whenever the timeline changes.
  useEffect(() => {
    if (!episodeId || !session) return;
    if (saveDebounce.current) clearTimeout(saveDebounce.current);
    saveDebounce.current = setTimeout(async () => {
      setSaving(true);
      try {
        await editorApi.save(episodeId, history.present);
      } catch (err) {
        toast.error('Autosave failed', { description: formatError(err) });
      } finally {
        setSaving(false);
      }
    }, 900);
    return () => {
      if (saveDebounce.current) clearTimeout(saveDebounce.current);
    };
  }, [history.present, episodeId, session, toast]);

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key.toLowerCase() === 's' && selectedClipId) {
        dispatch({ type: 'split', clipId: selectedClipId, at_s: playhead });
      }
      if (e.key === 'Backspace' && selectedClipId) {
        dispatch({ type: 'delete', clipId: selectedClipId });
        setSelectedClipId(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'undo' });
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [playhead, selectedClipId]);

  const onRender = async () => {
    if (!episodeId) return;
    setRendering(true);
    try {
      await editorApi.render(episodeId);
      toast.success('Render started', {
        description: 'Watch the Jobs page for progress. The episode will update when done.',
      });
      navigate(`/episodes/${episodeId}`);
    } catch (err) {
      toast.error('Render failed to start', { description: formatError(err) });
    } finally {
      setRendering(false);
    }
  };

  const timeline = history.present;

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null;
    for (const t of timeline.tracks) {
      for (const c of t.clips) {
        if (c.id === selectedClipId) return c;
      }
    }
    return null;
  }, [timeline, selectedClipId]);

  if (loading || !episodeId) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/episodes/${episodeId}`)}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <h1 className="text-lg font-semibold">Video Editor</h1>
        <div className="flex-1" />
        <span className="text-xs text-txt-muted">
          {saving ? 'Saving…' : 'Saved'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: 'undo' })}
          disabled={!history.past.length}
        >
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: 'redo' })}
          disabled={!history.future.length}
        >
          <Redo2 className="w-4 h-4" />
        </Button>
        <Button variant="primary" size="sm" onClick={() => void onRender()} disabled={rendering}>
          <Rocket className="w-4 h-4 mr-1" />
          {rendering ? 'Rendering…' : 'Render'}
        </Button>
      </div>

      {/* Preview + inspector */}
      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-8 p-3 flex flex-col items-center">
          <PreviewPlayer
            timeline={timeline}
            playhead={playhead}
            onPlayheadChange={setPlayhead}
            playing={playing}
            onPlayToggle={() => setPlaying((p) => !p)}
          />
        </Card>

        <Card className="col-span-4 p-4 space-y-3">
          <div className="text-xs uppercase tracking-wider text-txt-muted">Inspector</div>
          {selectedClip ? (
            selectedClip.kind ? (
              <OverlayInspector
                clip={selectedClip}
                onUpdate={(patch) =>
                  dispatch({ type: 'update_overlay', clipId: selectedClip.id, patch })
                }
                onDelete={() => {
                  dispatch({ type: 'delete', clipId: selectedClip.id });
                  setSelectedClipId(null);
                }}
              />
            ) : (
              <ClipInspector
                clip={selectedClip}
                onTrim={(in_s, out_s) =>
                  dispatch({ type: 'trim', clipId: selectedClip.id, in_s, out_s })
                }
                onDelete={() => {
                  dispatch({ type: 'delete', clipId: selectedClip.id });
                  setSelectedClipId(null);
                }}
              />
            )
          ) : (
            <div className="text-xs text-txt-muted">
              Select a clip in the timeline. Shortcuts: <kbd>Space</kbd> play ·{' '}
              <kbd>S</kbd> split · <kbd>⌫</kbd> delete · <kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd>.
            </div>
          )}
        </Card>
      </div>

      {/* Timeline controls */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </Button>
        <div className="text-xs font-mono text-txt-muted w-20">
          {playhead.toFixed(2)}s / {timeline.duration_s.toFixed(2)}s
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const id = `t-${Date.now()}`;
            dispatch({
              type: 'add_overlay',
              clip: {
                id,
                kind: 'text',
                text: 'New text',
                font_size: 56,
                color: '#ffffff',
                box: true,
                box_color: '#000000',
                x: '(w-text_w)/2',
                y: 'h-240',
                in_s: 0,
                out_s: Math.min(3, timeline.duration_s),
                start_s: playhead,
                end_s: Math.min(playhead + 3, timeline.duration_s),
              },
            });
            setSelectedClipId(id);
          }}
          title="Add text overlay"
        >
          <Type className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const id = `s-${Date.now()}`;
            dispatch({
              type: 'add_overlay',
              clip: {
                id,
                kind: 'shape',
                shape: 'rect',
                color: '#ffffff',
                w: 600,
                h: 6,
                x: '(w-w)/2',
                y: 'h-320',
                in_s: 0,
                out_s: 3,
                start_s: playhead,
                end_s: Math.min(playhead + 3, timeline.duration_s),
              },
            });
            setSelectedClipId(id);
          }}
          title="Add shape overlay"
        >
          <Square className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const path = window.prompt('Paste an asset path (storage-relative, e.g. assets/images/<uuid>/logo.png):');
            if (!path) return;
            const id = `i-${Date.now()}`;
            dispatch({
              type: 'add_overlay',
              clip: {
                id,
                kind: 'image',
                asset_path: path,
                x: '(W-w)/2',
                y: 'H-h-80',
                in_s: 0,
                out_s: 3,
                start_s: playhead,
                end_s: Math.min(playhead + 3, timeline.duration_s),
              },
            });
            setSelectedClipId(id);
          }}
          title="Add image overlay"
        >
          <ImageIcon className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.max(20, z - 20))}>
          <ZoomOut className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.min(240, z + 20))}>
          <ZoomIn className="w-4 h-4" />
        </Button>
      </div>

      {/* Timeline tracks */}
      <Card className="p-3 overflow-x-auto">
        <div className="space-y-2" style={{ minWidth: timeline.duration_s * zoom + 80 }}>
          {timeline.tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              zoom={zoom}
              duration={timeline.duration_s}
              playhead={playhead}
              onScrub={setPlayhead}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onReorder={(from, to) =>
                dispatch({ type: 'reorder', trackId: track.id, fromIndex: from, toIndex: to })
              }
              onTrim={(id, in_s, out_s) => dispatch({ type: 'trim', clipId: id, in_s, out_s })}
              waveformUrl={waveformUrlFor(episodeId, track.id)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── Preview player (HTML video element, one scene at a time) ─────

function PreviewPlayer({
  timeline,
  playhead,
  onPlayheadChange,
  playing,
  onPlayToggle,
}: {
  timeline: EditTimeline;
  playhead: number;
  onPlayheadChange: (t: number) => void;
  playing: boolean;
  onPlayToggle: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoTrack = timeline.tracks.find((t) => t.kind === 'video');
  const activeClip = videoTrack?.clips.find(
    (c) => playhead >= c.start_s && playhead < c.end_s,
  );
  const localTime = activeClip ? playhead - activeClip.start_s + activeClip.in_s : 0;

  // Use a raw storage URL for direct playback.
  const srcUrl = activeClip?.asset_path
    ? `/storage/${activeClip.asset_path}`
    : undefined;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !srcUrl) return;
    if (Math.abs(v.currentTime - localTime) > 0.25) v.currentTime = localTime;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, localTime, srcUrl]);

  // Advance playhead from the video element's currentTime when playing.
  useEffect(() => {
    if (!playing) return;
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      if (!activeClip) return;
      const delta = v.currentTime - activeClip.in_s;
      onPlayheadChange(activeClip.start_s + delta);
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [playing, activeClip, onPlayheadChange]);

  return (
    <div className="w-full max-w-md">
      <div className="aspect-[9/16] bg-black rounded-md overflow-hidden relative">
        {srcUrl ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={videoRef}
            src={srcUrl}
            className="w-full h-full object-contain"
            onClick={onPlayToggle}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-txt-muted text-xs">
            No scene at this position
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Track row ─────────────────────────────────────────────────────

function TrackRow({
  track,
  zoom,
  duration,
  playhead,
  onScrub,
  selectedClipId,
  onSelectClip,
  onReorder,
  onTrim,
  waveformUrl,
}: {
  track: EditTimelineTrack;
  zoom: number;
  duration: number;
  playhead: number;
  onScrub: (t: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  onReorder: (from: number, to: number) => void;
  onTrim: (id: string, in_s?: number, out_s?: number) => void;
  waveformUrl: string | null;
}) {
  const dragFrom = useRef<number | null>(null);
  const trackIcon = {
    video: VideoIcon,
    audio: track.id === 'voice' ? Mic : Music2,
    overlay: Layers,
    captions: Type,
  }[track.kind];
  const Icon = trackIcon;

  return (
    <div className="flex gap-2">
      <div className="w-24 shrink-0 flex items-center gap-1.5 text-xs text-txt-muted">
        <Icon size={12} />
        <span className="capitalize">{track.id}</span>
      </div>
      <div
        className="relative flex-1 h-12 bg-bg-elevated rounded overflow-hidden"
        style={{
          width: Math.max(duration * zoom, 400),
          backgroundImage: waveformUrl ? `url("${waveformUrl}")` : undefined,
          backgroundSize: '100% 100%',
          backgroundRepeat: 'no-repeat',
        }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onScrub((e.clientX - rect.left) / zoom);
        }}
      >
        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-px bg-accent z-10 pointer-events-none"
          style={{ left: playhead * zoom }}
        />
        {track.clips.map((clip, idx) => {
          const left = clip.start_s * zoom;
          const width = Math.max(4, (clip.end_s - clip.start_s) * zoom);
          const isSel = clip.id === selectedClipId;
          return (
            <div
              key={clip.id}
              draggable={track.kind === 'video'}
              onDragStart={() => (dragFrom.current = idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom.current !== null && dragFrom.current !== idx) {
                  onReorder(dragFrom.current, idx);
                }
                dragFrom.current = null;
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectClip(isSel ? null : clip.id);
              }}
              className={[
                'absolute top-1 bottom-1 rounded cursor-pointer flex items-center justify-between text-[10px] px-1 select-none',
                isSel
                  ? 'bg-accent/30 border border-accent'
                  : track.kind === 'video'
                  ? 'bg-indigo-500/30 border border-indigo-500/60'
                  : track.kind === 'audio'
                  ? track.id === 'voice'
                    ? 'bg-emerald-500/30 border border-emerald-500/60'
                    : 'bg-amber-500/30 border border-amber-500/60'
                  : 'bg-fuchsia-500/30 border border-fuchsia-500/60',
              ].join(' ')}
              style={{ left, width }}
              title={`${clip.id} · ${(clip.end_s - clip.start_s).toFixed(2)}s`}
            >
              {/* Left trim handle */}
              {track.kind === 'video' && (
                <TrimHandle
                  side="left"
                  onDrag={(delta_s) => {
                    onTrim(clip.id, Math.max(0, clip.in_s + delta_s), undefined);
                  }}
                  zoom={zoom}
                />
              )}
              <span className="truncate px-1 flex-1 text-center">
                {clip.scene_number ? `#${clip.scene_number}` : clip.id.slice(0, 6)}
              </span>
              {track.kind === 'video' && (
                <TrimHandle
                  side="right"
                  onDrag={(delta_s) => {
                    onTrim(clip.id, undefined, Math.max(clip.in_s + 0.2, clip.out_s + delta_s));
                  }}
                  zoom={zoom}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrimHandle({
  side,
  onDrag,
  zoom,
}: {
  side: 'left' | 'right';
  onDrag: (delta_s: number) => void;
  zoom: number;
}) {
  return (
    <div
      onMouseDown={(e) => {
        e.stopPropagation();
        const startX = e.clientX;
        const handleMove = (me: MouseEvent) => {
          onDrag((me.clientX - startX) / zoom);
        };
        const handleUp = () => {
          window.removeEventListener('mousemove', handleMove);
          window.removeEventListener('mouseup', handleUp);
        };
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
      }}
      className={`w-1.5 h-full bg-accent/60 hover:bg-accent cursor-ew-resize ${
        side === 'left' ? 'rounded-l' : 'rounded-r'
      }`}
    />
  );
}

// ─── Inspector ─────────────────────────────────────────────────────

function ClipInspector({
  clip,
  onTrim,
  onDelete,
}: {
  clip: EditTimelineClip;
  onTrim: (in_s?: number, out_s?: number) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="text-txt-muted uppercase text-[10px] tracking-wider">Scene</div>
        <div>{clip.scene_number ? `#${clip.scene_number}` : clip.id}</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">In (s)</span>
          <input
            type="number"
            step={0.1}
            value={clip.in_s}
            onChange={(e) => onTrim(parseFloat(e.target.value) || 0, undefined)}
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">Out (s)</span>
          <input
            type="number"
            step={0.1}
            value={clip.out_s}
            onChange={(e) => onTrim(undefined, parseFloat(e.target.value) || clip.in_s + 0.1)}
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
          />
        </label>
      </div>
      <div className="text-txt-muted">
        Duration: <strong className="text-txt-primary">{(clip.out_s - clip.in_s).toFixed(2)}s</strong>
      </div>
      <Button variant="ghost" size="sm" className="text-error" onClick={onDelete}>
        <Trash2 className="w-3.5 h-3.5 mr-1" />
        Delete clip
      </Button>
    </div>
  );
}

// ─── Overlay inspector ────────────────────────────────────────────

function OverlayInspector({
  clip,
  onUpdate,
  onDelete,
}: {
  clip: EditTimelineClip;
  onUpdate: (patch: Partial<EditTimelineClip>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-txt-muted uppercase text-[10px] tracking-wider">Overlay</div>
          <div className="capitalize">{clip.kind}</div>
        </div>
        <Button variant="ghost" size="sm" className="text-error" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {clip.kind === 'text' && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-txt-muted uppercase text-[10px] tracking-wider">Text</span>
            <input
              value={clip.text ?? ''}
              onChange={(e) => onUpdate({ text: e.target.value })}
              className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-txt-muted uppercase text-[10px] tracking-wider">Size</span>
              <input
                type="number"
                value={clip.font_size ?? 56}
                onChange={(e) => onUpdate({ font_size: parseInt(e.target.value, 10) || 56 })}
                className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-txt-muted uppercase text-[10px] tracking-wider">Color</span>
              <input
                type="color"
                value={clip.color ?? '#ffffff'}
                onChange={(e) => onUpdate({ color: e.target.value })}
                className="px-1 py-0.5 bg-bg-base border border-white/[0.08] rounded text-sm h-8"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!clip.box}
              onChange={(e) => onUpdate({ box: e.target.checked })}
            />
            Background box
          </label>
        </>
      )}

      {clip.kind === 'shape' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-txt-muted uppercase text-[10px] tracking-wider">Color</span>
            <input
              type="color"
              value={clip.color ?? '#ffffff'}
              onChange={(e) => onUpdate({ color: e.target.value })}
              className="px-1 py-0.5 bg-bg-base border border-white/[0.08] rounded h-8"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-txt-muted uppercase text-[10px] tracking-wider">W × H</span>
            <div className="flex gap-1">
              <input
                type="number"
                value={clip.w ?? 200}
                onChange={(e) => onUpdate({ w: parseInt(e.target.value, 10) || 200 })}
                className="flex-1 px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
              />
              <input
                type="number"
                value={clip.h ?? 60}
                onChange={(e) => onUpdate({ h: parseInt(e.target.value, 10) || 60 })}
                className="flex-1 px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
              />
            </div>
          </label>
        </div>
      )}

      {clip.kind === 'image' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">Asset path</span>
          <input
            value={clip.asset_path ?? ''}
            onChange={(e) => onUpdate({ asset_path: e.target.value })}
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
          />
        </label>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">X</span>
          <input
            value={String(clip.x ?? '')}
            onChange={(e) => onUpdate({ x: e.target.value })}
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm font-mono"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">Y</span>
          <input
            value={String(clip.y ?? '')}
            onChange={(e) => onUpdate({ y: e.target.value })}
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm font-mono"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">Start (s)</span>
          <input
            type="number"
            step={0.1}
            value={clip.start_s}
            onChange={(e) =>
              onUpdate({ start_s: parseFloat(e.target.value) || 0 })
            }
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-txt-muted uppercase text-[10px] tracking-wider">End (s)</span>
          <input
            type="number"
            step={0.1}
            value={clip.end_s}
            onChange={(e) =>
              onUpdate({ end_s: parseFloat(e.target.value) || clip.start_s + 0.1 })
            }
            className="px-2 py-1 bg-bg-base border border-white/[0.08] rounded text-sm"
          />
        </label>
      </div>

      <div className="text-[10px] text-txt-muted">
        X / Y accept FFmpeg expressions like <code>(w-text_w)/2</code>, <code>h-200</code>, etc.
      </div>
    </div>
  );
}
