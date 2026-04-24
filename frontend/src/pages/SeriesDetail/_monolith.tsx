import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Clock,
  Film,
  Subtitles,
  Music,
  Video,
  ChevronDown,
  ChevronRight,
  Play,
  Sparkles,
  TrendingUp,
  LayoutTemplate,
  CheckCircle2,
  LayoutGrid,
  Columns3,
  Youtube,
  Palette,
  Settings2,
  Wand2,
  Check,
  CloudOff,
  Loader2,
  MoreVertical,
  Globe,
  Calendar,
  Pencil,
  Smartphone,
  Monitor,
  Music2,
  Shapes,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { EpisodeCard } from '@/components/episodes/EpisodeCard';
import { ABTestsPanel } from '@/components/series/ABTestsPanel';
import { AssetPicker } from '@/components/assets/AssetPicker';
import {
  CaptionStyleEditor,
  DEFAULT_CAPTION_STYLE,
} from '@/components/captions/CaptionStyleEditor';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import {
  series as seriesApi,
  episodes as episodesApi,
  comfyuiWorkflows as workflowsApi,
  videoTemplates as videoTemplatesApi,
} from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import type {
  Series,
  EpisodeListItem,
  EpisodeCreate,
  CaptionStyle,
  ComfyUIWorkflow,
} from '@/types';

// ---------------------------------------------------------------------------
// Language options — BCP-47 tags. Shown in the series edit form and used
// to filter voice profiles. Narration is written in this language; visual
// prompts stay in English because ComfyUI image models are English-only.
// ---------------------------------------------------------------------------

const LANGUAGE_OPTIONS = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'de-DE', label: 'German (Germany)' },
  { value: 'de-AT', label: 'German (Austria)' },
  { value: 'de-CH', label: 'German (Switzerland)' },
  { value: 'fr-FR', label: 'French (France)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'es-MX', label: 'Spanish (Mexico)' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'pt-PT', label: 'Portuguese (Portugal)' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'nl-NL', label: 'Dutch' },
  { value: 'pl-PL', label: 'Polish' },
  { value: 'sv-SE', label: 'Swedish' },
  { value: 'da-DK', label: 'Danish' },
  { value: 'no-NO', label: 'Norwegian' },
  { value: 'fi-FI', label: 'Finnish' },
  { value: 'ru-RU', label: 'Russian' },
  { value: 'tr-TR', label: 'Turkish' },
  { value: 'ar-SA', label: 'Arabic (Saudi)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'ko-KR', label: 'Korean' },
  { value: 'zh-CN', label: 'Chinese (Mandarin, Simplified)' },
  { value: 'zh-TW', label: 'Chinese (Traditional)' },
];


// ---------------------------------------------------------------------------
// Visual style presets
// ---------------------------------------------------------------------------

const VISUAL_STYLE_PRESETS = [
  {
    label: 'Cinematic',
    value:
      'Cinematic film style, dramatic lighting, shallow depth of field, professional color grading, anamorphic lens flare, 8k resolution',
  },
  {
    label: 'Space / Sci-Fi',
    value:
      'Deep space photography, nebulas, galaxies, planets with atmospheric rings, cosmic dust, NASA-style imagery, dark void background, volumetric lighting',
  },
  {
    label: 'Nature / Landscape',
    value:
      'Epic landscape photography, golden hour lighting, dramatic clouds, lush vegetation, aerial drone shots, National Geographic style, natural colors',
  },
  {
    label: 'Urban / City',
    value:
      'Urban cityscape, neon lights, moody atmosphere, rain-slicked streets, architectural photography, cyberpunk aesthetic, night city skyline',
  },
  {
    label: 'Abstract / Fractal',
    value:
      'Abstract digital art, fractal geometry, flowing colors, mathematical patterns, generative art, vibrant gradients, psychedelic visuals',
  },
  {
    label: 'Macro / Detail',
    value:
      'Extreme macro photography, intricate details, shallow depth of field, crystal-clear focus, natural textures, dewdrops and surfaces',
  },
  {
    label: 'Documentary',
    value:
      'Documentary photography style, photojournalistic, natural lighting, candid moments, authentic atmosphere, true-to-life colors',
  },
  {
    label: 'Dark / Horror',
    value:
      'Dark gothic atmosphere, deep shadows, eerie fog, abandoned locations, desaturated colors, horror movie aesthetic, suspenseful mood',
  },
  {
    label: 'Fantasy / Mythical',
    value:
      'Epic fantasy art, mythical creatures, enchanted forests, magical lighting, otherworldly landscapes, high fantasy illustration style',
  },
  {
    label: 'Anime / Illustration',
    value:
      'Anime art style, vibrant colors, clean line art, dynamic composition, Studio Ghibli inspired backgrounds, cel-shaded aesthetics',
  },
] as const;

// ---------------------------------------------------------------------------
// Music mood options
// ---------------------------------------------------------------------------

const MUSIC_MOODS = [
  { value: 'upbeat', label: 'Upbeat' },
  { value: 'dramatic', label: 'Dramatic' },
  { value: 'calm', label: 'Calm' },
  { value: 'energetic', label: 'Energetic' },
  { value: 'mysterious', label: 'Mysterious' },
  { value: 'playful', label: 'Playful' },
];

// ---------------------------------------------------------------------------
// Collapsible Section
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ElementType;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card padding="none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-bg-hover transition-colors duration-fast"
      >
        <div className="flex items-center gap-2.5">
          <Icon size={16} className="text-accent shrink-0" />
          <span className="text-md font-semibold text-txt-primary">
            {title}
          </span>
        </div>
        {open ? (
          <ChevronDown size={16} className="text-txt-tertiary" />
        ) : (
          <ChevronRight size={16} className="text-txt-tertiary" />
        )}
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-border">{children}</div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Autosave status pill (v0.20.32)
//
// Small inline indicator that lives next to the breadcrumb and
// reflects the state of the debounced background save. Appears to the
// right of the breadcrumb trail so the user can glance at it without
// leaving the page.
// ---------------------------------------------------------------------------

function AutosaveStatusPill({
  status,
}: {
  status: 'idle' | 'saving' | 'saved' | 'error';
}) {
  if (status === 'idle') {
    return (
      <span
        className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-txt-muted"
        aria-hidden
      >
        Autosave on
      </span>
    );
  }
  if (status === 'saving') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-bg-elevated border border-border px-2.5 py-1 text-[11px] text-txt-secondary"
        role="status"
        aria-live="polite"
      >
        <Loader2 size={11} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-success/10 border border-success/30 px-2.5 py-1 text-[11px] text-success"
        role="status"
        aria-live="polite"
      >
        <Check size={11} />
        Saved
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-error/10 border border-error/30 px-2.5 py-1 text-[11px] text-error"
      role="status"
      aria-live="polite"
    >
      <CloudOff size={11} />
      Save failed
    </span>
  );
}

// ---------------------------------------------------------------------------
// HeroCard (v0.20.34)
//
// Sits at the top of the page as the visual anchor for the series.
// Title and description are edited inline — clicking the text swaps
// to an input that blur-commits back to the autosave loop, so the
// user never has to hunt for a save button. Metric chips show the
// at-a-glance status (episode count, total runtime, language,
// format, last activity). The three rare, destructive-ish actions
// (apply template / save as template / delete) hide behind a kebab
// menu so the hero stays clean.
// ---------------------------------------------------------------------------

