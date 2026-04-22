// =============================================================================
// Drevalis Creator Studio API Client
// Typed fetch wrapper for all backend CRUD operations.
// =============================================================================

import type {
  Series,
  SeriesCreate,
  SeriesUpdate,
  SeriesListItem,
  SeriesGenerateResponse,
  Episode,
  EpisodeCreate,
  EpisodeUpdate,
  EpisodeListItem,
  GenerateRequest,
  GenerateResponse,
  RetryResponse,
  ScriptUpdate,
  VoiceProfile,
  VoiceProfileCreate,
  VoiceProfileUpdate,
  VoiceTestResponse,
  ComfyUIServer,
  ComfyUIServerCreate,
  ComfyUIServerUpdate,
  ComfyUIServerTestResponse,
  ComfyUIWorkflow,
  ComfyUIWorkflowCreate,
  ComfyUIWorkflowUpdate,
  LLMConfig,
  LLMConfigCreate,
  LLMConfigUpdate,
  LLMTestResponse,
  PromptTemplate,
  PromptTemplateCreate,
  PromptTemplateUpdate,
  GenerationJob,
  GenerationJobExtended,
  GenerationJobListItem,
  StorageUsage,
  HealthCheck,
  FFmpegInfo,
  Audiobook,
  AudiobookCreate,
  YouTubeChannel,
  YouTubeUpload,
  YouTubeUploadRequest,
  YouTubePlaylist,
  YouTubeVideoStats,
  VideoEditPayload,
  VideoEditResult,
} from '@/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public detail?: string,
    public detailRaw?: unknown,
  ) {
    super(detail ?? `${status} ${statusText}`);
    this.name = 'ApiError';
  }

  /** Safe string representation — never returns `[object Object]`. */
  override toString(): string {
    return `${this.name} (${this.status}): ${this.message}`;
  }
}

/**
 * Extract a human-readable message from any caught value.
 *
 * Fixes the `[object Object]` bug where `String(err)` on a custom
 * Error with a non-string payload produces `[object Object]`.
 */
export function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.toString();
  }
  if (err instanceof Error) {
    return err.message || err.toString();
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Core fetch helpers
// ---------------------------------------------------------------------------

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    let detail: string | undefined;
    let detailRaw: unknown;
    try {
      const body = await response.json();
      const rawDetail = body?.detail;
      detailRaw = rawDetail ?? body;
      if (typeof rawDetail === 'string') {
        detail = rawDetail;
      } else if (rawDetail && typeof rawDetail === 'object') {
        detail = JSON.stringify(rawDetail);
      } else {
        detail = JSON.stringify(body);
      }
    } catch {
      detail = response.statusText;
    }
    if (response.status === 402 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('license-gate-triggered', { detail }));
    }
    throw new ApiError(response.status, response.statusText, detail, detailRaw);
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function del<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const health = {
  check: () => get<{ status: string; version: string }>('/api/v1/health'),
};

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

