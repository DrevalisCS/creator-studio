import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
import { AssetPicker } from '@/components/assets/AssetPicker';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { assets as assetsApi } from '@/lib/api';
import {
  editor as editorApi,
  formatError,
  type EditSession,
  type EditTimeline,
  type EditTimelineClip,
  type EditTimelineTrack,
  type CaptionWord,
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
  | {
      type: 'envelope';
      trackId: string;
      clipId: string;
      envelope: Array<[number, number]>;
    }
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
    case 'envelope': {
      const tracks = timeline.tracks.map((t) =>
        t.id === action.trackId
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === action.clipId ? { ...c, envelope: action.envelope } : c,
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
    // 200-step undo history. The previous cap (50) was enough for
    // small edits but lost context on real sessions.
    past: [...state.past.slice(-199), state.present],
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
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  // Snap grid: 0.1s when zoomed in, 0.25s mid, 1s when zoomed out.
  const [zoom, setZoom] = useState(60); // px per second
  const snapStep = zoom >= 100 ? 0.1 : zoom >= 50 ? 0.25 : 1.0;
  const snap = useCallback(
    (t: number) => (snapEnabled ? Math.round(t / snapStep) * snapStep : t),
    [snapEnabled, snapStep],
  );
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'clip' | 'captions'>('clip');
  const [previewingProxy, setPreviewingProxy] = useState(false);
  const [proxyReadyTs, setProxyReadyTs] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedAgo, setSavedAgo] = useState<string>('');
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
        setSavedAt(Date.now());
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

  // Relative "saved Xs ago" label, refreshed every 5s.
  useEffect(() => {
    if (!savedAt) return;
    const update = () => {
      const secs = Math.max(0, Math.round((Date.now() - savedAt) / 1000));
      if (secs < 5) setSavedAgo('just now');
      else if (secs < 60) setSavedAgo(`${secs}s ago`);
      else setSavedAgo(`${Math.round(secs / 60)}m ago`);
    };
    update();
    const t = setInterval(update, 5000);
    return () => clearInterval(t);
  }, [savedAt]);

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
      // Arrow nudge — 0.1s, or 1s with shift.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.1;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        setPlayhead((p) => Math.max(0, Math.min(history.present.duration_s, p + dir * step)));
      }
      // Home / End jump to start / end.
      if (e.key === 'Home') {
        e.preventDefault();
        setPlayhead(0);
      }
      if (e.key === 'End') {
        e.preventDefault();
        setPlayhead(history.present.duration_s);
      }
      // Shortcut overlay toggle (and close with Escape).
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
      if (e.key === 'Escape') {
        setShortcutsOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [playhead, selectedClipId, history.present.duration_s]);

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
        <div
          className={[
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium',
            saving
              ? 'bg-warning/10 text-warning border border-warning/30'
              : savedAt
              ? 'bg-success/10 text-success border border-success/30'
              : 'bg-bg-elevated text-txt-muted border border-white/[0.06]',
          ].join(' ')}
          title="Autosave status"
        >
          <span
            className={[
              'w-1.5 h-1.5 rounded-full',
              saving ? 'bg-warning animate-pulse' : savedAt ? 'bg-success' : 'bg-txt-muted',
            ].join(' ')}
          />
          {saving ? 'Saving…' : savedAt ? `Saved ${savedAgo}` : 'Ready'}
        </div>
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
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (!episodeId) return;
            setPreviewingProxy(true);
            try {
              await editorApi.preview(episodeId);
              // Bump the cache key so the video element reloads the proxy.
              setTimeout(() => setProxyReadyTs(Date.now()), 30_000);
              toast.success('Preview render enqueued', {
                description: 'Proxy will swap in once FFmpeg finishes (~30s).',
              });
            } catch (err) {
              toast.error('Preview failed', { description: formatError(err) });
            } finally {
              setPreviewingProxy(false);
            }
          }}
          disabled={previewingProxy}
          title="Render a fast 480p proxy with overlays + envelope mixed in"
        >
          {previewingProxy ? 'Preview…' : 'Preview'}
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
            proxyUrl={
              proxyReadyTs
                ? `/storage/episodes/${episodeId}/output/proxy.mp4?v=${proxyReadyTs}`
                : null
            }
            finalVideoUrl={
              // v0.20.20 — fall back to the already-assembled final
              // video so the preview shows SOMETHING by default.
              // Previously the player tried to play scene PNGs in a
              // <video> element and silently showed nothing.
              session?.final_video_path
                ? `/storage/${session.final_video_path}`
                : null
            }
          />
        </Card>

        <Card className="col-span-4 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <button
              className={[
                'text-[11px] uppercase tracking-wider px-2 py-1 rounded',
                inspectorTab === 'clip' ? 'bg-accent/20 text-accent' : 'text-txt-muted',
              ].join(' ')}
              onClick={() => setInspectorTab('clip')}
            >
              Inspector
            </button>
            <button
              className={[
                'text-[11px] uppercase tracking-wider px-2 py-1 rounded',
                inspectorTab === 'captions' ? 'bg-accent/20 text-accent' : 'text-txt-muted',
              ].join(' ')}
              onClick={() => setInspectorTab('captions')}
            >
              Captions
            </button>
          </div>
          {inspectorTab === 'captions' ? (
            <CaptionsInspector episodeId={episodeId} playhead={playhead} />
          ) : selectedClip ? (
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
          onClick={() => setAssetPickerOpen(true)}
          title="Add image overlay — pick from asset library"
        >
          <ImageIcon className="w-4 h-4" />
        </Button>
        <Button
          variant={snapEnabled ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setSnapEnabled((v) => !v)}
          title={`Snap-to-grid (${snapStep}s). Click to toggle.`}
          className="text-[11px] uppercase tracking-wider"
        >
          Snap {snapStep}s
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.max(20, z - 20))}>
          <ZoomOut className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.min(240, z + 20))}>
          <ZoomIn className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShortcutsOpen((v) => !v)}
          title="Keyboard shortcuts (?)"
          className="text-[11px]"
        >
          ?
        </Button>
      </div>

      {/* Timeline — ruler + tracks */}
      <Card className="p-3 overflow-x-auto">
        <div style={{ minWidth: Math.max(timeline.duration_s * zoom + 80, 600) }}>
          <TimelineRuler
            duration={timeline.duration_s}
            zoom={zoom}
            playhead={playhead}
            onScrub={(t) => setPlayhead(snap(t))}
          />
          <div className="space-y-2 mt-1">
            {timeline.tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                zoom={zoom}
                duration={timeline.duration_s}
                playhead={playhead}
                onScrub={(t) => setPlayhead(snap(t))}
                selectedClipId={selectedClipId}
                onSelectClip={setSelectedClipId}
                onReorder={(from, to) =>
                  dispatch({ type: 'reorder', trackId: track.id, fromIndex: from, toIndex: to })
                }
                onTrim={(id, in_s, out_s) =>
                  dispatch({
                    type: 'trim',
                    clipId: id,
                    in_s: in_s === undefined ? undefined : snap(in_s),
                    out_s: out_s === undefined ? undefined : snap(out_s),
                  })
                }
                onEnvelope={(clipId, envelope) =>
                  dispatch({ type: 'envelope', trackId: track.id, clipId, envelope })
                }
                waveformUrl={waveformUrlFor(episodeId, track.id)}
              />
            ))}
          </div>
        </div>
      </Card>

      <div className="text-[10px] text-txt-muted flex flex-wrap gap-x-3 gap-y-1">
        <span><kbd className="kbd">Space</kbd> play/pause</span>
        <span><kbd className="kbd">←</kbd><kbd className="kbd">→</kbd> nudge playhead 0.1s</span>
        <span><kbd className="kbd">Shift</kbd>+arrows 1s</span>
        <span><kbd className="kbd">Home</kbd> / <kbd className="kbd">End</kbd> jump to edges</span>
        <span><kbd className="kbd">S</kbd> split at playhead</span>
        <span><kbd className="kbd">⌫</kbd> delete selected clip</span>
        <span><kbd className="kbd">⌘Z</kbd> / <kbd className="kbd">⌘⇧Z</kbd> undo/redo</span>
      </div>

      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShortcutsOpen(false)}
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          <div
            className="bg-bg-elevated border border-border rounded-xl p-6 max-w-md w-[92%] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base">Keyboard shortcuts</h3>
              <button
                onClick={() => setShortcutsOpen(false)}
                className="text-txt-tertiary hover:text-txt-primary text-lg"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <kbd className="kbd">Space</kbd>
              <span>Play / pause</span>
              <kbd className="kbd">←</kbd>
              <span>Nudge playhead -0.1s (Shift = -1s)</span>
              <kbd className="kbd">→</kbd>
              <span>Nudge playhead +0.1s (Shift = +1s)</span>
              <kbd className="kbd">Home</kbd>
              <span>Jump to start</span>
              <kbd className="kbd">End</kbd>
              <span>Jump to end</span>
              <kbd className="kbd">S</kbd>
              <span>Split selected clip at playhead</span>
              <kbd className="kbd">⌫</kbd>
              <span>Delete selected clip</span>
              <kbd className="kbd">⌘/Ctrl + Z</kbd>
              <span>Undo (up to 200 steps)</span>
              <kbd className="kbd">⌘/Ctrl + ⇧ Z</kbd>
              <span>Redo</span>
              <kbd className="kbd">?</kbd>
              <span>Toggle this overlay</span>
              <kbd className="kbd">Esc</kbd>
              <span>Close overlay</span>
            </div>
            <p className="text-[11px] text-txt-tertiary mt-4">
              Snap-to-grid is {snapEnabled ? `on at ${snapStep}s` : 'off'}; toggle with the
              Snap button in the toolbar. Grid step shrinks as you zoom in.
            </p>
          </div>
        </div>
      )}

      <AssetPicker
        open={assetPickerOpen}
        onClose={() => setAssetPickerOpen(false)}
        kind="image"
        multi={false}
        title="Add image overlay"
        onSelect={async (assetIds) => {
          setAssetPickerOpen(false);
          const id = assetIds[0];
          if (!id) return;
          try {
            const asset = await assetsApi.get(id);
            const clipId = `i-${Date.now()}`;
            dispatch({
              type: 'add_overlay',
              clip: {
                id: clipId,
                kind: 'image',
                asset_path: asset.file_path,
                x: '(W-w)/2',
                y: 'H-h-80',
                in_s: 0,
                out_s: 3,
                start_s: playhead,
                end_s: Math.min(playhead + 3, timeline.duration_s),
              },
            });
            setSelectedClipId(clipId);
          } catch (err) {
            toast.error('Failed to attach asset', {
              description: err instanceof Error ? err.message : 'Unknown error',
            });
          }
        }}
      />
    </div>
  );
}

