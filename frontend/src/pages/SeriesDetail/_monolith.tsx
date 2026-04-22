import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useUnsavedWarning } from '@/hooks/useUnsavedWarning';
import {
  ArrowLeft,
  Plus,
  Save,
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  // Warn about unsaved settings changes
  const hasUnsavedSettings = useMemo(() => {
    if (!seriesData) return false;
    return (
      editName !== seriesData.name ||
      editDescription !== (seriesData.description ?? '') ||
      editDuration !== String(seriesData.target_duration_seconds) ||
      editStyle !== (seriesData.visual_style ?? '') ||
      editCharacter !== (seriesData.character_description ?? '') ||
      editMusicEnabled !== seriesData.music_enabled ||
      editSceneMode !== (seriesData.scene_mode ?? 'image')
    );
  }, [seriesData, editName, editDescription, editDuration, editStyle, editCharacter, editMusicEnabled, editSceneMode]);
  useUnsavedWarning(hasUnsavedSettings);

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

  const handleSave = async () => {
    if (!seriesId) return;
    setSaving(true);
    try {
      await seriesApi.update(seriesId, {
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
        target_duration_minutes: editContentFormat === 'longform' ? editTargetMinutes : undefined,
        scenes_per_chapter: editContentFormat === 'longform' ? editScenesPerChapter : undefined,
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
      } as any);
      toast.success('Series saved');
      void fetchData();
    } catch (err) {
      toast.error('Failed to save series', { description: String(err) });
    } finally {
      setSaving(false);
    }
  };

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

  return (
    <div className="space-y-6">
      {/* Breadcrumb + Back */}
      <Breadcrumb
        items={[
          { label: 'Series', to: '/series' },
          { label: editName || seriesData.name || 'Series Detail' },
        ]}
      />

      {/* Series info header */}
      <Card padding="lg">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 space-y-4">
            <Input
              label="Series Name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
            <Textarea
              label="Description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Describe this series..."
            />
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
                placeholder="Leave empty for landscape / space / abstract topics..."
                hint="Only needed when the series features a specific recurring character"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-txt-secondary">
                  Visual Style
                </label>
                <span className="text-[10px] text-txt-tertiary">
                  Click a preset to apply
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {VISUAL_STYLE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setEditStyle(preset.value)}
                    className={[
                      'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors duration-fast',
                      editStyle === preset.value
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover hover:text-txt-primary',
                    ].join(' ')}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <Textarea
                value={editStyle}
                onChange={(e) => setEditStyle(e.target.value)}
                placeholder="Describe the visual aesthetic: color palette, lighting, mood, art style..."
                rows={2}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-txt-tertiary">
            <Badge variant="neutral">
              <Clock size={10} />
              {seriesData.target_duration_seconds}s
            </Badge>
            <Badge variant="neutral">
              <Film size={10} />
              {episodesList.length} episodes
            </Badge>
            <span>Language: {seriesData.default_language}</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Apply Template */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void openApplyTemplateDialog()}
              title="Apply a saved template to this series"
            >
              <LayoutTemplate size={14} />
              Apply Template
            </Button>

            {/* Save as Template */}
            {saveTemplateSuccess ? (
              <Button variant="secondary" size="sm" disabled>
                <CheckCircle2 size={14} className="text-success" />
                Saved!
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={savingAsTemplate}
                onClick={() => void handleSaveAsTemplate()}
                title="Save current settings as a reusable template"
              >
                <LayoutTemplate size={14} />
                Save as Template
              </Button>
            )}

            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          </div>
        </div>
      </Card>

      {/* Caption Style Section */}
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
      <CollapsibleSection
        title="Content Format"
        icon={Film}
        defaultOpen={editContentFormat === 'longform'}
      >
        <div className="mt-3 space-y-4">
          <div>
            <label className="text-xs font-medium text-txt-secondary block mb-2">Format</label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: 'shorts',      label: 'Shorts (9:16)',     aspect: '9:16' },
                  { id: 'longform',    label: 'Long-Form (16:9)',  aspect: '16:9' },
                  { id: 'music_video', label: 'Music Video',       aspect: '9:16' },
                  { id: 'animation',   label: 'Animation',         aspect: '16:9' },
                ] as const
              ).map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => {
                    setEditContentFormat(fmt.id);
                    setEditAspectRatio(fmt.aspect);
                  }}
                  className={[
                    'px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors duration-fast text-center',
                    editContentFormat === fmt.id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover',
                  ].join(' ')}
                >
                  {fmt.label}
                </button>
              ))}
            </div>
            {editContentFormat === 'music_video' && (
              <p className="mt-2 text-[11px] text-txt-tertiary">
                Music videos use an AI lyric + song generator (ACE Step / lyric-aware)
                for the backing track, then beat-match scene cuts to the song.
              </p>
            )}
            {editContentFormat === 'animation' && (
              <p className="mt-2 text-[11px] text-txt-tertiary">
                Animation routes scenes through the animation-tagged ComfyUI workflow
                (e.g. AnimateDiff / anime-style Wan) with voice + music composited in.
              </p>
            )}
          </div>

          {editContentFormat === 'longform' && (
            <>
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
                    Pin a face or character across scenes. Upload portrait
                    assets on the Assets page and paste their UUIDs here.
                    Workflows with IPAdapter-FaceID slots consume these;
                    others ignore them.
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
                    Pin a look (lighting, palette, film grain). Same asset-UUIDs-plus-strength pattern.
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
            </>
          )}
        </div>
      </CollapsibleSection>

      {/* Scene Mode Section */}
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

      {/* Global save button */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="lg"
          loading={saving}
          onClick={() => void handleSave()}
        >
          <Save size={16} />
          Save All Changes
        </Button>
      </div>

      {/* Episodes section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold text-txt-primary">
              Episodes ({episodesList.length})
            </h2>
            {episodesList.length > 0 && (
              <p className="mt-1 text-sm text-txt-tertiary">
                {episodesList.length} episode{episodesList.length !== 1 ? 's' : ''}
                {(() => {
                  const counts: Record<string, number> = {};
                  for (const ep of episodesList) {
                    counts[ep.status] = (counts[ep.status] ?? 0) + 1;
                  }
                  const parts = Object.entries(counts).map(
                    ([status, count]) => `${count} ${status}`,
                  );
                  return parts.length > 0 ? `: ${parts.join(', ')}` : '';
                })()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {episodesList.filter((ep) => ep.status === 'draft').length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                loading={generatingAllDrafts}
                onClick={() => void handleGenerateAllDrafts()}
              >
                <Play size={14} />
                Generate All Draft ({episodesList.filter((ep) => ep.status === 'draft').length})
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              loading={addingEpisodesAi}
              onClick={() => void handleAddEpisodesAi()}
              title="Generate 5 new episode ideas using AI"
            >
              <Sparkles size={14} />
              AI Add Episodes
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={trendingLoading}
              onClick={() => void handleTrendingTopics()}
              title="Get trending topic ideas for this series"
            >
              <TrendingUp size={14} />
              Trending Ideas
            </Button>
            {episodesList.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-txt-tertiary hover:text-error"
                onClick={() => setDeleteAllEpisodesOpen(true)}
              >
                <Trash2 size={14} />
                Delete All
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus size={14} />
              Create Episode
            </Button>
          </div>
        </div>

        {episodesList.length === 0 ? (
          <div className="empty-state py-12">
            <Film size={36} />
            <p className="text-sm">No episodes in this series</p>
            <Button
              variant="primary"
              size="sm"
              className="mt-3"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus size={14} />
              Create First Episode
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {episodesList.map((ep) => (
              <EpisodeCard key={ep.id} episode={ep} />
            ))}
          </div>
        )}
      </div>

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