export const series = {
  list: () => get<SeriesListItem[]>('/api/v1/series'),

  get: (id: string) => get<Series>(`/api/v1/series/${id}`),

  create: (data: SeriesCreate) => post<Series>('/api/v1/series', data),

  update: (id: string, data: SeriesUpdate) =>
    put<Series>(`/api/v1/series/${id}`, data),

  delete: (id: string) => del(`/api/v1/series/${id}`),

  generate: (data: {
    idea: string;
    episode_count?: number;
    target_duration_seconds?: number;
    voice_profile_id?: string;
    llm_config_id?: string;
  }) =>
    post<{ job_id: string; status: string }>('/api/v1/series/generate', data),

  getGenerateJob: (jobId: string) =>
    get<{
      job_id: string;
      status: string;
      result: SeriesGenerateResponse | null;
      error: string | null;
    }>(`/api/v1/series/generate-job/${jobId}`),

  cancelGenerateJob: (jobId: string) =>
    post<{ message: string }>(`/api/v1/series/generate-job/${jobId}/cancel`, {}),

  addEpisodesAi: (seriesId: string, count: number = 5) =>
    post<{ message: string; episode_ids: string[]; episodes: Array<{ title: string; topic: string }> }>(
      `/api/v1/series/${seriesId}/add-episodes`,
      { count },
    ),

  trendingTopics: (seriesId: string) =>
    post<{ series_id: string; topics: Array<{ title: string; angle?: string; hook?: string; estimated_engagement?: string }> }>(
      `/api/v1/series/${seriesId}/trending-topics`,
    ),
};

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export const episodes = {
  list: (params?: { series_id?: string; status?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.series_id) query.set('series_id', params.series_id);
    if (params?.status) query.set('status', params.status);
    query.set('limit', String(params?.limit ?? 500));
    const qs = query.toString();
    return get<EpisodeListItem[]>(`/api/v1/episodes${qs ? `?${qs}` : ''}`);
  },

  recent: (limit = 10) =>
    get<EpisodeListItem[]>(`/api/v1/episodes/recent?limit=${limit}`),

  get: (id: string) => get<Episode>(`/api/v1/episodes/${id}`),

  create: (data: EpisodeCreate) => post<Episode>('/api/v1/episodes', data),

  update: (id: string, data: EpisodeUpdate) =>
    put<Episode>(`/api/v1/episodes/${id}`, data),

  delete: (id: string) => del(`/api/v1/episodes/${id}`),

  generate: (id: string, data?: GenerateRequest) =>
    post<GenerateResponse>(`/api/v1/episodes/${id}/generate`, data ?? {}),

  retry: (id: string) =>
    post<RetryResponse>(`/api/v1/episodes/${id}/retry`),

  retryStep: (id: string, step: string) =>
    post<RetryResponse>(`/api/v1/episodes/${id}/retry/${step}`),

  getScript: (id: string) =>
    get<Record<string, unknown> | null>(`/api/v1/episodes/${id}/script`),

  updateScript: (id: string, data: ScriptUpdate) =>
    put<Record<string, unknown>>(`/api/v1/episodes/${id}/script`, data),

  // ── Scene-level operations ──────────────────────────────────────────

  updateScene: (
    episodeId: string,
    sceneNumber: number,
    data: {
      narration?: string;
      visual_prompt?: string;
      duration_seconds?: number;
      keywords?: string[];
    },
  ) =>
    put<{ message: string; scene: Record<string, unknown> }>(
      `/api/v1/episodes/${episodeId}/scenes/${sceneNumber}`,
      data,
    ),

  deleteScene: (episodeId: string, sceneNumber: number) =>
    del<{ message: string; remaining_scenes: number; media_assets_deleted: number }>(
      `/api/v1/episodes/${episodeId}/scenes/${sceneNumber}`,
    ),

  reorderScenes: (episodeId: string, order: number[]) =>
    post<{ message: string; order: number[] }>(
      `/api/v1/episodes/${episodeId}/scenes/reorder`,
      { order },
    ),

  // ── Regeneration endpoints ──────────────────────────────────────────

  regenerateScene: (
    episodeId: string,
    sceneNumber: number,
    prompt?: string,
  ) =>
    post<{ message: string; episode_id: string; scene_number: number; job_ids: string[] }>(
      `/api/v1/episodes/${episodeId}/regenerate-scene/${sceneNumber}`,
      prompt ? { visual_prompt: prompt } : undefined,
    ),

  regenerateVoice: (episodeId: string, voiceProfileId?: string) =>
    post<{ message: string; episode_id: string; job_ids: string[] }>(
      `/api/v1/episodes/${episodeId}/regenerate-voice`,
      voiceProfileId ? { voice_profile_id: voiceProfileId } : undefined,
    ),

  reassemble: (episodeId: string) =>
    post<{ message: string; episode_id: string; job_ids: string[] }>(
      `/api/v1/episodes/${episodeId}/reassemble`,
    ),

  seoScore: (episodeId: string) =>
    get<SEOScore>(`/api/v1/episodes/${episodeId}/seo-score`),

  publishAll: (
    episodeId: string,
    data: {
      platforms: ('youtube' | 'tiktok' | 'instagram')[];
      title?: string;
      description?: string;
      privacy?: 'public' | 'unlisted' | 'private';
    },
  ) =>
    post<{
      episode_id: string;
      accepted: { platform: string; upload_id: string }[];
      skipped: { platform: string; reason: string }[];
    }>(`/api/v1/episodes/${episodeId}/publish-all`, data),

  regenerateCaptions: (episodeId: string, captionStyle: string) =>
    post<{ message: string; episode_id: string; job_ids: string[] }>(
      `/api/v1/episodes/${episodeId}/regenerate-captions?caption_style=${encodeURIComponent(captionStyle)}`,
      {},
    ),

  setMusic: (
    episodeId: string,
    data: {
      music_enabled: boolean;
      music_mood?: string;
      music_volume_db?: number;
      reassemble?: boolean;
    },
  ) =>
    post<{ message: string; episode_id: string }>(
      `/api/v1/episodes/${episodeId}/set-music`,
      data,
    ),

  bulkGenerate: (episodeIds: string[]) =>
    post<{ queued: number; skipped: number }>(
      '/api/v1/episodes/bulk-generate',
      { episode_ids: episodeIds },
    ),

  // ── Episode management ──────────────────────────────────────────────

  duplicate: (episodeId: string) =>
    post<Episode>(`/api/v1/episodes/${episodeId}/duplicate`),

  resetToDraft: (episodeId: string) =>
    post<{ message: string; episode_id: string; jobs_deleted: number }>(
      `/api/v1/episodes/${episodeId}/reset`,
    ),

  cancel: (episodeId: string) =>
    post<{ message: string; episode_id: string; cancelled_jobs: number }>(
      `/api/v1/episodes/${episodeId}/cancel`,
      {},
    ),

  // ── Video editing ──────────────────────────────────────────────────

  editVideo: (episodeId: string, edits: VideoEditPayload) =>
    post<VideoEditResult>(`/api/v1/episodes/${episodeId}/edit`, edits),

  editPreview: (episodeId: string, edits: VideoEditPayload) =>
    post<VideoEditResult>(`/api/v1/episodes/${episodeId}/edit/preview`, edits),

  editReset: (episodeId: string) =>
    post<VideoEditResult>(`/api/v1/episodes/${episodeId}/edit/reset`),

  // ── Music ──────────────────────────────────────────────────────────

  musicList: (episodeId: string) =>
    get<Array<{ filename: string; path: string; mood: string; duration: number }>>(
      `/api/v1/episodes/${episodeId}/music`,
    ),

  musicGenerate: (episodeId: string, mood: string, duration: number = 30) =>
    post<{ message: string; path: string; duration: number }>(
      `/api/v1/episodes/${episodeId}/music/generate`,
      { mood, duration },
    ),

  musicSelect: (episodeId: string, musicPath: string) =>
    post<{ message: string }>(
      `/api/v1/episodes/${episodeId}/music/select`,
      { music_path: musicPath },
    ),

  musicMoods: (episodeId: string) =>
    get<{ moods: Array<{ value: string; label: string; description: string }> }>(
      `/api/v1/episodes/${episodeId}/music/moods`,
    ),

  generateSeo: (episodeId: string) =>
    post<{ title: string; description: string; hashtags: string[]; tags: string[]; hook: string; virality_score?: number }>(
      `/api/v1/episodes/${episodeId}/seo`,
    ),
};