// ─── Timeline ruler ─────────────────────────────────────────────

/**
 * Tick-marked ruler above the tracks. Major ticks every second (long
 * line + time code), minor ticks every 0.1s (short line). Click/drag
 * on the ruler scrubs the playhead.
 */
function TimelineRuler({
  duration,
  zoom,
  playhead,
  onScrub,
}: {
  duration: number;
  zoom: number;
  playhead: number;
  onScrub: (t: number) => void;
}) {
  const majorStep = zoom < 40 ? 5 : zoom < 80 ? 2 : 1; // seconds between labels
  const minorStep = zoom < 80 ? 1 : 0.5;
  const width = Math.max(duration * zoom, 400);
  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, (e.clientX - rect.left) / zoom));
    onScrub(t);
  };
  const ticks: React.ReactNode[] = [];
  for (let t = 0; t <= duration + 0.001; t += minorStep) {
    const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.001;
    ticks.push(
      <div
        key={t.toFixed(2)}
        className={['absolute top-0', isMajor ? 'h-3 bg-txt-secondary' : 'h-1.5 bg-txt-muted'].join(' ')}
        style={{ left: t * zoom, width: 1 }}
      />,
    );
    if (isMajor) {
      const m = Math.floor(t / 60);
      const s = Math.round(t % 60);
      ticks.push(
        <div
          key={`lbl-${t.toFixed(2)}`}
          className="absolute top-3 text-[10px] font-mono text-txt-secondary select-none"
          style={{ left: t * zoom + 3 }}
        >
          {m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`}
        </div>,
      );
    }
  }
  return (
    <div className="flex gap-2">
      <div className="w-24 shrink-0 text-[10px] uppercase tracking-wider text-txt-muted pt-1">
        timeline
      </div>
      <div
        className="relative flex-1 h-7 select-none cursor-col-resize"
        style={{ width }}
        onMouseDown={(e) => {
          handleScrub(e);
          const onMove = (me: MouseEvent) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const t = Math.max(0, Math.min(duration, (me.clientX - rect.left) / zoom));
            onScrub(t);
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      >
        {ticks}
        <div
          className="absolute top-0 bottom-0 w-[1.5px] bg-accent pointer-events-none"
          style={{ left: playhead * zoom }}
        >
          <div className="w-2 h-2 rounded-full bg-accent -translate-x-[3px] -translate-y-[2px]" />
        </div>
      </div>
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
  proxyUrl,
  finalVideoUrl,
}: {
  timeline: EditTimeline;
  playhead: number;
  onPlayheadChange: (t: number) => void;
  playing: boolean;
  onPlayToggle: () => void;
  proxyUrl: string | null;
  finalVideoUrl: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoTrack = timeline.tracks.find((t) => t.kind === 'video');
  const activeClip = videoTrack?.clips.find(
    (c) => playhead >= c.start_s && playhead < c.end_s,
  );
  const localTime = activeClip ? playhead - activeClip.start_s + activeClip.in_s : 0;

  // Preview source priority (v0.20.20):
  // 1. Freshly-rendered 480p proxy — reflects current edits.
  // 2. Already-assembled final video — works immediately on open
  //    without the user having to click Preview.
  // 3. Per-scene slideshow of the raw PNG scenes as a last resort,
  //    using an <img> because scene assets aren't video files.
  const isProxyOrFinal = Boolean(proxyUrl || finalVideoUrl);
  const videoSrc = proxyUrl ?? finalVideoUrl ?? null;
  const sceneImageSrc = activeClip?.asset_path
    ? `/storage/${activeClip.asset_path}`
    : null;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    const targetTime = isProxyOrFinal ? playhead : localTime;
    if (Math.abs(v.currentTime - targetTime) > 0.25) v.currentTime = targetTime;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, playhead, localTime, videoSrc, isProxyOrFinal]);

  // Advance playhead from the video element's currentTime when playing.
  useEffect(() => {
    if (!playing) return;
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      if (isProxyOrFinal) {
        onPlayheadChange(v.currentTime);
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [playing, onPlayheadChange, isProxyOrFinal]);

  return (
    <div className="w-full max-w-md">
      <div className="aspect-[9/16] bg-black rounded-md overflow-hidden relative group">
        {videoSrc ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={videoRef}
            src={videoSrc}
            className="w-full h-full object-contain"
            onClick={onPlayToggle}
            controls
            playsInline
          />
        ) : sceneImageSrc ? (
          // Scene slideshow mode — the pipeline writes scenes as PNGs,
          // not videos, so we render them in an <img>. Clicking toggles
          // the play state, which advances through scenes via playhead.
          <>
            <img
              ref={imageRef}
              src={sceneImageSrc}
              alt={`Scene at ${playhead.toFixed(1)}s`}
              className="w-full h-full object-contain"
              onClick={onPlayToggle}
            />
            <div className="absolute bottom-2 left-2 right-2 text-[11px] text-white/80 bg-black/60 rounded px-2 py-1 leading-tight pointer-events-none">
              Scene slideshow · click <strong>Preview</strong> above to render a
              proxy video, or generate the episode for a real playback track.
            </div>
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-txt-muted text-xs p-4 text-center gap-2">
            <div>No scene at this position.</div>
            <div className="text-[10px] text-txt-tertiary">
              Generate the episode first, or click <strong>Preview</strong>
              above to render a scratch proxy from the current timeline.
            </div>
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
  onEnvelope,
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
  onEnvelope: (clipId: string, envelope: Array<[number, number]>) => void;
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
        {track.kind === 'audio' &&
          track.clips.map((c) => (
            <EnvelopeLayer
              key={`env-${c.id}`}
              clip={c}
              zoom={zoom}
              onChange={(env) => onEnvelope(c.id, env)}
            />
          ))}
      </div>
    </div>
  );
}

function EnvelopeLayer({
  clip,
  zoom,
  onChange,
}: {
  clip: EditTimelineClip;
  zoom: number;
  onChange: (env: Array<[number, number]>) => void;
}) {
  const envelope = clip.envelope && clip.envelope.length > 0 ? clip.envelope : [];

  const height = 48; // matches the h-12 track body
  const dbMin = -40;
  const dbMax = 6;
  const dbToY = (db: number) =>
    ((dbMax - Math.max(dbMin, Math.min(dbMax, db))) / (dbMax - dbMin)) * height;
  const yToDb = (y: number) =>
    Math.round((dbMax - (y / height) * (dbMax - dbMin)) * 10) / 10;

  const widthPx = (clip.end_s - clip.start_s) * zoom;

  const points = envelope.length
    ? envelope
    : // Default envelope: flat line at the clip's gain_db (or 0).
      ([
        [0, clip.gain_db ?? 0],
        [clip.end_s - clip.start_s, clip.gain_db ?? 0],
      ] as Array<[number, number]>);

  const path = points
    .map(([t, db], i) => `${i === 0 ? 'M' : 'L'} ${t * zoom} ${dbToY(db)}`)
    .join(' ');

  const handleBgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const t = Math.max(0, Math.min(clip.end_s - clip.start_s, relX / zoom));
    const db = yToDb(relY);
    const next: Array<[number, number]> = [...points, [t, db] as [number, number]].sort(
      (a, b) => a[0]! - b[0]!,
    );
    onChange(next);
  };

  return (
    <svg
      className="absolute top-0 left-0 h-full pointer-events-auto"
      width={widthPx}
      style={{ left: clip.start_s * zoom }}
      height={height}
      onDoubleClick={handleBgClick}
    >
      <path d={path} fill="none" stroke="rgba(255,208,102,0.8)" strokeWidth={1.5} />
      {points.map(([t, db], i) => {
        const cx = t * zoom;
        const cy = dbToY(db);
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={4}
            fill="#ffd066"
            stroke="#000"
            strokeWidth={0.5}
            onMouseDown={(e) => {
              e.stopPropagation();
              const svg = (e.target as SVGElement).ownerSVGElement;
              if (!svg) return;
              const rect = svg.getBoundingClientRect();
              const onMove = (me: MouseEvent) => {
                const relX = me.clientX - rect.left;
                const relY = me.clientY - rect.top;
                const newT = Math.max(
                  0,
                  Math.min(clip.end_s - clip.start_s, relX / zoom),
                );
                const newDb = yToDb(relY);
                const next = points.map((p, idx): [number, number] =>
                  idx === i ? [newT, newDb] : p,
                );
                next.sort((a, b) => a[0] - b[0]);
                onChange(next);
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (points.length <= 2) return; // always keep the flat baseline
              const next = points.filter((_, idx) => idx !== i);
              onChange(next);
            }}
            style={{ cursor: 'grab' }}
          />
        );
      })}
    </svg>
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

// ─── Captions inspector ───────────────────────────────────────────

function CaptionsInspector({
  episodeId,
  playhead,
}: {
  episodeId: string;
  playhead: number;
}) {
  const [words, setWords] = useState<CaptionWord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveDeb = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void editorApi
      .getCaptions(episodeId)
      .then((r) => {
        if (alive) setWords(r.words || []);
      })
      .catch(() => {
        if (alive) setWords([]);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [episodeId]);

  const save = useCallback(
    (next: CaptionWord[]) => {
      setWords(next);
      if (saveDeb.current) clearTimeout(saveDeb.current);
      saveDeb.current = setTimeout(async () => {
        setSaving(true);
        try {
          await editorApi.putCaptions(episodeId, next);
        } catch {
          /* autosave best-effort */
        } finally {
          setSaving(false);
        }
      }, 700);
    },
    [episodeId],
  );

  if (loading) {
    return <div className="text-xs text-txt-muted py-6 text-center">Loading caption words…</div>;
  }
  if (!words || words.length === 0) {
    return (
      <div className="text-xs text-txt-muted py-4">
        No word-level captions stored. Run the captions step on the episode first, then come back.
      </div>
    );
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-txt-muted">{words.length} words</span>
        <span className="text-[10px] text-txt-muted">{saving ? 'Saving…' : 'Saved'}</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto space-y-1 pr-1">
        {words.map((w, i) => {
          const active = playhead >= w.start_seconds && playhead < w.end_seconds;
          return (
            <div
              key={i}
              className={[
                'flex items-center gap-1 p-1.5 rounded border',
                active ? 'border-accent bg-accent/10' : 'border-white/[0.04]',
              ].join(' ')}
            >
              <input
                value={w.word}
                onChange={(e) => {
                  const next = [...words];
                  next[i] = { ...w, word: e.target.value };
                  save(next);
                }}
                className="flex-1 px-1.5 py-0.5 bg-bg-base border border-white/[0.08] rounded text-xs"
              />
              <input
                type="number"
                step={0.01}
                value={w.start_seconds}
                onChange={(e) => {
                  const next = [...words];
                  next[i] = { ...w, start_seconds: parseFloat(e.target.value) || 0 };
                  save(next);
                }}
                className="w-14 px-1 py-0.5 bg-bg-base border border-white/[0.08] rounded text-[10px] font-mono"
                title="Start (s)"
              />
              <input
                type="number"
                step={0.01}
                value={w.end_seconds}
                onChange={(e) => {
                  const next = [...words];
                  next[i] = { ...w, end_seconds: parseFloat(e.target.value) || w.start_seconds + 0.1 };
                  save(next);
                }}
                className="w-14 px-1 py-0.5 bg-bg-base border border-white/[0.08] rounded text-[10px] font-mono"
                title="End (s)"
              />
              <button
                onClick={() => {
                  const next = [...words];
                  next[i] = { ...w, emphasis: !w.emphasis };
                  save(next);
                }}
                className={[
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold',
                  w.emphasis ? 'bg-accent text-bg-base' : 'bg-bg-elevated text-txt-muted',
                ].join(' ')}
                title="Emphasis"
              >
                !
              </button>
              <input
                type="color"
                value={w.color ?? '#ffffff'}
                onChange={(e) => {
                  const next = [...words];
                  next[i] = { ...w, color: e.target.value };
                  save(next);
                }}
                className="w-6 h-6 rounded cursor-pointer"
                title="Word color"
              />
              <button
                onClick={() => {
                  const next = words.filter((_, idx) => idx !== i);
                  save(next);
                }}
                className="text-error hover:bg-error/10 rounded px-1.5 py-0.5 text-[10px]"
                title="Delete word"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
