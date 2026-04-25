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
  Scissors,
  Sticker,
  Slash,
  Circle,
  Keyboard,
  Upload,
  Search,
  MoveHorizontal,
} from 'lucide-react';
import { AssetPicker } from '@/components/assets/AssetPicker';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { assets as assetsApi } from '@/lib/api';
import {
  STAMP_CATALOG,
  STAMP_CATEGORY_LABELS,
  findStampById,
  type StampCategory,
  type StampEntry,
} from '@/stamps/catalog';
import {
  editor as editorApi,
  formatError,
  type EditSession,
  type EditTimeline,
  type EditTimelineClip,
  type EditTimelineTrack,
  type CaptionWord,
  type Asset,
} from '@/lib/api';

// MIME-ish key used to move an asset id from the right-rail asset
// browser into the timeline via drag-and-drop.
const ASSET_DRAG_MIME = 'application/x-drevalis-asset';
// Drag MIME for stamps (bundled SVG presets from /stamps/). Stamps
// drop as image overlays just like assets, but resolve to a static
// URL instead of /api/v1/assets/{id}/file.
const STAMP_DRAG_MIME = 'application/x-drevalis-stamp';

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
  // Drives the right-panel external tab selection. When the
  // ToolsRail "Stamps" or "Image" buttons fire, we bump this so
  // the panel snaps to the matching tab.
  const [rightPanelTab, setRightPanelTab] = useState<
    'clip' | 'captions' | 'assets' | 'stamps' | undefined
  >(undefined);

  // Preview / timeline split (v0.21.1) — percentage of the center
  // column allocated to the preview. Persisted in localStorage so
  // returning users don't have to re-resize. Default 58% gives
  // enough timeline to see four tracks without scrolling on a 1080p
  // display while leaving the preview comfortably large.
  const [previewPct, setPreviewPct] = useState<number>(() => {
    if (typeof window === 'undefined') return 58;
    const stored = window.localStorage.getItem('drevalis.editor.previewPct');
    const parsed = stored ? parseFloat(stored) : NaN;
    return Number.isFinite(parsed) && parsed >= 25 && parsed <= 80
      ? parsed
      : 58;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'drevalis.editor.previewPct',
        String(previewPct),
      );
    } catch {
      /* ignore */
    }
  }, [previewPct]);
  // Drag-state for the splitter between preview and timeline.
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const draggingSplit = useRef(false);

  // Aspect ratio of the playable source (read from the <video>
  // element's natural dimensions when available). Defaults to 9:16
  // for shorts which is the most common case.
  const [previewAspect, setPreviewAspect] = useState<string>('9 / 16');
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

  // Helpers that the tools rail + timeline drops both call so a
  // click and a drag produce identical overlays.
  const addTextOverlay = useCallback(
    (preset: 'title' | 'subtitle' | 'caption' | 'lowerThird') => {
      const style = {
        title: { text: 'Title', font_size: 80, y: 'h/2-h/8' },
        subtitle: { text: 'Subtitle', font_size: 56, y: 'h/2' },
        caption: { text: 'Caption text', font_size: 40, y: 'h-200' },
        lowerThird: { text: 'Lower third', font_size: 48, y: 'h-120' },
      }[preset];
      const id = `t-${Date.now()}`;
      dispatch({
        type: 'add_overlay',
        clip: {
          id,
          kind: 'text',
          text: style.text,
          font_size: style.font_size,
          color: '#ffffff',
          box: preset === 'caption' || preset === 'lowerThird',
          box_color: '#000000',
          x: '(w-text_w)/2',
          y: style.y,
          in_s: 0,
          out_s: Math.min(3, history.present.duration_s),
          start_s: playhead,
          end_s: Math.min(playhead + 3, history.present.duration_s),
        },
      });
      setSelectedClipId(id);
    },
    [dispatch, history.present.duration_s, playhead],
  );

  const addShapeOverlay = useCallback(
    (shape: 'rect' | 'circle' | 'line') => {
      // The serialized timeline only knows ``rect`` / ``circle``, so a
      // user-facing "line" choice is just a thin horizontal rect.
      const isLine = shape === 'line';
      const id = `s-${Date.now()}`;
      dispatch({
        type: 'add_overlay',
        clip: {
          id,
          kind: 'shape',
          shape: isLine ? 'rect' : shape,
          color: '#ffffff',
          w: isLine ? 800 : shape === 'circle' ? 200 : 400,
          h: isLine ? 4 : shape === 'circle' ? 200 : 200,
          x: '(w-w)/2',
          y: isLine ? 'h-320' : 'h/2-h/4',
          in_s: 0,
          out_s: 3,
          start_s: playhead,
          end_s: Math.min(playhead + 3, history.present.duration_s),
        },
      });
      setSelectedClipId(id);
    },
    [dispatch, history.present.duration_s, playhead],
  );

  const addImageOverlayFromAsset = useCallback(
    async (assetId: string, startSecs?: number) => {
      try {
        const asset = await assetsApi.get(assetId);
        const start = startSecs !== undefined ? startSecs : playhead;
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
            start_s: snap(start),
            end_s: Math.min(snap(start) + 3, history.present.duration_s),
          },
        });
        setSelectedClipId(clipId);
      } catch (err) {
        toast.error('Failed to attach asset', {
          description: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    },
    [dispatch, history.present.duration_s, playhead, snap, toast],
  );

  // Drop a bundled stamp onto the timeline. Resolves the catalog entry
  // and adds an image overlay using the stamp's static URL — no
  // upload pipeline involved, so this is fast and reliable even on
  // air-gapped installs.
  const addStampOverlay = useCallback(
    (stampId: string, startSecs?: number) => {
      const stamp = findStampById(stampId);
      if (!stamp) {
        toast.error('Unknown stamp', { description: stampId });
        return;
      }
      const start = startSecs !== undefined ? startSecs : playhead;
      const dur = stamp.defaultDurationSeconds ?? 3;
      const clipId = `stamp-${Date.now()}`;
      dispatch({
        type: 'add_overlay',
        clip: {
          id: clipId,
          kind: 'image',
          // Pass the bundled URL through unchanged. The FFmpeg
          // overlay renderer can fetch http(s) URLs as well as
          // local paths, so this works in both dev and prod.
          asset_path: stamp.url,
          x: stamp.category === 'transitions' ? '0' : '(W-w)/2',
          y: stamp.category === 'lower-thirds'
            ? 'H-h-80'
            : stamp.category === 'transitions'
              ? '0'
              : '(H-h)/2',
          in_s: 0,
          out_s: dur,
          start_s: snap(start),
          end_s: Math.min(snap(start) + dur, history.present.duration_s),
        },
      });
      setSelectedClipId(clipId);
    },
    [dispatch, history.present.duration_s, playhead, snap, toast],
  );

  if (loading || !episodeId) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ═══════════════════════════════════════════════════════════
          Top bar — compact, icon-heavy, full width
          ═══════════════════════════════════════════════════════════ */}
      <header className="h-12 border-b border-border flex items-center gap-2 px-3 shrink-0 bg-bg-surface">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/episodes/${episodeId}`)}
          title="Back to episode"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="h-6 w-px bg-border" />
        <h1 className="text-sm font-semibold">Video Editor</h1>
        <div className="flex-1" />

        {/* Autosave */}
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
              saving
                ? 'bg-warning animate-pulse'
                : savedAt
                  ? 'bg-success'
                  : 'bg-txt-muted',
            ].join(' ')}
          />
          {saving ? 'Saving…' : savedAt ? `Saved ${savedAgo}` : 'Ready'}
        </div>

        <div className="h-6 w-px bg-border mx-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: 'undo' })}
          disabled={!history.past.length}
          title="Undo (⌘Z)"
        >
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: 'redo' })}
          disabled={!history.future.length}
          title="Redo (⌘⇧Z)"
        >
          <Redo2 className="w-4 h-4" />
        </Button>
        <div className="h-6 w-px bg-border mx-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (!episodeId) return;
            setPreviewingProxy(true);
            try {
              await editorApi.preview(episodeId);
              setTimeout(() => setProxyReadyTs(Date.now()), 30_000);
              toast.success('Preview render enqueued', {
                description:
                  'Proxy will swap in once FFmpeg finishes (~30s).',
              });
            } catch (err) {
              toast.error('Preview failed', {
                description: formatError(err),
              });
            } finally {
              setPreviewingProxy(false);
            }
          }}
          disabled={previewingProxy}
          title="Render a fast 480p proxy with overlays + envelope mixed in"
        >
          {previewingProxy ? 'Preview…' : 'Preview'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void onRender()}
          disabled={rendering}
        >
          <Rocket className="w-4 h-4 mr-1" />
          {rendering ? 'Rendering…' : 'Render'}
        </Button>
      </header>

      {/* ═══════════════════════════════════════════════════════════
          Body — 3-column: ToolsRail | main | RightPanel
          ═══════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex min-h-0">
        {/* Tools rail */}
        <ToolsRail
          onAddText={addTextOverlay}
          onAddShape={addShapeOverlay}
          onOpenAssetPicker={() => setAssetPickerOpen(true)}
          onOpenAssetsTab={() => setRightPanelTab('assets')}
          onOpenStampsTab={() => setRightPanelTab('stamps')}
          onSplit={() => {
            if (selectedClipId) {
              dispatch({
                type: 'split',
                clipId: selectedClipId,
                at_s: playhead,
              });
            }
          }}
          onDelete={() => {
            if (selectedClipId) {
              dispatch({ type: 'delete', clipId: selectedClipId });
              setSelectedClipId(null);
            }
          }}
          snapEnabled={snapEnabled}
          snapStep={snapStep}
          onToggleSnap={() => setSnapEnabled((v) => !v)}
          onZoomIn={() => setZoom((z) => Math.min(240, z + 20))}
          onZoomOut={() => setZoom((z) => Math.max(20, z - 20))}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          hasSelection={!!selectedClipId}
        />

        {/* Center column: preview on top, draggable splitter, timeline
            below. The split is user-resizable and stored in local
            storage so the next visit remembers it. The preview
            container uses ``aspectRatio`` + ``maxHeight: 100%`` so
            the video scales to fit without pushing into the
            timeline, regardless of viewport height. */}
        <div
          ref={splitContainerRef}
          className="flex-1 flex flex-col min-w-0 border-r border-border"
          onMouseMove={(e) => {
            if (!draggingSplit.current || !splitContainerRef.current) return;
            const rect = splitContainerRef.current.getBoundingClientRect();
            const local = e.clientY - rect.top;
            const pct = (local / rect.height) * 100;
            // Clamp 25–80% so neither half collapses entirely.
            setPreviewPct(Math.min(80, Math.max(25, pct)));
          }}
          onMouseUp={() => {
            if (draggingSplit.current) {
              draggingSplit.current = false;
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            }
          }}
          onMouseLeave={() => {
            if (draggingSplit.current) {
              draggingSplit.current = false;
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            }
          }}
        >
          {/* Preview — height driven by the user-resizable split. The
              inner box uses CSS aspect-ratio + max constraints so the
              video always fits the available space (no overflow into
              the timeline). */}
          <div
            className="min-h-0 flex items-center justify-center bg-black/40 p-3 relative"
            style={{ height: `${previewPct}%` }}
          >
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
                session?.final_video_path
                  ? `/storage/${session.final_video_path}`
                  : null
              }
              aspectRatio={previewAspect}
              onAspectDetected={setPreviewAspect}
            />
            {/* Reset-split button — quick way back to the default if
                the user has dragged into a corner. Sits in the
                bottom-right of the preview area. */}
            <button
              type="button"
              onClick={() => setPreviewPct(58)}
              className="absolute bottom-2 right-2 rounded bg-bg-elevated/80 border border-border px-2 py-0.5 text-[10px] text-txt-tertiary hover:text-txt-primary hover:border-accent/40 transition-colors duration-fast backdrop-blur-sm"
              title="Reset preview / timeline split"
            >
              Fit
            </button>
          </div>

          {/* Splitter handle — drag to resize. Visual indicator on
              hover; cursor swaps to row-resize. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize preview and timeline"
            tabIndex={0}
            onMouseDown={(e) => {
              draggingSplit.current = true;
              document.body.style.cursor = 'row-resize';
              document.body.style.userSelect = 'none';
              e.preventDefault();
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPreviewPct((p) => Math.max(25, p - 2));
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPreviewPct((p) => Math.min(80, p + 2));
              }
            }}
            className="h-1.5 bg-border hover:bg-accent/40 active:bg-accent transition-colors duration-fast cursor-row-resize relative shrink-0 group focus:outline-none focus:bg-accent/40"
          >
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-0.5 bg-txt-muted/50 group-hover:bg-accent rounded-full pointer-events-none" />
          </div>

          {/* Timeline strip — fills the remaining column space below
              the splitter. min-h prevents collapse to zero when the
              user drags the split handle hard. */}
          <div
            className="flex-1 min-h-[180px] border-t border-border bg-bg-surface flex flex-col"
          >
            {/* Mini controls bar above the tracks */}
            <div className="h-9 px-3 flex items-center gap-2 shrink-0 border-b border-border">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPlaying((p) => !p)}
                title="Play / Pause (Space)"
              >
                {playing ? (
                  <Pause className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </Button>
              <div className="text-xs font-mono text-txt-muted w-32 tabular-nums">
                {playhead.toFixed(2)}s / {timeline.duration_s.toFixed(2)}s
              </div>
              <div className="flex-1" />
              <div className="text-[10px] text-txt-muted hidden md:flex items-center gap-1">
                <MoveHorizontal size={10} />
                Drag assets into the timeline to add overlays
              </div>
            </div>

            {/* Tracks — horizontally scrollable, vertically snug */}
            <div
              className="flex-1 overflow-auto"
              onDragOver={(e) => {
                if (
                  e.dataTransfer.types.includes(ASSET_DRAG_MIME) ||
                  e.dataTransfer.types.includes(STAMP_DRAG_MIME)
                ) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }
              }}
              onDrop={(e) => {
                const assetId = e.dataTransfer.getData(ASSET_DRAG_MIME);
                const stampId = e.dataTransfer.getData(STAMP_DRAG_MIME);
                if (!assetId && !stampId) return;
                e.preventDefault();
                // Map the drop x-position (relative to the scrollable
                // container's left edge plus its horizontal scroll
                // offset) into timeline seconds.
                const target = e.currentTarget as HTMLDivElement;
                const rect = target.getBoundingClientRect();
                const localX = e.clientX - rect.left + target.scrollLeft;
                // The track container reserves ~80px on the left for
                // labels before the zoomed timeline area begins.
                const xInTimeline = Math.max(0, localX - 80);
                const dropSecs = xInTimeline / zoom;
                if (stampId) {
                  addStampOverlay(stampId, dropSecs);
                } else if (assetId) {
                  void addImageOverlayFromAsset(assetId, dropSecs);
                }
              }}
            >
              <div
                style={{
                  minWidth: Math.max(timeline.duration_s * zoom + 80, 600),
                }}
                className="p-3"
              >
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
                        dispatch({
                          type: 'reorder',
                          trackId: track.id,
                          fromIndex: from,
                          toIndex: to,
                        })
                      }
                      onTrim={(id, in_s, out_s) =>
                        dispatch({
                          type: 'trim',
                          clipId: id,
                          in_s: in_s === undefined ? undefined : snap(in_s),
                          out_s:
                            out_s === undefined ? undefined : snap(out_s),
                        })
                      }
                      onEnvelope={(clipId, envelope) =>
                        dispatch({
                          type: 'envelope',
                          trackId: track.id,
                          clipId,
                          envelope,
                        })
                      }
                      waveformUrl={waveformUrlFor(episodeId, track.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right panel: Inspector / Captions / Assets */}
        <RightPanel
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          episodeId={episodeId}
          playhead={playhead}
          selectedClip={selectedClip}
          onUpdateOverlay={(patch) => {
            if (!selectedClip) return;
            dispatch({
              type: 'update_overlay',
              clipId: selectedClip.id,
              patch,
            });
          }}
          onDeleteClip={() => {
            if (!selectedClip) return;
            dispatch({ type: 'delete', clipId: selectedClip.id });
            setSelectedClipId(null);
          }}
          onTrimClip={(in_s, out_s) => {
            if (!selectedClip) return;
            dispatch({
              type: 'trim',
              clipId: selectedClip.id,
              in_s,
              out_s,
            });
          }}
          onPickAsset={(id) => void addImageOverlayFromAsset(id)}
          onPickStamp={(id) => addStampOverlay(id)}
          initialTab={rightPanelTab}
        />
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

// ─── Left tools rail ────────────────────────────────────────────

interface ToolsRailProps {
  onAddText: (preset: 'title' | 'subtitle' | 'caption' | 'lowerThird') => void;
  onAddShape: (shape: 'rect' | 'circle' | 'line') => void;
  onOpenAssetPicker: () => void;
  onOpenAssetsTab: () => void;
  onOpenStampsTab: () => void;
  onSplit: () => void;
  onDelete: () => void;
  snapEnabled: boolean;
  snapStep: number;
  onToggleSnap: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onOpenShortcuts: () => void;
  hasSelection: boolean;
}

function ToolsRail({
  onAddText,
  onAddShape,
  onOpenAssetPicker,
  onOpenAssetsTab,
  onOpenStampsTab,
  onSplit,
  onDelete,
  snapEnabled,
  snapStep,
  onToggleSnap,
  onZoomIn,
  onZoomOut,
  onOpenShortcuts,
  hasSelection,
}: ToolsRailProps) {
  const [activeFlyout, setActiveFlyout] = useState<'text' | 'shape' | null>(
    null,
  );

  // Close flyout on outside click.
  useEffect(() => {
    if (!activeFlyout) return;
    const handler = () => setActiveFlyout(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [activeFlyout]);

  return (
    <div className="w-14 shrink-0 border-r border-border bg-bg-surface flex flex-col py-2 gap-1">
      <ToolButton
        icon={Type}
        label="Text"
        active={activeFlyout === 'text'}
        onClick={(e) => {
          e.stopPropagation();
          setActiveFlyout((prev) => (prev === 'text' ? null : 'text'));
        }}
        flyout={
          activeFlyout === 'text' ? (
            <Flyout>
              <FlyoutItem
                label="Title"
                description="Large centered title"
                onClick={() => {
                  onAddText('title');
                  setActiveFlyout(null);
                }}
              />
              <FlyoutItem
                label="Subtitle"
                description="Medium centered text"
                onClick={() => {
                  onAddText('subtitle');
                  setActiveFlyout(null);
                }}
              />
              <FlyoutItem
                label="Caption"
                description="Text with background box"
                onClick={() => {
                  onAddText('caption');
                  setActiveFlyout(null);
                }}
              />
              <FlyoutItem
                label="Lower third"
                description="Caption style anchored to bottom"
                onClick={() => {
                  onAddText('lowerThird');
                  setActiveFlyout(null);
                }}
              />
            </Flyout>
          ) : null
        }
      />
      <ToolButton
        icon={Square}
        label="Shape"
        active={activeFlyout === 'shape'}
        onClick={(e) => {
          e.stopPropagation();
          setActiveFlyout((prev) => (prev === 'shape' ? null : 'shape'));
        }}
        flyout={
          activeFlyout === 'shape' ? (
            <Flyout>
              <FlyoutItem
                icon={Square}
                label="Rectangle"
                onClick={() => {
                  onAddShape('rect');
                  setActiveFlyout(null);
                }}
              />
              <FlyoutItem
                icon={Circle}
                label="Circle"
                onClick={() => {
                  onAddShape('circle');
                  setActiveFlyout(null);
                }}
              />
              <FlyoutItem
                icon={Slash}
                label="Line"
                onClick={() => {
                  onAddShape('line');
                  setActiveFlyout(null);
                }}
              />
            </Flyout>
          ) : null
        }
      />
      <ToolButton
        icon={ImageIcon}
        label="Image (assets)"
        onClick={onOpenAssetsTab}
      />
      <ToolButton
        icon={Sticker}
        label="Stamps & effects"
        onClick={onOpenStampsTab}
      />
      <div className="mx-2 my-1 h-px bg-border" />
      <ToolButton
        icon={Scissors}
        label="Split"
        onClick={onSplit}
        disabled={!hasSelection}
      />
      <ToolButton
        icon={Trash2}
        label="Delete"
        onClick={onDelete}
        disabled={!hasSelection}
        danger
      />
      <div className="flex-1" />
      <ToolButton
        icon={ZoomIn}
        label="Zoom in"
        onClick={onZoomIn}
      />
      <ToolButton
        icon={ZoomOut}
        label="Zoom out"
        onClick={onZoomOut}
      />
      <button
        type="button"
        onClick={onToggleSnap}
        title={`Snap ${snapStep}s ${snapEnabled ? 'on' : 'off'}`}
        className={[
          'mx-2 rounded-md text-[9px] font-semibold uppercase tracking-wider py-1',
          snapEnabled
            ? 'bg-accent/15 text-accent border border-accent/30'
            : 'bg-bg-elevated text-txt-tertiary border border-border hover:text-txt-primary',
        ].join(' ')}
      >
        {snapStep}s
      </button>
      <ToolButton
        icon={Keyboard}
        label="Shortcuts (?)"
        onClick={onOpenShortcuts}
      />
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  danger,
  flyout,
}: {
  icon: typeof Type;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  flyout?: React.ReactNode;
}) {
  return (
    <div className="relative flex justify-center">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={label}
        aria-label={label}
        className={[
          'w-10 h-10 rounded-md flex items-center justify-center transition-colors duration-fast',
          disabled
            ? 'text-txt-muted cursor-not-allowed'
            : active
              ? 'bg-accent/15 text-accent'
              : danger
                ? 'text-txt-secondary hover:bg-error/10 hover:text-error'
                : 'text-txt-secondary hover:bg-bg-hover hover:text-txt-primary',
        ].join(' ')}
      >
        <Icon size={16} />
      </button>
      {flyout}
    </div>
  );
}

function Flyout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute left-full top-0 ml-2 min-w-56 rounded-lg border border-border bg-bg-surface shadow-xl z-30 py-1 text-sm"
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      {children}
    </div>
  );
}

function FlyoutItem({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon?: typeof Type;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-txt-secondary hover:bg-bg-hover hover:text-txt-primary transition-colors duration-fast"
    >
      {Icon && <Icon size={13} className="text-txt-tertiary shrink-0" />}
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        {description && (
          <div className="text-[10px] text-txt-muted truncate">
            {description}
          </div>
        )}
      </div>
    </button>
  );
}

// ─── Right panel: Inspector / Captions / Assets ─────────────────

interface RightPanelProps {
  activeTab: 'clip' | 'captions';
  onTabChange: (t: 'clip' | 'captions') => void;
  episodeId: string;
  playhead: number;
  selectedClip: EditTimelineClip | null;
  onUpdateOverlay: (patch: Partial<EditTimelineClip>) => void;
  onDeleteClip: () => void;
  onTrimClip: (in_s?: number, out_s?: number) => void;
  onPickAsset: (assetId: string) => void;
  onPickStamp: (stampId: string) => void;
  initialTab?: 'clip' | 'captions' | 'assets' | 'stamps';
}

function RightPanel({
  activeTab,
  onTabChange,
  episodeId,
  playhead,
  selectedClip,
  onUpdateOverlay,
  onDeleteClip,
  onTrimClip,
  onPickAsset,
  onPickStamp,
  initialTab,
}: RightPanelProps) {
  const [extendedTab, setExtendedTab] = useState<
    'clip' | 'captions' | 'assets' | 'stamps'
  >(initialTab ?? activeTab);

  // Sync the parent's two-state tab with our four-state tab so the
  // old "clip / captions" API still works when something outside the
  // panel flips it (e.g. the user clicks a clip).
  useEffect(() => {
    setExtendedTab((prev) =>
      prev === 'assets' || prev === 'stamps' ? prev : activeTab,
    );
  }, [activeTab]);

  // External request to switch into a non-clip/captions tab (e.g.
  // ToolsRail "Stamps" button → open the Stamps tab directly).
  useEffect(() => {
    if (initialTab) setExtendedTab(initialTab);
  }, [initialTab]);

  const setTab = (t: 'clip' | 'captions' | 'assets' | 'stamps') => {
    setExtendedTab(t);
    if (t === 'clip' || t === 'captions') onTabChange(t);
  };

  return (
    <aside className="w-[340px] shrink-0 flex flex-col bg-bg-surface">
      <div className="h-9 border-b border-border flex items-center px-2 gap-1 shrink-0 overflow-x-auto">
        {(
          [
            { id: 'clip', label: 'Inspect', icon: Layers },
            { id: 'captions', label: 'Captions', icon: Type },
            { id: 'assets', label: 'Assets', icon: ImageIcon },
            { id: 'stamps', label: 'Stamps', icon: Sticker },
          ] as const
        ).map((t) => {
          const TIcon = t.icon;
          const active = extendedTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={[
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] uppercase tracking-wider transition-colors duration-fast',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-txt-tertiary hover:text-txt-primary',
              ].join(' ')}
            >
              <TIcon size={11} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-3 min-h-0">
        {extendedTab === 'captions' ? (
          <CaptionsInspector episodeId={episodeId} playhead={playhead} />
        ) : extendedTab === 'assets' ? (
          <AssetsBrowser onPickAsset={onPickAsset} />
        ) : extendedTab === 'stamps' ? (
          <StampsBrowser onPickStamp={onPickStamp} />
        ) : selectedClip ? (
          selectedClip.kind ? (
            <OverlayInspector
              clip={selectedClip}
              onUpdate={onUpdateOverlay}
              onDelete={onDeleteClip}
            />
          ) : (
            <ClipInspector
              clip={selectedClip}
              onTrim={(in_s, out_s) => onTrimClip(in_s, out_s)}
              onDelete={onDeleteClip}
            />
          )
        ) : (
          <div className="text-xs text-txt-muted leading-relaxed">
            Select a clip in the timeline to inspect and edit it. Drag
            images from the <strong className="text-txt-secondary">Assets</strong> tab
            into the timeline to add them as overlays at the drop
            position.
            <div className="mt-3 text-[10px] text-txt-tertiary">
              Shortcuts: <kbd className="kbd">Space</kbd> play ·{' '}
              <kbd className="kbd">S</kbd> split ·{' '}
              <kbd className="kbd">⌫</kbd> delete ·{' '}
              <kbd className="kbd">⌘Z</kbd> undo
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── AssetsBrowser — drag source for the timeline ───────────────

function AssetsBrowser({
  onPickAsset,
}: {
  onPickAsset: (assetId: string) => void;
}) {
  const { toast } = useToast();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await assetsApi.list({ kind: 'image', limit: 200 });
      setAssets(list);
    } catch (err) {
      toast.error('Failed to load assets', { description: formatError(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        a.filename.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [assets, search]);

  const onFile = async (file: File) => {
    setUploading(true);
    try {
      const a = await assetsApi.upload(file);
      setAssets((prev) => [a, ...prev]);
      toast.success('Uploaded', { description: a.filename });
    } catch (err) {
      toast.error('Upload failed', { description: formatError(err) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={11}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-txt-tertiary pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter…"
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-elevated border border-border rounded text-txt-primary placeholder:text-txt-tertiary focus:outline-none focus:border-accent"
          />
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-2 py-1.5 text-[11px] text-txt-secondary hover:text-txt-primary hover:border-accent/40 transition-colors duration-fast disabled:opacity-50"
          title="Upload image asset"
        >
          <Upload size={11} />
          {uploading ? '…' : 'Upload'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner size="sm" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-xs text-txt-muted py-8 text-center">
          {search
            ? 'No assets match that filter.'
            : 'No image assets yet. Upload PNGs, logos, stamps, or icons to drag into the timeline.'}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {filtered.map((a) => (
            <button
              key={a.id}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_DRAG_MIME, a.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onPickAsset(a.id)}
              className="group relative aspect-square rounded-md border border-border bg-bg-elevated overflow-hidden hover:border-accent/50 transition-colors duration-fast"
              title={`${a.filename} — drag into timeline or click to add at playhead`}
            >
              <img
                src={assetsApi.fileUrl(a.id)}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
              />
              <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                {a.filename}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="text-[10px] text-txt-muted border-t border-border pt-2 leading-relaxed">
        <strong className="text-txt-secondary">Tip:</strong> drag a thumbnail
        onto the timeline to drop it as an image overlay at that exact time.
        Clicking adds it at the current playhead.
      </div>
    </div>
  );
}

// ─── StampsBrowser — bundled overlay catalog ────────────────────

function StampsBrowser({
  onPickStamp,
}: {
  onPickStamp: (stampId: string) => void;
}) {
  const [activeCategory, setActiveCategory] = useState<StampCategory | 'all'>(
    'all',
  );
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return STAMP_CATALOG.filter((s) => {
      if (activeCategory !== 'all' && s.category !== activeCategory)
        return false;
      if (
        q &&
        !s.label.toLowerCase().includes(q) &&
        !(s.description ?? '').toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [activeCategory, search]);

  const categories: Array<{ id: StampCategory | 'all'; label: string }> = [
    { id: 'all', label: 'All' },
    ...(Object.keys(STAMP_CATEGORY_LABELS) as StampCategory[]).map((id) => ({
      id,
      label: STAMP_CATEGORY_LABELS[id],
    })),
  ];

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          size={11}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-txt-tertiary pointer-events-none"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter stamps…"
          className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-elevated border border-border rounded text-txt-primary placeholder:text-txt-tertiary focus:outline-none focus:border-accent"
        />
      </div>

      <div className="flex flex-wrap gap-1">
        {categories.map((c) => {
          const active = activeCategory === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCategory(c.id)}
              className={[
                'rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors duration-fast',
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg-elevated text-txt-tertiary hover:text-txt-primary',
              ].join(' ')}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="text-xs text-txt-muted py-8 text-center">
          No stamps match that filter.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {filtered.map((stamp) => (
            <StampTile
              key={stamp.id}
              stamp={stamp}
              onPick={() => onPickStamp(stamp.id)}
            />
          ))}
        </div>
      )}

      <div className="text-[10px] text-txt-muted border-t border-border pt-2 leading-relaxed">
        <strong className="text-txt-secondary">Drag</strong> a stamp onto the
        timeline to drop it at a specific time, or <strong className="text-txt-secondary">click</strong> to
        add at the current playhead. Lower-thirds anchor to the bottom of
        the frame; transitions cover the whole frame.
      </div>
    </div>
  );
}

function StampTile({
  stamp,
  onPick,
}: {
  stamp: StampEntry;
  onPick: () => void;
}) {
  const isTransition = stamp.category === 'transitions';
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(STAMP_DRAG_MIME, stamp.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={onPick}
      title={`${stamp.label}${stamp.description ? ` — ${stamp.description}` : ''}`}
      className={[
        'group relative aspect-square rounded-md border border-border overflow-hidden hover:border-accent/50 transition-colors duration-fast',
        // Transition stamps are full-frame solid colors that look
        // empty in a thumbnail, so give them a checkerboard hint.
        isTransition
          ? 'bg-[repeating-conic-gradient(#1c1c1c_0%_25%,#0e0e0e_25%_50%)]'
          : 'bg-bg-elevated',
      ].join(' ')}
    >
      <img
        src={stamp.url}
        alt={stamp.label}
        className="absolute inset-2 w-[calc(100%-1rem)] h-[calc(100%-1rem)] object-contain"
        draggable={false}
      />
      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
        {stamp.label}
      </div>
    </button>
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
  aspectRatio = '9 / 16',
  onAspectDetected,
}: {
  timeline: EditTimeline;
  playhead: number;
  onPlayheadChange: (t: number) => void;
  playing: boolean;
  onPlayToggle: () => void;
  proxyUrl: string | null;
  finalVideoUrl: string | null;
  aspectRatio?: string;
  onAspectDetected?: (ratio: string) => void;
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

  // Detect aspect ratio when the video metadata loads. The browser
  // figures out the right size for whichever dimension is the
  // constraining one (h-full vs w-full); telling the parent the
  // ratio means the inner box doesn't need a hardcoded
  // ``aspect-[9/16]`` that breaks for 16:9 / 1:1 episodes.
  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (!v || !onAspectDetected) return;
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      onAspectDetected(`${v.videoWidth} / ${v.videoHeight}`);
    }
  }, [onAspectDetected]);

  return (
    // The outer wrapper takes all available space (h-full w-full)
    // from its parent and centers a fit-to-bounds inner box. The
    // inner box uses CSS aspect-ratio plus max-h/max-w 100% so the
    // browser naturally picks the largest size that fits without
    // overflowing in EITHER dimension. This is the trick that keeps
    // the video from spilling into the timeline regardless of
    // viewport height.
    <div className="w-full h-full flex items-center justify-center min-h-0">
      <div
        className="bg-black rounded-md overflow-hidden relative group shadow-lg"
        style={{
          aspectRatio: aspectRatio,
          maxHeight: '100%',
          maxWidth: '100%',
          // Without an explicit height, flex parents collapse the box
          // to its content height. ``height: 100%`` plus
          // ``maxHeight: 100%`` and aspect-ratio lets the browser
          // shrink width proportionally when the parent is too narrow.
          height: '100%',
          width: 'auto',
        }}
      >
        {videoSrc ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={videoRef}
            src={videoSrc}
            className="w-full h-full object-contain bg-black"
            onClick={onPlayToggle}
            onLoadedMetadata={onLoadedMeta}
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