// ---------------------------------------------------------------------------
// Voice Profiles
// ---------------------------------------------------------------------------

export const voiceProfiles = {
  list: (provider?: string) => {
    const qs = provider ? `?provider=${provider}` : '';
    return get<VoiceProfile[]>(`/api/v1/voice-profiles${qs}`);
  },

  get: (id: string) => get<VoiceProfile>(`/api/v1/voice-profiles/${id}`),

  create: (data: VoiceProfileCreate) =>
    post<VoiceProfile>('/api/v1/voice-profiles', data),

  update: (id: string, data: VoiceProfileUpdate) =>
    put<VoiceProfile>(`/api/v1/voice-profiles/${id}`, data),

  delete: (id: string) => del(`/api/v1/voice-profiles/${id}`),

  test: (id: string, text?: string) =>
    post<VoiceTestResponse>(`/api/v1/voice-profiles/${id}/test`, text ? { text } : undefined),
};

// ---------------------------------------------------------------------------
// ComfyUI Servers
// ---------------------------------------------------------------------------

export const comfyuiServers = {
  list: () => get<ComfyUIServer[]>('/api/v1/comfyui/servers'),

  get: (id: string) => get<ComfyUIServer>(`/api/v1/comfyui/servers/${id}`),

  create: (data: ComfyUIServerCreate) =>
    post<ComfyUIServer>('/api/v1/comfyui/servers', data),

  update: (id: string, data: ComfyUIServerUpdate) =>
    put<ComfyUIServer>(`/api/v1/comfyui/servers/${id}`, data),

  delete: (id: string) => del(`/api/v1/comfyui/servers/${id}`),

  test: (id: string) =>
    post<ComfyUIServerTestResponse>(`/api/v1/comfyui/servers/${id}/test`),
};

