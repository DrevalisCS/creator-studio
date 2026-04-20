import { useState, useCallback } from 'react';
import {
  Scissors,
  Palette,
  Square,
  Zap,
  RotateCcw,
  Eye,
  Save,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { episodes as episodesApi } from '@/lib/api';
import type { VideoEditPayload, BorderConfig } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VideoEditorProps {
  episodeId: string;
  videoDuration: number;
  onEditApplied?: () => void;
}

type ColorFilter = VideoEditPayload['color_filter'];

const COLOR_FILTERS: { value: ColorFilter; label: string; preview: string }[] = [
  { value: null, label: 'None', preview: 'bg-bg-secondary' },
  { value: 'warm', label: 'Warm', preview: 'bg-amber-500/60' },
  { value: 'cool', label: 'Cool', preview: 'bg-blue-500/60' },
  { value: 'bw', label: 'B&W', preview: 'bg-gradient-to-r from-black to-white' },
  { value: 'vintage', label: 'Vintage', preview: 'bg-yellow-800/50' },
  { value: 'vivid', label: 'Vivid', preview: 'bg-gradient-to-r from-pink-500 to-cyan-500' },
  { value: 'dramatic', label: 'Dramatic', preview: 'bg-slate-800/80' },
  { value: 'sepia', label: 'Sepia', preview: 'bg-amber-800/50' },
];

const BORDER_COLORS = [
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF',
  '#FFD700', '#FF69B4', '#8B5CF6', '#06B6D4', '#F97316',
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VideoEditor({
  episodeId,
  videoDuration,
  onEditApplied,
}: VideoEditorProps) {
  // ── State ──────────────────────────────────────────────────────────────
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(videoDuration);
  const [border, setBorder] = useState<BorderConfig | null>(null);
  const [borderWidth, setBorderWidth] = useState(20);
  const [borderColor, setBorderColor] = useState('#000000');
  const [borderStyle, setBorderStyle] = useState<'solid' | 'rounded' | 'glow'>('solid');
  const [colorFilter, setColorFilter] = useState<ColorFilter>(null);
  const [speed, setSpeed] = useState(1.0);
  const [applying, setApplying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'trim' | 'border' | 'color' | 'speed'>('trim');

  // ── Build payload ──────────────────────────────────────────────────────
  const buildPayload = useCallback((): VideoEditPayload => {
    const payload: VideoEditPayload = {};

    if (trimStart > 0) payload.trim_start = trimStart;
    if (trimEnd < videoDuration) payload.trim_end = trimEnd;

    if (border) {
      payload.border = {
        width: borderWidth,
        color: borderColor,
        style: borderStyle,
      };
    }

    if (colorFilter) payload.color_filter = colorFilter;
    if (speed !== 1.0) payload.speed = speed;

    return payload;
  }, [trimStart, trimEnd, videoDuration, border, borderWidth, borderColor, borderStyle, colorFilter, speed]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handlePreview = async () => {
    setPreviewing(true);
    setMessage(null);
    try {
      const result = await episodesApi.editPreview(episodeId, buildPayload());
      setMessage(`Preview generated (${result.duration_seconds?.toFixed(1)}s)`);
      onEditApplied?.();
    } catch (err) {
      setMessage(`Preview failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const result = await episodesApi.editVideo(episodeId, buildPayload());
      setMessage(`Edits applied! Duration: ${result.duration_seconds?.toFixed(1)}s`);
      onEditApplied?.();
    } catch (err) {
      setMessage(`Apply failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    setMessage(null);
    try {
      await episodesApi.editReset(episodeId);
      setTrimStart(0);
      setTrimEnd(videoDuration);
      setBorder(null);
      setColorFilter(null);
      setSpeed(1.0);
      setMessage('Video restored to original');
      onEditApplied?.();
    } catch (err) {
      setMessage(`Reset failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setResetting(false);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${m}:${sec.toString().padStart(2, '0')}.${ms}`;
  };

  const busy = applying || previewing || resetting;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-txt-primary">Video Editor</h3>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleReset()}
            disabled={busy}
            title="Reset to original"
          >
            {resetting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            Reset
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handlePreview()}
            disabled={busy}
          >
            {previewing ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            Preview
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleApply()}
            disabled={busy}
          >
            {applying ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Apply
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-bg-secondary rounded-lg p-1">
        {([
          { id: 'trim', icon: Scissors, label: 'Trim' },
          { id: 'border', icon: Square, label: 'Border' },
          { id: 'color', icon: Palette, label: 'Color' },
          { id: 'speed', icon: Zap, label: 'Speed' },
        ] as const).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
              activeTab === id
                ? 'bg-bg-primary text-txt-primary shadow-sm'
                : 'text-txt-secondary hover:text-txt-primary'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-[120px]">
        {/* ── Trim ── */}
        {activeTab === 'trim' && (
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="text-xs text-txt-secondary block mb-1">Start: {formatTime(trimStart)}</label>
                <input
                  type="range"
                  min={0}
                  max={videoDuration}
                  step={0.1}
                  value={trimStart}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setTrimStart(Math.min(v, trimEnd - 0.5));
                  }}
                  className="w-full accent-accent h-1.5 rounded-lg cursor-pointer"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-secondary block mb-1">End: {formatTime(trimEnd)}</label>
                <input
                  type="range"
                  min={0}
                  max={videoDuration}
                  step={0.1}
                  value={trimEnd}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setTrimEnd(Math.max(v, trimStart + 0.5));
                  }}
                  className="w-full accent-accent h-1.5 rounded-lg cursor-pointer"
                />
              </div>
            </div>
            {/* Visual timeline */}
            <div className="relative h-8 bg-bg-secondary rounded overflow-hidden">
              <div
                className="absolute top-0 bottom-0 bg-accent/20 border-x-2 border-accent"
                style={{
                  left: `${(trimStart / videoDuration) * 100}%`,
                  width: `${((trimEnd - trimStart) / videoDuration) * 100}%`,
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center text-[10px] text-txt-secondary">
                Selected: {formatTime(trimEnd - trimStart)}
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                label="Start (s)"
                type="number"
                value={trimStart.toFixed(1)}
                onChange={(e) => setTrimStart(Math.max(0, parseFloat(e.target.value) || 0))}
                className="text-xs"
              />
              <Input
                label="End (s)"
                type="number"
                value={trimEnd.toFixed(1)}
                onChange={(e) => setTrimEnd(Math.min(videoDuration, parseFloat(e.target.value) || videoDuration))}
                className="text-xs"
              />
            </div>
          </div>
        )}

        {/* ── Border ── */}
        {activeTab === 'border' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-txt-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={border !== null}
                  onChange={(e) => setBorder(e.target.checked ? { width: borderWidth, color: borderColor, style: borderStyle } : null)}
                  className="accent-accent"
                />
                Enable border
              </label>
            </div>

            {border !== null && (
              <>
                <div>
                  <label className="text-xs text-txt-secondary block mb-1">Width: {borderWidth}px</label>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    value={borderWidth}
                    onChange={(e) => {
                      const w = parseInt(e.target.value);
                      setBorderWidth(w);
                      setBorder({ width: w, color: borderColor, style: borderStyle });
                    }}
                    className="w-full accent-accent h-1.5 rounded-lg cursor-pointer"
                  />
                </div>

                <div>
                  <label className="text-xs text-txt-secondary block mb-1">Style</label>
                  <div className="flex gap-2">
                    {(['solid', 'rounded', 'glow'] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setBorderStyle(s);
                          setBorder({ width: borderWidth, color: borderColor, style: s });
                        }}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                          borderStyle === s
                            ? 'bg-accent text-white'
                            : 'bg-bg-secondary text-txt-secondary hover:text-txt-primary'
                        }`}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-txt-secondary block mb-1">Color</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {BORDER_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          setBorderColor(c);
                          setBorder({ width: borderWidth, color: c, style: borderStyle });
                        }}
                        className={`w-7 h-7 rounded-md border-2 transition-all ${
                          borderColor === c ? 'border-accent scale-110' : 'border-border hover:scale-105'
                        }`}
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                    <input
                      type="color"
                      value={borderColor}
                      onChange={(e) => {
                        setBorderColor(e.target.value);
                        setBorder({ width: borderWidth, color: e.target.value, style: borderStyle });
                      }}
                      className="w-7 h-7 rounded-md cursor-pointer border border-border"
                      title="Custom color"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Color Filter ── */}
        {activeTab === 'color' && (
          <div className="space-y-2">
            <label className="text-xs text-txt-secondary block">Color Filter</label>
            <div className="grid grid-cols-4 gap-2">
              {COLOR_FILTERS.map(({ value, label, preview }) => (
                <button
                  key={label}
                  onClick={() => setColorFilter(value)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-all ${
                    colorFilter === value
                      ? 'border-accent bg-accent/10'
                      : 'border-border hover:border-accent/50'
                  }`}
                >
                  <div className={`w-full h-8 rounded ${preview}`} />
                  <span className="text-[10px] text-txt-secondary">{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Speed ── */}
        {activeTab === 'speed' && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-txt-secondary block mb-1">Speed: {speed.toFixed(2)}x</label>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full accent-accent h-1.5 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-txt-tertiary mt-1">
                <span>0.25x</span>
                <span>1x</span>
                <span>2x</span>
                <span>4x</span>
              </div>
            </div>
            <div className="flex gap-2">
              {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    speed === s
                      ? 'bg-accent text-white'
                      : 'bg-bg-secondary text-txt-secondary hover:text-txt-primary'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
            <p className="text-[10px] text-txt-tertiary">
              Output duration: ~{formatTime((trimEnd - trimStart) / speed)}
            </p>
          </div>
        )}
      </div>

      {/* Status message */}
      {message && (
        <p className={`text-xs px-2 py-1 rounded ${
          message.includes('failed') ? 'text-red-400 bg-red-500/10' : 'text-green-400 bg-green-500/10'
        }`}>
          {message}
        </p>
      )}
    </Card>
  );
}