interface HeroCardProps {
  name: string;
  onNameChange: (next: string) => void;
  description: string;
  onDescriptionChange: (next: string) => void;
  episodeCount: number;
  totalRuntimeSeconds: number;
  language: string;
  contentFormat: string;
  lastActivity: string | null;
  onApplyTemplate: () => void;
  onSaveAsTemplate: () => void;
  savingAsTemplate: boolean;
  saveTemplateSuccess: boolean;
  onDelete: () => void;
}

function HeroCard({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  episodeCount,
  totalRuntimeSeconds,
  language,
  contentFormat,
  lastActivity,
  onApplyTemplate,
  onSaveAsTemplate,
  savingAsTemplate,
  saveTemplateSuccess,
  onDelete,
}: HeroCardProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const runtimeLabel = useMemo(() => {
    const mins = Math.round(totalRuntimeSeconds / 60);
    if (mins === 0) return `${totalRuntimeSeconds}s`;
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  }, [totalRuntimeSeconds]);

  const lastActivityLabel = useMemo(() => {
    if (!lastActivity) return 'No activity yet';
    try {
      const d = new Date(lastActivity);
      const diffMs = Date.now() - d.getTime();
      const diffH = Math.floor(diffMs / 3_600_000);
      if (diffH < 1) return 'Active in the last hour';
      if (diffH < 24) return `${diffH}h ago`;
      const diffD = Math.floor(diffH / 24);
      if (diffD < 7) return `${diffD}d ago`;
      return d.toLocaleDateString();
    } catch {
      return lastActivity;
    }
  }, [lastActivity]);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = () => setMenuOpen(false);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [menuOpen]);

  return (
    <Card padding="lg">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Title — click to edit */}
          {editingTitle ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="w-full bg-transparent border-b border-accent/50 focus:border-accent outline-none text-2xl font-semibold text-txt-primary pb-1"
              aria-label="Series name"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="group flex items-center gap-2 text-left -mx-1 px-1 rounded hover:bg-bg-hover/40 transition-colors duration-fast"
              title="Click to rename"
            >
              <h1 className="text-2xl font-semibold text-txt-primary truncate">
                {name || 'Untitled series'}
              </h1>
              <Pencil
                size={14}
                className="text-txt-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              />
            </button>
          )}

          {/* Description — click to edit */}
          {editingDesc ? (
            <textarea
              autoFocus
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              onBlur={() => setEditingDesc(false)}
              rows={2}
              placeholder="Describe this series..."
              className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-sm text-txt-secondary outline-none focus:border-accent resize-none"
              aria-label="Series description"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingDesc(true)}
              className="group block w-full text-left -mx-1 px-1 py-0.5 rounded hover:bg-bg-hover/40 transition-colors duration-fast"
              title="Click to edit description"
            >
              <p
                className={[
                  'text-sm line-clamp-2',
                  description ? 'text-txt-secondary' : 'text-txt-muted italic',
                ].join(' ')}
              >
                {description || 'Add a short description…'}
              </p>
            </button>
          )}

          {/* Metric chips */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge variant="neutral" className="gap-1">
              <Film size={10} />
              {episodeCount} {episodeCount === 1 ? 'episode' : 'episodes'}
            </Badge>
            <Badge variant="neutral" className="gap-1">
              <Clock size={10} />
              {runtimeLabel}
            </Badge>
            <Badge variant="neutral" className="gap-1">
              <Globe size={10} />
              {language}
            </Badge>
            <Badge variant="accent" className="gap-1 capitalize">
              <LayoutTemplate size={10} />
              {contentFormat.replace('_', ' ')}
            </Badge>
            <Badge variant="neutral" className="gap-1">
              <Calendar size={10} />
              {lastActivityLabel}
            </Badge>
          </div>
        </div>

        {/* Kebab menu */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="rounded-md border border-border bg-bg-elevated p-1.5 text-txt-secondary hover:text-txt-primary hover:bg-bg-hover transition-colors duration-fast"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 mt-1 w-56 rounded-lg border border-border bg-bg-surface shadow-lg z-20 py-1 text-sm"
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onApplyTemplate();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-txt-secondary hover:bg-bg-hover hover:text-txt-primary"
              >
                <LayoutTemplate size={13} />
                Apply Template…
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={savingAsTemplate}
                onClick={() => {
                  setMenuOpen(false);
                  onSaveAsTemplate();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-txt-secondary hover:bg-bg-hover hover:text-txt-primary disabled:opacity-50"
              >
                {saveTemplateSuccess ? (
                  <CheckCircle2 size={13} className="text-success" />
                ) : (
                  <LayoutTemplate size={13} />
                )}
                {saveTemplateSuccess
                  ? 'Template saved'
                  : savingAsTemplate
                    ? 'Saving template…'
                    : 'Save as Template'}
              </button>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-error hover:bg-error/10"
              >
                <Trash2 size={13} />
                Delete Series
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// VisualStylePresetPopover (v0.20.34)
//
// Popover picker for the 10 built-in visual style presets. Renders
// as a "Change Style" pill that opens a card grid of preset previews
// on click. Picking one writes the preset's value into the prompt
// textarea; the user can then tweak the wording freely, which is the
// behavior the UX audit said was opaque in the old rail-of-chips
// layout. A subtle accent border marks the currently-active preset
// so the connection between "pick one" and "what's in the text" is
// visible.
// ---------------------------------------------------------------------------

interface VisualStylePreset {
  label: string;
  value: string;
}

function VisualStylePresetPopover({
  presets,
  currentValue,
  onPick,
}: {
  presets: readonly VisualStylePreset[];
  currentValue: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeLabel =
    presets.find((p) => p.value === currentValue)?.label ?? 'Custom';

  useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-3 py-1.5 text-xs font-medium text-txt-secondary hover:text-txt-primary hover:bg-bg-hover transition-colors duration-fast"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Palette size={12} className="text-accent" />
        Style: <span className="text-txt-primary">{activeLabel}</span>
        <ChevronDown
          size={11}
          className={[
            'transition-transform duration-fast',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>
      {open && (
        <div
          className="absolute left-0 z-20 mt-2 w-[520px] max-w-[90vw] rounded-lg border border-border bg-bg-surface shadow-xl p-3"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Visual style presets"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
              Presets
            </span>
            <span className="text-[11px] text-txt-muted">
              {presets.length} options
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[320px] overflow-y-auto">
            {presets.map((preset) => {
              const active = preset.value === currentValue;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    onPick(preset.value);
                    setOpen(false);
                  }}
                  className={[
                    'group rounded-md border p-2.5 text-left transition-colors duration-fast',
                    active
                      ? 'border-accent bg-accent/10'
                      : 'border-border bg-bg-elevated hover:border-accent/40 hover:bg-bg-hover',
                  ].join(' ')}
                  aria-pressed={active}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={[
                        'text-xs font-semibold',
                        active ? 'text-accent' : 'text-txt-primary',
                      ].join(' ')}
                    >
                      {preset.label}
                    </span>
                    {active && (
                      <Check size={12} className="text-accent shrink-0" />
                    )}
                  </div>
                  <p className="mt-1 text-[10px] text-txt-muted line-clamp-2">
                    {preset.value}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Series Detail Page
// ---------------------------------------------------------------------------

function SeriesDetail() {
  const { seriesId } = useParams<{ seriesId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [seriesData, setSeriesData] = useState<Series | null>(null);
  const [episodesList, setEpisodesList] = useState<EpisodeListItem[]>([]);
  const [workflows, setWorkflows] = useState<ComfyUIWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  // ── Autosave state (v0.20.32) ────────────────────────────────
  // `autosaveStatus` drives the status pill in the breadcrumb row.
  // Goes: idle → saving → saved → (1.5s later) → idle. On error we
  // land on "error" so the user knows their last change didn't make
  // it to the server. A ref tracks whether we've seen the first
  // successful fetch — edits before that shouldn't trigger a save.
  const [autosaveStatus, setAutosaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const hasLoadedOnce = useRef(false);
  const savedSignatureRef = useRef<string>('');

  // Edit state — basic
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDuration, setEditDuration] = useState('30');
  const [editStyle, setEditStyle] = useState('');
  const [editCharacter, setEditCharacter] = useState('');
  const [editLanguage, setEditLanguage] = useState('en-US');

  // Edit state — caption style
  const [editCaptionStyle, setEditCaptionStyle] =
    useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);

  // Edit state — music
  const [editMusicEnabled, setEditMusicEnabled] = useState(false);
  const [editMusicMood, setEditMusicMood] = useState('upbeat');
  const [editMusicVolume, setEditMusicVolume] = useState(-14);

  // Edit state — scene mode / video workflow
  const [editSceneMode, setEditSceneMode] = useState<'image' | 'video'>('image');
  const [editVideoWorkflowId, setEditVideoWorkflowId] = useState('');

  // Edit state — YouTube channel
  const [editYoutubeChannelId, setEditYoutubeChannelId] = useState('');
  const [youtubeChannels, setYoutubeChannels] = useState<Array<{ id: string; channel_name: string }>>([]);

  // Edit state — longform
  const [editContentFormat, setEditContentFormat] = useState<
    'shorts' | 'longform' | 'music_video' | 'animation'
  >('shorts');
  const [editTargetMinutes, setEditTargetMinutes] = useState(30);
  const [editScenesPerChapter, setEditScenesPerChapter] = useState(8);
  const [editVisualConsistency, setEditVisualConsistency] = useState('');
  const [editAspectRatio, setEditAspectRatio] = useState('9:16');
  // Phase E locks — comma-separated UUIDs + strength/lora.
  const [editCharacterAssetIds, setEditCharacterAssetIds] = useState('');
  const [editCharacterStrength, setEditCharacterStrength] = useState(0.75);
  const [editCharacterLora, setEditCharacterLora] = useState('');
  const [editStyleAssetIds, setEditStyleAssetIds] = useState('');
  const [editStyleStrength, setEditStyleStrength] = useState(0.5);
  const [editStyleLora, setEditStyleLora] = useState('');


  // Create episode dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [creatingEpisode, setCreatingEpisode] = useState(false);

  // Generate all drafts
  const [generatingAllDrafts, setGeneratingAllDrafts] = useState(false);

  // AI add episodes
  const [addingEpisodesAi, setAddingEpisodesAi] = useState(false);

  // Trending topics
  const [trendingOpen, setTrendingOpen] = useState(false);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingTopics, setTrendingTopics] = useState<Array<{ title: string; angle?: string; hook?: string; estimated_engagement?: string }>>([]);

  // Delete confirm
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteAllEpisodesOpen, setDeleteAllEpisodesOpen] = useState(false);
  const [deletingAllEpisodes, setDeletingAllEpisodes] = useState(false);

  // Save as template
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);
  const [saveTemplateSuccess, setSaveTemplateSuccess] = useState(false);

  // Apply template
  const [applyTemplateOpen, setApplyTemplateOpen] = useState(false);
  const [availableTemplates, setAvailableTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!seriesId) return;
    try {
      const { youtube } = await import('@/lib/api');
      const [s, eps, wfs, ytChannels] = await Promise.all([
        seriesApi.get(seriesId),
        episodesApi.list({ series_id: seriesId }),
        workflowsApi.list().catch(() => [] as ComfyUIWorkflow[]),
        youtube.listChannels().catch(() => [] as Array<{ id: string; channel_name: string }>),
      ]);
      setSeriesData(s);
      setEpisodesList(eps);
      setWorkflows(wfs);
      setEditName(s.name);
      setEditDescription(s.description ?? '');
      setEditDuration(String(s.target_duration_seconds));
      setEditStyle(s.visual_style ?? '');
      setEditCharacter(s.character_description ?? '');
      setEditLanguage(s.default_language ?? 'en-US');
      setEditCaptionStyle(s.caption_style ?? DEFAULT_CAPTION_STYLE);
      setEditMusicEnabled(s.music_enabled);
      setEditMusicMood(s.music_mood ?? 'upbeat');
      setEditMusicVolume(s.music_volume_db);
      setEditSceneMode(s.scene_mode ?? 'image');
      setEditVideoWorkflowId(s.video_comfyui_workflow_id ?? '');
      setEditYoutubeChannelId(s.youtube_channel_id ?? '');
      setYoutubeChannels(ytChannels);
      setEditContentFormat(s.content_format ?? 'shorts');
      setEditTargetMinutes(s.target_duration_minutes ?? 30);
      setEditScenesPerChapter(s.scenes_per_chapter ?? 8);
      setEditVisualConsistency(s.visual_consistency_prompt ?? '');
      setEditAspectRatio(s.aspect_ratio ?? '9:16');
      const cLock = (s as any).character_lock || null;
      const sLock = (s as any).style_lock || null;
      setEditCharacterAssetIds((cLock?.asset_ids ?? []).join(', '));
      setEditCharacterStrength(Number(cLock?.strength ?? 0.75));
      setEditCharacterLora(cLock?.lora ?? '');
      setEditStyleAssetIds((sLock?.asset_ids ?? []).join(', '));
      setEditStyleStrength(Number(sLock?.strength ?? 0.5));
      setEditStyleLora(sLock?.lora ?? '');
      // Mark baseline so the next tick's useEffect doesn't fire an
      // autosave just because we rehydrated state from the server.
      hasLoadedOnce.current = true;
    } catch (err) {
      toast.error('Failed to load series', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [seriesId, toast]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Re-fetch YouTube channels when the tab regains focus (e.g. after OAuth redirect)
  useEffect(() => {
    const onFocus = async () => {
      try {
        const { youtube } = await import('@/lib/api');
        const chs = await youtube.listChannels();
        setYoutubeChannels(chs);
      } catch { /* ignore */ }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void onFocus();
    };
    window.addEventListener('focus', () => void onFocus());
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', () => void onFocus());
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Build the update payload from current edit state. Used by both
  // the debounced autosave and any direct persistence call (e.g. after
  // template apply). Kept as a pure builder so deps are explicit.
  const buildPayload = useCallback(
    () => ({
      name: editName.trim() || undefined,
      description: editDescription.trim() || undefined,
      target_duration_seconds: Number(editDuration) as 15 | 30 | 60,
      visual_style: editStyle || undefined,
      character_description: editCharacter || undefined,
      default_language: editLanguage || undefined,
      caption_style: editCaptionStyle,
      scene_mode: editSceneMode,
      music_enabled: editMusicEnabled,
      music_mood: editMusicMood || undefined,
      music_volume_db: editMusicVolume,
      video_comfyui_workflow_id: editVideoWorkflowId || undefined,
      youtube_channel_id: editYoutubeChannelId || undefined,
      content_format: editContentFormat,
      target_duration_minutes:
        editContentFormat === 'longform' ? editTargetMinutes : undefined,
      scenes_per_chapter:
        editContentFormat === 'longform' ? editScenesPerChapter : undefined,
      visual_consistency_prompt: editVisualConsistency || undefined,
      aspect_ratio: editAspectRatio,
      character_lock: editCharacterAssetIds.trim()
        ? {
            asset_ids: editCharacterAssetIds
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            strength: editCharacterStrength,
            lora: editCharacterLora || null,
          }
        : null,
      style_lock: editStyleAssetIds.trim()
        ? {
            asset_ids: editStyleAssetIds
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            strength: editStyleStrength,
            lora: editStyleLora || null,
          }
        : null,
    }),
    [
      editName,
      editDescription,
      editDuration,
      editStyle,
      editCharacter,
      editLanguage,
      editCaptionStyle,
      editSceneMode,
      editMusicEnabled,
      editMusicMood,
      editMusicVolume,
      editVideoWorkflowId,
      editYoutubeChannelId,
      editContentFormat,
      editTargetMinutes,
      editScenesPerChapter,
      editVisualConsistency,
      editAspectRatio,
      editCharacterAssetIds,
      editCharacterStrength,
      editCharacterLora,
      editStyleAssetIds,
      editStyleStrength,
      editStyleLora,
    ],
  );

  // Debounced autosave. Fires ~600ms after the last edit. The
  // signature hash keeps us from spamming saves when unrelated state
  // (toasts, dialog open flags) triggers a re-render.
  const payload = useMemo(() => buildPayload(), [buildPayload]);
  const signature = useMemo(() => JSON.stringify(payload), [payload]);

  useEffect(() => {
    if (!seriesId || !hasLoadedOnce.current) return;
    if (savedSignatureRef.current === '') {
      // First pass after load — seed the baseline, no save.
      savedSignatureRef.current = signature;
      return;
    }
    if (savedSignatureRef.current === signature) return;

    const timer = setTimeout(async () => {
      setAutosaveStatus('saving');
      try {
        await seriesApi.update(seriesId, payload as any);
        savedSignatureRef.current = signature;
        setAutosaveStatus('saved');
        setTimeout(() => {
          setAutosaveStatus((cur) => (cur === 'saved' ? 'idle' : cur));
        }, 1500);
      } catch (err) {
        setAutosaveStatus('error');
        toast.error('Autosave failed', { description: String(err) });
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [signature, payload, seriesId, toast]);

  const handleDelete = async () => {
    if (!seriesId) return;
    setDeleting(true);
    try {
      await seriesApi.delete(seriesId);
      navigate('/series');
    } catch (err) {
      toast.error('Failed to delete series', { description: String(err) });
      setDeleting(false);
    }
  };

  const handleCreateEpisode = async () => {
    if (!seriesId || !newTitle.trim()) return;
    setCreatingEpisode(true);
    try {
      const payload: EpisodeCreate = {
        series_id: seriesId,
        title: newTitle.trim(),
        topic: newTopic.trim() || undefined,
      };
      const ep = await episodesApi.create(payload);
      setCreateDialogOpen(false);
      setNewTitle('');
      setNewTopic('');
      toast.success('Episode created');
      navigate(`/episodes/${ep.id}`);
    } catch (err) {
      toast.error('Failed to create episode', { description: String(err) });
    } finally {
      setCreatingEpisode(false);
    }
  };

  const handleGenerateAllDrafts = async () => {
    const drafts = episodesList.filter((ep) => ep.status === 'draft');
    if (drafts.length === 0) return;
    setGeneratingAllDrafts(true);
    try {
      await Promise.all(drafts.map((ep) => episodesApi.generate(ep.id)));
      toast.success('Generation started', { description: `${drafts.length} draft episode${drafts.length !== 1 ? 's' : ''} queued` });
      void fetchData();
    } catch (err) {
      toast.error('Failed to start generation', { description: String(err) });
    } finally {
      setGeneratingAllDrafts(false);
    }
  };

  const handleAddEpisodesAi = async () => {
    if (!seriesId) return;
    setAddingEpisodesAi(true);
    try {
      await seriesApi.addEpisodesAi(seriesId, 5);
      toast.success('AI episodes added', { description: '5 new episode ideas generated' });
      void fetchData();
    } catch (err) {
      toast.error('Failed to add AI episodes', { description: String(err) });
    } finally {
      setAddingEpisodesAi(false);
    }
  };

  const handleTrendingTopics = async () => {
    if (!seriesId) return;
    setTrendingLoading(true);
    try {
      const result = await seriesApi.trendingTopics(seriesId);
      setTrendingTopics(result.topics || []);
      setTrendingOpen(true);
    } catch (err) {
      toast.error('Failed to fetch trending topics', { description: String(err) });
    } finally {
      setTrendingLoading(false);
    }
  };

  const handleSaveAsTemplate = async () => {
    if (!seriesId) return;
    setSavingAsTemplate(true);
    setSaveTemplateSuccess(false);
    try {
      await videoTemplatesApi.fromSeries(seriesId);
      setSaveTemplateSuccess(true);
      toast.success('Template saved', { description: 'Current series settings saved as a reusable template' });
      setTimeout(() => setSaveTemplateSuccess(false), 3000);
    } catch (err) {
      toast.error('Failed to save template', { description: String(err) });
    } finally {
      setSavingAsTemplate(false);
    }
  };

  const openApplyTemplateDialog = async () => {
    setApplyTemplateOpen(true);
    setLoadingTemplates(true);
    try {
      const tmpl = await videoTemplatesApi.list();
      setAvailableTemplates(tmpl);
    } catch (err) {
      toast.error('Failed to load templates', { description: String(err) });
      setAvailableTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleApplyTemplate = async (templateId: string) => {
    if (!seriesId) return;
    setApplyingTemplateId(templateId);
    try {
      await videoTemplatesApi.applyToSeries(templateId, seriesId);
      toast.success('Template applied', { description: 'Series settings updated from template' });
      setApplyTemplateOpen(false);
      void fetchData();
    } catch (err) {
      toast.error('Failed to apply template', { description: String(err) });
    } finally {
      setApplyingTemplateId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!seriesData) {
    return (
      <div className="text-center py-20">
        <p className="text-txt-secondary">Series not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/series')}>
          <ArrowLeft size={14} />
          Back to Series
        </Button>
      </div>
    );
  }

  // ── Section nav config (v0.20.31) ────────────────────────────
  // Each entry renders in the sticky left rail on wide screens and
  // scrolls its target section into view on click. Icons reuse the
  // lucide set already imported elsewhere on the page.
  const SECTION_NAV: Array<{
    id: string;
    label: string;
    icon: React.ElementType;
  }> = [
    { id: 'overview', label: 'Overview', icon: Film },
    { id: 'visual', label: 'Visual Style', icon: Palette },
    { id: 'captions', label: 'Captions', icon: Subtitles },
    { id: 'audio', label: 'Audio', icon: Music },
    { id: 'publish', label: 'Publish', icon: Youtube },
    { id: 'format', label: 'Content Format', icon: LayoutTemplate },
    { id: 'generation', label: 'Generation', icon: Settings2 },
    { id: 'episodes', label: 'Episodes', icon: Wand2 },
  ];
  const scrollToSection = (id: string) => {
    const el = document.getElementById(`section-${id}`);
    if (!el) return;
    // Offset for the sticky header so the section header doesn't end up
    // behind it.
    const y = el.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: y, behavior: 'smooth' });
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb + autosave status pill (v0.20.32) */}
      <div className="flex items-center justify-between gap-4">
        <Breadcrumb
          items={[
            { label: 'Series', to: '/series' },
            { label: editName || seriesData.name || 'Series Detail' },
          ]}
        />
        <AutosaveStatusPill status={autosaveStatus} />
      </div>

      {/* Two-column layout (lg+): sticky rail nav + scrollable content.
          Collapses to a single column below lg. */}
      <div className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-6">
        <aside className="hidden lg:block">
          <nav
            className="sticky top-20 flex flex-col gap-0.5 rounded-lg border border-border bg-bg-surface/60 p-2 backdrop-blur"
            aria-label="Series sections"
          >
            {SECTION_NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => scrollToSection(id)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-txt-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-txt-primary"
              >
                <Icon size={14} className="shrink-0 text-txt-tertiary" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="space-y-6 min-w-0">

      {/* Hero card — inline-editable title + description, metric chips, kebab */}
      <section id="section-overview" />
      <HeroCard
        name={editName}
        onNameChange={setEditName}
        description={editDescription}
        onDescriptionChange={setEditDescription}
        episodeCount={episodesList.length}
        totalRuntimeSeconds={
          episodesList.length * seriesData.target_duration_seconds
        }
        language={seriesData.default_language ?? editLanguage}
        contentFormat={editContentFormat}
        lastActivity={
          episodesList.length > 0
            ? episodesList
                .map((ep) => ep.updated_at)
                .sort()
                .reverse()[0] ?? null
            : null
        }
        onApplyTemplate={() => void openApplyTemplateDialog()}
        onSaveAsTemplate={() => void handleSaveAsTemplate()}
        savingAsTemplate={savingAsTemplate}
        saveTemplateSuccess={saveTemplateSuccess}
        onDelete={() => setDeleteDialogOpen(true)}
      />

      {/* Basics card — the fields that were crammed into the old header
          get their own surface so the hero stays scannable. */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Basics</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Select
            label="Target Duration"
            value={editDuration}
            onChange={(e) => setEditDuration(e.target.value)}
            options={[
              { value: '15', label: '15 seconds' },
              { value: '30', label: '30 seconds' },
              { value: '60', label: '60 seconds' },
            ]}
          />
          <Select
            label="Language"
            value={editLanguage}
            onChange={(e) => setEditLanguage(e.target.value)}
            hint="Narration language. Visual prompts stay in English."
            options={LANGUAGE_OPTIONS}
          />
          <Input
            label="Character Description"
            value={editCharacter}
            onChange={(e) => setEditCharacter(e.target.value)}
            placeholder="Leave empty for landscape / abstract topics..."
            hint="Only needed when the series features a recurring character"
          />
        </div>
      </Card>

      {/* Visual Style Section */}
      <section id="section-visual" />
      <CollapsibleSection
        title="Visual Style"
        icon={Palette}
        defaultOpen={false}
      >
        <div className="mt-3 space-y-3">
          <VisualStylePresetPopover
            presets={VISUAL_STYLE_PRESETS}
            currentValue={editStyle}
            onPick={(v) => setEditStyle(v)}
          />
          <Textarea
            label="Style Prompt"
            value={editStyle}
            onChange={(e) => setEditStyle(e.target.value)}
            placeholder="Describe the visual aesthetic: color palette, lighting, mood, art style..."
            hint="Picking a preset fills this in — you can still tweak the wording freely."
            rows={3}
          />
        </div>
      </CollapsibleSection>

      {/* Caption Style Section */}
      <section id="section-captions" />
      <CollapsibleSection
        title="Caption Style"
        icon={Subtitles}
        defaultOpen={false}
      >
        <div className="mt-3">
          <CaptionStyleEditor
            value={editCaptionStyle}
            onChange={setEditCaptionStyle}
          />
        </div>
      </CollapsibleSection>

      {/* Music Section */}
      <section id="section-audio" />
      <CollapsibleSection title="Background Music" icon={Music} defaultOpen={false}>
        <div className="mt-3 space-y-4">
          {/* Enable / disable toggle */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setEditMusicEnabled((v) => !v)}
              className={[
                'relative w-9 h-5 rounded-full transition-colors duration-fast',
                editMusicEnabled ? 'bg-accent' : 'bg-bg-active',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-fast',
                  editMusicEnabled ? 'translate-x-4' : 'translate-x-0.5',
                ].join(' ')}
              />
            </button>
            <label className="text-sm font-medium text-txt-primary">
              Enable background music
            </label>
          </div>

          {editMusicEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label="Mood"
                value={editMusicMood}
                onChange={(e) => setEditMusicMood(e.target.value)}
                options={MUSIC_MOODS}
              />
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-txt-secondary">
                  Volume: {editMusicVolume} dB
                </label>
                <div className="flex items-center gap-3 h-8">
                  <input
                    type="range"
                    min={-20}
                    max={-6}
                    step={1}
                    value={editMusicVolume}
                    onChange={(e) =>
                      setEditMusicVolume(Number(e.target.value))
                    }
                    className="w-full accent-accent h-1.5 bg-bg-elevated rounded-full appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                      [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm
                      [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-bg-base"
                  />
                  <span className="text-xs text-txt-tertiary font-mono w-10 text-right shrink-0">
                    {editMusicVolume} dB
                  </span>
                </div>
                <p className="text-[10px] text-txt-tertiary">
                  Lower values make the music quieter relative to narration
                </p>
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* YouTube Channel Section */}
      <section id="section-publish" />
      {youtubeChannels.length > 0 && (
        <CollapsibleSection
          title="YouTube Channel"
          icon={Video}
          defaultOpen={false}
        >
          <div className="mt-3">
            <label className="text-xs font-medium text-txt-secondary block mb-2">
              Upload to Channel
            </label>
            <select
              value={editYoutubeChannelId}
              onChange={(e) => setEditYoutubeChannelId(e.target.value)}
              className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-txt-primary"
            >
              <option value="">No channel assigned</option>
              {youtubeChannels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.channel_name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-txt-tertiary mt-1.5">
              Episodes in this series will upload to the selected channel.
            </p>
          </div>
        </CollapsibleSection>
      )}

      {/* Content Format Section */}
      <section id="section-format" />
      <CollapsibleSection
        title="Content Format"
        icon={Film}
        defaultOpen={editContentFormat === 'longform'}
      >
        <div className="mt-3 space-y-4">
          {/* 4-way icon segmented control */}
          <div>
            <label className="text-xs font-medium text-txt-secondary block mb-2">
              Format
            </label>
            <div className="inline-flex w-full rounded-lg border border-border bg-bg-elevated p-1">
              {(
                [
                  {
                    id: 'shorts',
                    label: 'Shorts',
                    sub: '9:16',
                    aspect: '9:16',
                    icon: Smartphone,
                  },
                  {
                    id: 'longform',
                    label: 'Long-form',
                    sub: '16:9',
                    aspect: '16:9',
                    icon: Monitor,
                  },
                  {
                    id: 'music_video',
                    label: 'Music',
                    sub: '9:16',
                    aspect: '9:16',
                    icon: Music2,
                  },
                  {
                    id: 'animation',
                    label: 'Animation',
                    sub: '16:9',
                    aspect: '16:9',
                    icon: Shapes,
                  },
                ] as const
              ).map((fmt) => {
                const active = editContentFormat === fmt.id;
                const Icon = fmt.icon;
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => {
                      setEditContentFormat(fmt.id);
                      setEditAspectRatio(fmt.aspect);
                    }}
                    className={[
                      'flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-all duration-fast',
                      active
                        ? 'bg-accent-muted text-accent shadow-sm'
                        : 'text-txt-secondary hover:bg-bg-hover hover:text-txt-primary',
                    ].join(' ')}
                    aria-pressed={active}
                  >
                    <Icon size={13} />
                    <span className="hidden sm:inline">{fmt.label}</span>
                    <span className="text-[10px] text-txt-muted">
                      {fmt.sub}
                    </span>
                  </button>
                );
              })}
            </div>
            {editContentFormat === 'music_video' && (
              <p className="mt-2 text-[11px] text-txt-tertiary">
                Music videos use an AI lyric + song generator (ACE Step /
                lyric-aware) for the backing track, then beat-match scene cuts
                to the song.
              </p>
            )}
            {editContentFormat === 'animation' && (
              <p className="mt-2 text-[11px] text-txt-tertiary">
                Animation routes scenes through the animation-tagged ComfyUI
                workflow (e.g. AnimateDiff / anime-style Wan) with voice +
                music composited in.
              </p>
            )}
          </div>

          {/* Longform options — expand with a height transition so the
              shift is obvious when the user flips formats. */}
          <div
            className={[
              'overflow-hidden transition-all duration-slow',
              editContentFormat === 'longform'
                ? 'max-h-[2400px] opacity-100'
                : 'max-h-0 opacity-0',
            ].join(' ')}
            aria-hidden={editContentFormat !== 'longform'}
          >
            <div className="space-y-4 pt-1">
              <div>
                <label className="text-xs font-medium text-txt-secondary block mb-1">Target Duration</label>
                <select
                  value={editTargetMinutes}
                  onChange={(e) => setEditTargetMinutes(Number(e.target.value))}
                  className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-txt-primary"
                >
                  {[15, 20, 30, 45, 60, 90, 120].map((m) => (
                    <option key={m} value={m}>{m} minutes</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-txt-secondary block mb-1">Scenes per Chapter</label>
                <select
                  value={editScenesPerChapter}
                  onChange={(e) => setEditScenesPerChapter(Number(e.target.value))}
                  className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-txt-primary"
                >
                  {[4, 6, 8, 10, 12, 15].map((n) => (
                    <option key={n} value={n}>{n} scenes</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-txt-secondary block mb-1">Aspect Ratio</label>
                <div className="flex gap-2">
                  {[
                    { value: '16:9', label: '16:9 Landscape' },
                    { value: '9:16', label: '9:16 Portrait' },
                    { value: '1:1', label: '1:1 Square' },
                  ].map((ar) => (
                    <button
                      key={ar.value}
                      type="button"
                      onClick={() => setEditAspectRatio(ar.value)}
                      className={[
                        'flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors duration-fast text-center',
                        editAspectRatio === ar.value
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover',
                      ].join(' ')}
                    >
                      {ar.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-txt-secondary block mb-1">
                  Visual Consistency Prompt
                </label>
                <textarea
                  value={editVisualConsistency}
                  onChange={(e) => setEditVisualConsistency(e.target.value)}
                  placeholder="Style prompt appended to every scene for visual consistency (e.g., 'cinematic 4K, warm color grading, anime style')"
                  className="w-full min-h-[60px] px-3 py-2 text-sm bg-bg-elevated border border-border rounded-lg text-txt-primary placeholder:text-txt-tertiary resize-y"
                />
              </div>

              {/* Phase E — Character + Style locks */}
              <div className="border-t border-white/[0.04] pt-4 space-y-4">
                <div>
                  <div className="text-xs font-semibold text-txt-primary mb-1">
                    Character reference lock
                  </div>
                  <p className="text-[11px] text-txt-muted mb-2">
                    Pin a face or character across scenes. Pick portrait
                    assets from your library — workflows with
                    IPAdapter-FaceID slots consume them; others ignore them.
                  </p>
                  <AssetLockPicker
                    ids={editCharacterAssetIds}
                    onChange={setEditCharacterAssetIds}
                    title="Pick character reference images"
                  />
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <label className="text-[11px] text-txt-secondary">
                      Strength ({editCharacterStrength.toFixed(2)})
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={editCharacterStrength}
                        onChange={(e) =>
                          setEditCharacterStrength(parseFloat(e.target.value))
                        }
                        className="w-full"
                      />
                    </label>
                    <label className="text-[11px] text-txt-secondary">
                      LoRA (optional)
                      <input
                        type="text"
                        value={editCharacterLora}
                        onChange={(e) => setEditCharacterLora(e.target.value)}
                        placeholder="sdxl_face_v2"
                        className="w-full px-2 py-1 text-xs bg-bg-elevated border border-border rounded text-txt-primary"
                      />
                    </label>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold text-txt-primary mb-1">
                    Style reference lock
                  </div>
                  <p className="text-[11px] text-txt-muted mb-2">
                    Pin a look (lighting, palette, film grain). Same
                    picker, separate strength.
                  </p>
                  <AssetLockPicker
                    ids={editStyleAssetIds}
                    onChange={setEditStyleAssetIds}
                    title="Pick style reference images"
                  />
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <label className="text-[11px] text-txt-secondary">
                      Strength ({editStyleStrength.toFixed(2)})
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={editStyleStrength}
                        onChange={(e) =>
                          setEditStyleStrength(parseFloat(e.target.value))
                        }
                        className="w-full"
                      />
                    </label>
                    <label className="text-[11px] text-txt-secondary">
                      LoRA (optional)
                      <input
                        type="text"
                        value={editStyleLora}
                        onChange={(e) => setEditStyleLora(e.target.value)}
                        placeholder="sdxl_style_v2"
                        className="w-full px-2 py-1 text-xs bg-bg-elevated border border-border rounded text-txt-primary"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Scene Mode Section */}
      <section id="section-generation" />
      <CollapsibleSection
        title="Scene Mode"
        icon={Video}
        defaultOpen={false}
      >
        <div className="mt-3 space-y-4">
          {/* Image / Video radio buttons */}
          <div>
            <label className="text-xs font-medium text-txt-secondary block mb-2">
              Generation Mode
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditSceneMode('image')}
                className={[
                  'flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-fast text-center',
                  editSceneMode === 'image'
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover',
                ].join(' ')}
              >
                Image (Ken Burns)
              </button>
              <button
                type="button"
                onClick={() => setEditSceneMode('video')}
                className={[
                  'flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-fast text-center',
                  editSceneMode === 'video'
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover',
                ].join(' ')}
              >
                Video (Wan 2.6)
              </button>
            </div>
          </div>

          {editSceneMode === 'image' && (
            <p className="text-xs text-txt-tertiary">
              Each scene is generated as a still image. The final video uses Ken Burns
              zoom/pan effects with crossfade transitions between scenes.
            </p>
          )}

          {editSceneMode === 'video' && (
            <>
              <Select
                label="Video Workflow"
                value={editVideoWorkflowId}
                onChange={(e) => setEditVideoWorkflowId(e.target.value)}
                options={[
                  { value: '', label: 'Select a video workflow...' },
                  ...workflows.map((wf) => ({
                    value: wf.id,
                    label: wf.name + (wf.description ? ` - ${wf.description}` : ''),
                  })),
                ]}
                hint="Select a ComfyUI workflow for text-to-video generation (e.g. Wan 2.6)"
              />
              <p className="text-xs text-txt-tertiary">
                Each scene is generated as a ~5 second video clip via the selected workflow.
                Clips are concatenated with voiceover and subtitles. Video generation uses
                significantly more API tokens than image mode.
              </p>
            </>
          )}
        </div>
      </CollapsibleSection>

      {/* Episodes section (v0.20.31 redesign) */}
      <section id="section-episodes" />
      <EpisodesSection
        episodes={episodesList}
        onCreate={() => setCreateDialogOpen(true)}
        onGenerateAllDrafts={() => void handleGenerateAllDrafts()}
        onAiAdd={() => void handleAddEpisodesAi()}
        onTrending={() => void handleTrendingTopics()}
        onDeleteAll={() => setDeleteAllEpisodesOpen(true)}
        generatingAllDrafts={generatingAllDrafts}
        addingEpisodesAi={addingEpisodesAi}
        trendingLoading={trendingLoading}
      />

        </div> {/* end right column */}
      </div> {/* end two-column grid */}

      {/* Create Episode Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        title="Create New Episode"
        description={`Add a new episode to "${seriesData.name}"`}
      >
        <div className="space-y-4">
          <Input
            label="Title"
            placeholder="Episode title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            autoFocus
          />
          <Textarea
            label="Topic"
            placeholder="What should this episode be about?"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCreateDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={creatingEpisode}
            disabled={!newTitle.trim()}
            onClick={() => void handleCreateEpisode()}
          >
            Create Episode
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        title="Delete Series"
        description="This will permanently delete the series and all its episodes. This action cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deleting}
            onClick={() => void handleDelete()}
          >
            <Trash2 size={14} />
            Delete Series
          </Button>
        </DialogFooter>
      </Dialog>

      {/* A/B tests panel */}
      {seriesId && (
        <div className="mt-6">
          <ABTestsPanel seriesId={seriesId} />
        </div>
      )}

      {/* Delete All Episodes dialog */}
      <Dialog
        open={deleteAllEpisodesOpen}
        onClose={() => setDeleteAllEpisodesOpen(false)}
        title="Delete All Episodes"
        description={`Delete all ${episodesList.length} episodes from this series? This removes all generated media. The series itself will be kept.`}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteAllEpisodesOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deletingAllEpisodes}
            onClick={async () => {
              setDeletingAllEpisodes(true);
              try {
                await Promise.all(episodesList.map(ep => episodesApi.delete(ep.id)));
                toast.success('All episodes deleted');
                setDeleteAllEpisodesOpen(false);
                void fetchData();
              } catch (err) {
                toast.error('Failed to delete all episodes', { description: String(err) });
              } finally { setDeletingAllEpisodes(false); }
            }}
          >
            <Trash2 size={14} />
            Delete All ({episodesList.length})
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Apply Template dialog */}
      <Dialog
        open={applyTemplateOpen}
        onClose={() => setApplyTemplateOpen(false)}
        title="Apply Template"
        description="Select a template to apply its settings to this series. Your current settings will be replaced."
      >
        <div
          className="space-y-3 max-h-[420px] overflow-y-auto"
          aria-busy={loadingTemplates}
          aria-live="polite"
        >
          {loadingTemplates && (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          )}
          {!loadingTemplates && availableTemplates.length === 0 && (
            <div className="text-center py-8">
              <LayoutTemplate size={28} className="mx-auto text-txt-tertiary mb-2" />
              <p className="text-sm text-txt-secondary">No templates found.</p>
              <p className="text-xs text-txt-tertiary mt-1">
                Create templates in Settings &rarr; Templates.
              </p>
            </div>
          )}
          {!loadingTemplates &&
            availableTemplates.map((tmpl) => (
              <button
                key={tmpl.id}
                type="button"
                disabled={applyingTemplateId !== null}
                onClick={() => void handleApplyTemplate(tmpl.id)}
                className="w-full text-left rounded-lg border border-border bg-bg-elevated hover:bg-bg-hover hover:border-accent/40 transition-colors duration-fast p-3 space-y-2 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg-base"
                aria-label={`Apply template ${tmpl.name}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <LayoutTemplate size={13} className="text-accent shrink-0" />
                    <span className="text-sm font-semibold text-txt-primary truncate">
                      {tmpl.name}
                    </span>
                    {tmpl.is_default && (
                      <Badge variant="accent" className="text-[9px] shrink-0">
                        Default
                      </Badge>
                    )}
                  </div>
                  {applyingTemplateId === tmpl.id && <Spinner size="sm" />}
                </div>
                {tmpl.description && (
                  <p className="text-xs text-txt-secondary line-clamp-2">
                    {tmpl.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {tmpl.caption_style && (
                    <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-medium">
                      {tmpl.caption_style}
                    </span>
                  )}
                  {tmpl.music_mood && (
                    <span className="px-1.5 py-0.5 rounded bg-bg-active text-txt-secondary text-[10px]">
                      {tmpl.music_mood}
                    </span>
                  )}
                  {tmpl.target_duration_seconds && (
                    <span className="px-1.5 py-0.5 rounded bg-bg-active text-txt-secondary text-[10px]">
                      {tmpl.target_duration_seconds}s
                    </span>
                  )}
                </div>
              </button>
            ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setApplyTemplateOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Trending Topics dialog */}
      <Dialog
        open={trendingOpen}
        onClose={() => setTrendingOpen(false)}
        title="Trending Topic Ideas"
      >
        <div className="space-y-3 max-h-[400px] overflow-y-auto">
          {trendingTopics.length === 0 ? (
            <p className="text-sm text-txt-secondary text-center py-6">
              No topic ideas returned.
            </p>
          ) : (
            trendingTopics.map((t, i) => (
              <Card key={i} padding="sm" className="space-y-1">
                <p className="text-sm font-semibold text-txt-primary">{t.title}</p>
                {t.angle && (
                  <p className="text-xs text-txt-secondary">{t.angle}</p>
                )}
                {t.hook && (
                  <p className="text-xs text-accent italic">Hook: &quot;{t.hook}&quot;</p>
                )}
                {t.estimated_engagement && (
                  <Badge
                    variant={
                      t.estimated_engagement === 'high'
                        ? 'success'
                        : t.estimated_engagement === 'medium'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {t.estimated_engagement} engagement
                  </Badge>
                )}
              </Card>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setTrendingOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ─── AssetLockPicker ──────────────────────────────────────────────
//
// Small helper that renders selected asset thumbnails + a "Pick
// assets" button. ``ids`` is the comma-separated string the save
// payload already uses, so plugging this in didn't require the
// parent to track an array separately.

// ─────────────────────────────────────────────────────────────────
// EpisodesSection (v0.20.31)
//
// Status-grouped "kanban-lite" view with a toggle back to the flat
// grid for users who prefer it. Pulls quick-action buttons into a
// compact toolbar at the top so scattered generate / AI-add /
// trending / delete-all all live in one predictable spot. Empty
// state stays the same.
// ─────────────────────────────────────────────────────────────────

interface EpisodesSectionProps {
  episodes: EpisodeListItem[];
  onCreate: () => void;
  onGenerateAllDrafts: () => void;
  onAiAdd: () => void;
  onTrending: () => void;
  onDeleteAll: () => void;
  generatingAllDrafts: boolean;
  addingEpisodesAi: boolean;
  trendingLoading: boolean;
}

// Human-friendly order + labels + colors for the status columns.
// Statuses not in the list (e.g. "editing") land in "Other" so a new
// status added server-side doesn't silently disappear from the UI.
const EPISODE_STATUS_COLUMNS: Array<{
  id: string;
  label: string;
  statuses: string[];
  color: string;
}> = [
  { id: 'draft', label: 'Draft', statuses: ['draft'], color: 'text-txt-secondary' },
  {
    id: 'generating',
    label: 'Generating',
    statuses: ['generating', 'queued'],
    color: 'text-info',
  },
  {
    id: 'review',
    label: 'Review',
    statuses: ['review', 'editing'],
    color: 'text-warning',
  },
  {
    id: 'exported',
    label: 'Exported',
    statuses: ['exported', 'done', 'uploaded'],
    color: 'text-success',
  },
];

function EpisodesSection({
  episodes,
  onCreate,
  onGenerateAllDrafts,
  onAiAdd,
  onTrending,
  onDeleteAll,
  generatingAllDrafts,
  addingEpisodesAi,
  trendingLoading,
}: EpisodesSectionProps) {
  const [view, setView] = useState<'kanban' | 'grid'>('kanban');
  const [failedOpen, setFailedOpen] = useState(true);

  const draftCount = episodes.filter((ep) => ep.status === 'draft').length;

  // Bucket episodes into the kanban columns. Failed episodes get
  // their own row underneath the columns rather than disappearing
  // into an "Other" bucket.
  const columns = EPISODE_STATUS_COLUMNS.map((col) => ({
    ...col,
    items: episodes.filter((ep) => col.statuses.includes(ep.status)),
  }));
  const failedEpisodes = episodes.filter((ep) => ep.status === 'failed');
  const uncategorized = episodes.filter(
    (ep) =>
      !EPISODE_STATUS_COLUMNS.some((c) => c.statuses.includes(ep.status)) &&
      ep.status !== 'failed',
  );

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-txt-primary">
            Episodes ({episodes.length})
          </h2>
          <p className="mt-1 text-sm text-txt-tertiary">
            {episodes.length === 0
              ? 'No episodes yet — create one or generate ideas.'
              : `${draftCount} draft${draftCount !== 1 ? 's' : ''} · ${episodes.length - draftCount} in progress or done`}
          </p>
        </div>

        <div className="inline-flex items-center rounded-md border border-border bg-bg-elevated p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setView('kanban')}
            className={[
              'flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors duration-fast',
              view === 'kanban'
                ? 'bg-accent-muted text-accent'
                : 'text-txt-tertiary hover:text-txt-primary',
            ].join(' ')}
            aria-pressed={view === 'kanban'}
            title="Group by status"
          >
            <Columns3 size={12} />
            Kanban
          </button>
          <button
            type="button"
            onClick={() => setView('grid')}
            className={[
              'flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors duration-fast',
              view === 'grid'
                ? 'bg-accent-muted text-accent'
                : 'text-txt-tertiary hover:text-txt-primary',
            ].join(' ')}
            aria-pressed={view === 'grid'}
            title="Flat grid"
          >
            <LayoutGrid size={12} />
            Grid
          </button>
        </div>
      </div>

      {/* Quick Actions toolbar */}
      <div className="mb-4 flex items-center flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={onCreate}>
          <Plus size={14} />
          New Episode
        </Button>
        {draftCount > 0 && (
          <Button
            variant="secondary"
            size="sm"
            loading={generatingAllDrafts}
            onClick={onGenerateAllDrafts}
          >
            <Play size={14} />
            Generate {draftCount} draft{draftCount !== 1 ? 's' : ''}
          </Button>
        )}
        <Button variant="secondary" size="sm" loading={addingEpisodesAi} onClick={onAiAdd}>
          <Sparkles size={14} />
          AI add 5
        </Button>
        <Button variant="secondary" size="sm" loading={trendingLoading} onClick={onTrending}>
          <TrendingUp size={14} />
          Trending
        </Button>
        {episodes.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-txt-tertiary hover:text-error"
            onClick={onDeleteAll}
          >
            <Trash2 size={14} />
            Delete All
          </Button>
        )}
      </div>

      {episodes.length === 0 ? (
        <div className="empty-state py-12">
          <Film size={36} />
          <p className="text-sm">No episodes in this series</p>
          <Button variant="primary" size="sm" className="mt-3" onClick={onCreate}>
            <Plus size={14} />
            Create First Episode
          </Button>
        </div>
      ) : view === 'kanban' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {columns.map((col) => (
              <div
                key={col.id}
                className="rounded-lg border border-border bg-bg-elevated/40 p-3 min-h-[180px]"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span
                    className={`text-xs font-semibold uppercase tracking-wider ${col.color}`}
                  >
                    {col.label}
                  </span>
                  <span className="text-[11px] text-txt-tertiary">
                    {col.items.length}
                  </span>
                </div>
                {col.items.length === 0 ? (
                  <p className="text-[11px] text-txt-muted py-6 text-center">
                    Nothing here.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {col.items.map((ep) => (
                      <EpisodeCard key={ep.id} episode={ep} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {(failedEpisodes.length > 0 || uncategorized.length > 0) && (
            <div className="rounded-lg border border-error/20 bg-error/5 p-3">
              <button
                type="button"
                onClick={() => setFailedOpen((v) => !v)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="text-xs font-semibold uppercase tracking-wider text-error">
                  {failedEpisodes.length > 0
                    ? `Failed (${failedEpisodes.length})`
                    : `Other (${uncategorized.length})`}
                </span>
                {failedOpen ? (
                  <ChevronDown size={14} className="text-txt-tertiary" />
                ) : (
                  <ChevronRight size={14} className="text-txt-tertiary" />
                )}
              </button>
              {failedOpen && (
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  {[...failedEpisodes, ...uncategorized].map((ep) => (
                    <EpisodeCard key={ep.id} episode={ep} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {episodes.map((ep) => (
            <EpisodeCard key={ep.id} episode={ep} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetLockPicker({
  ids,
  onChange,
  title,
}: {
  ids: string;
  onChange: (next: string) => void;
  title: string;
}) {
  const parsed = ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      {parsed.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {parsed.map((id) => (
            <div
              key={id}
              className="relative w-14 h-14 rounded border border-white/[0.06] overflow-hidden group"
              title={id}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/v1/assets/${id}/file`}
                alt=""
                className="w-full h-full object-cover"
              />
              <button
                onClick={() => {
                  const next = parsed.filter((x) => x !== id).join(', ');
                  onChange(next);
                }}
                className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[10px] transition-opacity"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-txt-muted">No reference assets selected.</div>
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-accent hover:underline"
      >
        {parsed.length > 0 ? 'Change reference assets…' : 'Pick reference assets…'}
      </button>
      {open && (
        <AssetPicker
          open
          onClose={() => setOpen(false)}
          onSelect={(next) => onChange(next.join(', '))}
          kind="image"
          initialSelectedIds={parsed}
          title={title}
        />
      )}
    </div>
  );
}

export default SeriesDetail;