// ---------------------------------------------------------------------------
// ComfyUI Workflows
// ---------------------------------------------------------------------------

export const comfyuiWorkflows = {
  list: () => get<ComfyUIWorkflow[]>('/api/v1/comfyui/workflows'),

  get: (id: string) =>
    get<ComfyUIWorkflow>(`/api/v1/comfyui/workflows/${id}`),

  create: (data: ComfyUIWorkflowCreate) =>
    post<ComfyUIWorkflow>('/api/v1/comfyui/workflows', data),

  update: (id: string, data: ComfyUIWorkflowUpdate) =>
    put<ComfyUIWorkflow>(`/api/v1/comfyui/workflows/${id}`, data),

  delete: (id: string) => del(`/api/v1/comfyui/workflows/${id}`),
};

// ---------------------------------------------------------------------------
// LLM Configs
// ---------------------------------------------------------------------------

export const llmConfigs = {
  list: () => get<LLMConfig[]>('/api/v1/llm'),

  get: (id: string) => get<LLMConfig>(`/api/v1/llm/${id}`),

  create: (data: LLMConfigCreate) => post<LLMConfig>('/api/v1/llm', data),

  update: (id: string, data: LLMConfigUpdate) =>
    put<LLMConfig>(`/api/v1/llm/${id}`, data),

  delete: (id: string) => del(`/api/v1/llm/${id}`),

  test: (id: string, prompt?: string) =>
    post<LLMTestResponse>(`/api/v1/llm/${id}/test`, prompt ? { prompt } : undefined),
};

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

export const promptTemplates = {
  list: (templateType?: string) => {
    const qs = templateType ? `?template_type=${templateType}` : '';
    return get<PromptTemplate[]>(`/api/v1/prompt-templates${qs}`);
  },

  get: (id: string) =>
    get<PromptTemplate>(`/api/v1/prompt-templates/${id}`),

  create: (data: PromptTemplateCreate) =>
    post<PromptTemplate>('/api/v1/prompt-templates', data),

  update: (id: string, data: PromptTemplateUpdate) =>
    put<PromptTemplate>(`/api/v1/prompt-templates/${id}`, data),

  delete: (id: string) => del(`/api/v1/prompt-templates/${id}`),
};

// ---------------------------------------------------------------------------
// Generation Jobs
// ---------------------------------------------------------------------------

export const jobs = {
  list: (params?: { episode_id?: string; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.episode_id) query.set('episode_id', params.episode_id);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    return get<GenerationJobListItem[]>(`/api/v1/jobs${qs ? `?${qs}` : ''}`);
  },

  all: (params?: {
    status?: string;
    episode_id?: string;
    step?: string;
    limit?: number;
    offset?: number;
  }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.episode_id) query.set('episode_id', params.episode_id);
    if (params?.step) query.set('step', params.step);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return get<GenerationJobExtended[]>(`/api/v1/jobs/all${qs ? `?${qs}` : ''}`);
  },

  active: () => get<GenerationJobListItem[]>('/api/v1/jobs/active'),

  get: (id: string) => get<GenerationJob>(`/api/v1/jobs/${id}`),

  status: () =>
    get<{
      active: number;
      queued: number;
      max_concurrent: number;
      slots_available: number;
      generating_episodes: number;
      total_generating_episodes: number;
      total_failed_episodes: number;
    }>('/api/v1/jobs/status'),

  cancelAll: () =>
    post<{ message: string; cancelled_episodes: number; cancelled_jobs: number }>(
      '/api/v1/jobs/cancel-all',
      {},
    ),

  retryAllFailed: (priority?: 'shorts_first' | 'longform_first' | 'fifo') =>
    post<{ message: string; retried: number; total_failed: number; priority: string }>(
      `/api/v1/jobs/retry-all-failed${priority ? `?priority=${priority}` : ''}`,
      {},
    ),

  pauseAll: () =>
    post<{ message: string; paused: number }>(
      '/api/v1/jobs/pause-all',
      {},
    ),

  cleanup: () =>
    post<{ message: string; cleaned_jobs: number; reset_episodes: number }>(
      '/api/v1/jobs/cleanup',
      {},
    ),

  setPriority: (mode: 'shorts_first' | 'longform_first' | 'fifo') =>
    post<{ message: string; mode: string }>(`/api/v1/jobs/set-priority?mode=${mode}`, {}),

  getPriority: () =>
    get<{ mode: string }>('/api/v1/jobs/priority'),

  cancelJob: (jobId: string) =>
    post<{ message: string; job_id: string; episode_id: string; episode_cancelled: boolean }>(
      `/api/v1/jobs/${jobId}/cancel`,
      {},
    ),

  tasksActive: () =>
    get<{
      tasks: Array<{
        type: 'episode_generation' | 'audiobook_generation' | 'script_generation';
        id: string;
        title: string;
        step: string;
        status: string;
        progress: number;
        url: string;
      }>;
    }>('/api/v1/jobs/tasks/active'),

  workerHealth: () =>
    get<{ alive: boolean; last_heartbeat: string | null; generating_count: number }>(
      '/api/v1/jobs/worker/health',
    ),

  restartWorker: () =>
    post<{ message: string }>('/api/v1/jobs/worker/restart', {}),
};

// ---------------------------------------------------------------------------
// Audiobooks
// ---------------------------------------------------------------------------

export const audiobooks = {
  list: () => get<Audiobook[]>('/api/v1/audiobooks'),

  get: (id: string) => get<Audiobook>(`/api/v1/audiobooks/${id}`),

  create: (data: AudiobookCreate) =>
    post<Audiobook>('/api/v1/audiobooks', data),

  delete: (id: string) => del(`/api/v1/audiobooks/${id}`),

  updateText: (id: string, text: string) =>
    put<Audiobook>(`/api/v1/audiobooks/${id}/text`, { text }),

  regenerateChapter: (id: string, chapterIndex: number, newText?: string) =>
    post<{ message: string; audiobook_id: string; chapter_index: number }>(
      `/api/v1/audiobooks/${id}/regenerate-chapter/${chapterIndex}`,
      newText ? { text: newText } : {},
    ),

  regenerate: (id: string) =>
    post<{ message: string; audiobook_id: string }>(
      `/api/v1/audiobooks/${id}/regenerate`,
    ),

  updateVoices: (id: string, data: { voice_casting: Record<string, string>; voice_profile_id?: string; regenerate: boolean }) =>
    put<{ message: string }>(`/api/v1/audiobooks/${id}/voices`, data),

  generateScript: (data: {
    concept: string;
    characters: Array<{ name: string; description: string }>;
    target_minutes: number;
    mood: string;
  }) =>
    post<{ job_id: string; status: string }>('/api/v1/audiobooks/generate-script', data),

  getScriptJob: (jobId: string) =>
    get<{
      job_id: string;
      status: string;
      result: {
        title: string;
        script: string;
        characters: string[];
        chapters: string[];
        word_count: number;
        estimated_minutes: number;
      } | null;
      error: string | null;
    }>(`/api/v1/audiobooks/script-job/${jobId}`),

  cancelScriptJob: (jobId: string) =>
    post<{ message: string }>(`/api/v1/audiobooks/script-job/${jobId}/cancel`, {}),

  createAI: (data: {
    concept: string;
    characters: Array<{
      name: string;
      description: string;
      gender: string;
      voice_profile_id: string | null;
    }>;
    target_minutes: number;
    mood: string;
    output_format: string;
    music_enabled: boolean;
    music_mood?: string;
    music_volume_db?: number;
    speed: number;
    pitch: number;
    image_generation_enabled?: boolean;
    per_chapter_music?: boolean;
  }) =>
    post<{ audiobook_id: string; status: string; title: string }>(
      '/api/v1/audiobooks/create-ai',
      data,
    ),

  uploadToYouTube: (id: string, data: { title: string; description: string; tags: string[]; privacy_status: string }) =>
    post<{ status: string; youtube_video_id: string; youtube_url: string }>(
      `/api/v1/audiobooks/${id}/upload-youtube`,
      data,
    ),

  updateSettings: (id: string, data: { output_format?: string; music_enabled?: boolean; music_mood?: string; speed?: number; pitch?: number; video_orientation?: string; caption_style_preset?: string | null; image_generation_enabled?: boolean; per_chapter_music?: boolean }) =>
    put<Audiobook>(`/api/v1/audiobooks/${id}`, data),
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const metricsApi = {
  events: (limit = 100) =>
    get<Array<{
      step: string;
      duration_seconds: number;
      success: boolean;
      episode_id: string;
      timestamp: string;
    }>>(`/api/v1/metrics/events?limit=${limit}`),
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settings = {
  storage: () => get<StorageUsage>('/api/v1/settings/storage'),

  health: () => get<HealthCheck>('/api/v1/settings/health'),

  ffmpeg: () => get<FFmpegInfo>('/api/v1/settings/ffmpeg'),
};

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

export const apiKeys = {
  list: () =>
    get<Array<{ key_name: string; created_at: string; updated_at: string }>>(
      '/api/v1/settings/api-keys',
    ),

  store: (keyName: string, apiKey: string) =>
    post<{ message: string; key_name: string }>(
      '/api/v1/settings/api-keys',
      { key_name: keyName, api_key: apiKey },
    ),

  remove: (keyName: string) =>
    del(`/api/v1/settings/api-keys/${keyName}`),

  integrations: () =>
    get<Record<string, { configured: boolean; source: string }>>(
      '/api/v1/settings/integrations',
    ),
};

// ---------------------------------------------------------------------------
// RunPod Cloud GPU
// ---------------------------------------------------------------------------

export const runpod = {
  listPods: () =>
    get<any[]>('/api/v1/runpod/pods'),

  createPod: (data: {
    name: string;
    gpu_type_id?: string;
    image?: string;
    gpu_count?: number;
    volume_gb?: number;
    ports?: string;
    template_id?: string;
    env?: Record<string, string>;
    docker_args?: string;
  }) =>
    post<any>('/api/v1/runpod/pods', data),

  startPod: (podId: string) =>
    post<any>(`/api/v1/runpod/pods/${podId}/start`),

  stopPod: (podId: string) =>
    post<any>(`/api/v1/runpod/pods/${podId}/stop`),

  deletePod: (podId: string) =>
    del(`/api/v1/runpod/pods/${podId}`),

  gpuTypes: () =>
    get<any[]>('/api/v1/runpod/gpu-types'),

  registerPod: (podId: string, port?: number) =>
    post<any>(`/api/v1/runpod/pods/${podId}/register`, {
      comfyui_port: port ?? 8188,
    }),

  registerLlm: (podId: string, port?: number, model?: string) =>
    post<any>(`/api/v1/runpod/pods/${podId}/register-llm`, {
      port: port ?? 8000,
      model: model ?? 'auto',
    }),

  templates: (category?: string) => {
    const qs = category ? `?category=${category}` : '';
    return get<any[]>(`/api/v1/runpod/templates${qs}`);
  },

  deployStatus: (podId: string) =>
    get<{ pod_id: string; status: string; message: string; registered?: boolean; service_url?: string; model_name?: string; pod_type?: string }>(
      `/api/v1/runpod/pods/${podId}/deploy-status`,
    ),
};

// ---------------------------------------------------------------------------
// Social Media Platforms
// ---------------------------------------------------------------------------

export interface SocialPlatform {
  id: string;
  platform: string;
  account_name: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SocialUpload {
  id: string;
  platform: string;
  content_type: string;
  title: string;
  remote_url: string | null;
  upload_status: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  created_at: string;
}

export interface SocialPlatformStats {
  platform: string;
  total_uploads: number;
  total_views: number;
  total_likes: number;
  total_comments: number;
  total_shares: number;
}

export const social = {
  listPlatforms: () =>
    get<SocialPlatform[]>('/api/v1/social/platforms'),

  connectPlatform: (data: {
    platform: string;
    account_name: string;
    access_token: string;
    refresh_token?: string;
  }) => post<SocialPlatform>('/api/v1/social/platforms', data),

  disconnectPlatform: (platformId: string) =>
    del(`/api/v1/social/platforms/${platformId}`),

  listUploads: () =>
    get<SocialUpload[]>('/api/v1/social/uploads'),

  getStats: () =>
    get<SocialPlatformStats[]>('/api/v1/social/stats'),

  // TikTok OAuth
  tiktokAuthUrl: () =>
    get<{ auth_url: string; state: string }>('/api/v1/social/tiktok/auth-url'),

  tiktokStatus: () =>
    get<{ connected: boolean; account: SocialPlatform | null }>('/api/v1/social/tiktok/status'),
};

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

export const youtube = {
  getAuthUrl: () =>
    get<{ auth_url: string }>('/api/v1/youtube/auth-url'),

  getStatus: () =>
    get<{ connected: boolean; channel: YouTubeChannel | null; channels: YouTubeChannel[] }>(
      '/api/v1/youtube/status',
    ),

  listChannels: () =>
    get<YouTubeChannel[]>('/api/v1/youtube/channels'),

  updateChannel: (channelId: string, data: { upload_days?: string[] | null; upload_time?: string | null }) =>
    put<YouTubeChannel>(`/api/v1/youtube/channels/${channelId}`, data),

  disconnect: (channelId?: string) =>
    post<{ message: string }>(`/api/v1/youtube/disconnect${channelId ? `?channel_id=${channelId}` : ''}`, {}),

  upload: (episodeId: string, data: YouTubeUploadRequest) =>
    post<YouTubeUpload>(`/api/v1/youtube/upload/${episodeId}`, data),

  getUploads: () => get<YouTubeUpload[]>('/api/v1/youtube/uploads'),

  // Playlists
  listPlaylists: () =>
    get<YouTubePlaylist[]>('/api/v1/youtube/playlists'),

  createPlaylist: (data: { title: string; description?: string; privacy_status?: string }) =>
    post<YouTubePlaylist>('/api/v1/youtube/playlists', data),

  addToPlaylist: (playlistId: string, videoId: string) =>
    post<{ message: string }>(`/api/v1/youtube/playlists/${playlistId}/add`, { video_id: videoId }),

  deletePlaylist: (playlistId: string) =>
    del(`/api/v1/youtube/playlists/${playlistId}`),

  // Analytics
  getVideoStats: (videoIds: string[]) =>
    get<YouTubeVideoStats[]>(`/api/v1/youtube/analytics?video_ids=${videoIds.join(',')}`),

  getChannelAnalytics: (params?: { channelId?: string; days?: number }) => {
    const qs = new URLSearchParams();
    if (params?.channelId) qs.set('channel_id', params.channelId);
    if (params?.days) qs.set('days', String(params.days));
    const q = qs.toString();
    return get<YouTubeChannelAnalytics>(
      `/api/v1/youtube/analytics/channel${q ? `?${q}` : ''}`,
    );
  },
};

export interface YouTubeChannelAnalytics {
  channel_id: string;
  window_days: number;
  start_date: string;
  end_date: string;
  totals: {
    views: number;
    estimated_minutes_watched: number;
    average_view_duration_seconds: number;
    subscribers_gained: number;
    subscribers_lost: number;
    likes: number;
    comments: number;
    shares: number;
    card_click_rate: number;
    card_impressions: number;
  };
  daily: { day: string; views: number; minutes_watched: number }[];
}

// ---------------------------------------------------------------------------
// Video Templates
// ---------------------------------------------------------------------------

export const videoTemplates = {
  list: () => get<any[]>('/api/v1/video-templates'),
  create: (data: any) => post<any>('/api/v1/video-templates', data),
  update: (id: string, data: any) => put<any>(`/api/v1/video-templates/${id}`, data),
  remove: (id: string) => del(`/api/v1/video-templates/${id}`),
  applyToSeries: (templateId: string, seriesId: string) =>
    post<any>(`/api/v1/video-templates/${templateId}/apply/${seriesId}`),
  fromSeries: (seriesId: string) =>
    post<any>(`/api/v1/video-templates/from-series/${seriesId}`),
};

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export const schedule = {
  list: (status?: string) => {
    const qs = status ? `?status=${status}` : '';
    return get<any[]>(`/api/v1/schedule${qs}`);
  },
  calendar: (start: string, end: string) =>
    get<any>(`/api/v1/schedule/calendar?start=${start}&end=${end}`),
  create: (data: {
    content_type: string;
    content_id: string;
    platform: string;
    scheduled_at: string;
    title: string;
    description?: string;
    tags?: string;
    privacy?: string;
  }) => post<any>('/api/v1/schedule', data),
  cancel: (id: string) => del(`/api/v1/schedule/${id}`),
  update: (id: string, data: any) => put<any>(`/api/v1/schedule/${id}`, data),
};

// ---------------------------------------------------------------------------
// License
// ---------------------------------------------------------------------------

export interface LicenseStatus {
  state: 'unactivated' | 'active' | 'grace' | 'expired' | 'invalid';
  tier: string | null;
  features: string[];
  machines_cap: number | null;
  machine_id: string;
  activated_at: string | null;
  last_heartbeat_at: string | null;
  last_heartbeat_status: string | null;
  period_end: string | null;
  exp: string | null;
  error: string | null;
}

export interface ActivationEntry {
  machine_id: string;
  first_seen: number | null;
  last_heartbeat: number | null;
  last_known_version: string | null;
  is_this_machine: boolean;
}

export interface ActivationsResponse {
  tier: string;
  cap: number;
  this_machine_id: string;
  activations: ActivationEntry[];
}

export const license = {
  status: () => get<LicenseStatus>('/api/v1/license/status'),
  activate: (license_jwt: string) =>
    post<LicenseStatus>('/api/v1/license/activate', { license_jwt }),
  deactivate: () => post<LicenseStatus>('/api/v1/license/deactivate'),
  portal: () => post<{ url: string }>('/api/v1/license/portal'),
  listActivations: () =>
    get<ActivationsResponse>('/api/v1/license/activations'),
  deactivateMachine: (machine_id: string) =>
    post<ActivationsResponse>(
      `/api/v1/license/activations/${encodeURIComponent(machine_id)}/deactivate`,
    ),
  // Seat management without a local activation (used by the activation
  // wizard to recover from the seat-cap lockout).
  listActivationsByKey: (license_key: string) =>
    post<ActivationsResponse>('/api/v1/license/activations/query', { license_key }),
  freeSeatByKey: (license_key: string, machine_id: string) =>
    post<ActivationsResponse>('/api/v1/license/activations/free-seat', {
      license_key,
      machine_id,
    }),
};

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export interface UpdateStatus {
  current_installed: string | null;
  current_stable: string | null;
  update_available: boolean;
  mandatory_security_update: boolean;
  changelog_url: string | null;
  image_tags: Record<string, string>;
  unavailable: boolean;
  reason: string | null;
}

export interface UpdateProgress {
  phase: 'idle' | 'pulling' | 'pulled' | 'restarting' | 'done' | 'failed' | string;
  detail: string;
  ts: string;
  started_at: string;
}

export const updates = {
  status: (force: boolean = false) =>
    get<UpdateStatus>(`/api/v1/updates/status${force ? '?force=true' : ''}`),
  apply: () => post<{ queued: boolean; hint: string }>('/api/v1/updates/apply'),
  progress: () => get<UpdateProgress>('/api/v1/updates/progress'),
};

// ---------------------------------------------------------------------------
// SEO score
// ---------------------------------------------------------------------------

export interface SEOCheck {
  id: string;
  label: string;
  pass: boolean;
  severity: 'ok' | 'warn' | 'error' | 'info';
  hint: string;
}

export interface SEOScore {
  overall_score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  summary: string;
  has_seo_metadata: boolean;
  checks: SEOCheck[];
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export interface OnboardingStatus {
  comfyui_servers: number;
  llm_configs: number;
  voice_profiles: number;
  youtube_channels: number;
  dismissed: boolean;
  should_show: boolean;
}

export const onboarding = {
  status: () => get<OnboardingStatus>('/api/v1/onboarding/status'),
  dismiss: () => post<void>('/api/v1/onboarding/dismiss'),
  reset: () => post<void>('/api/v1/onboarding/reset'),
};
