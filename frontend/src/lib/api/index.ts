/**
 * API client — backward-compatible re-exports.
 */
export {
  health,
  series,
  episodes,
  voiceProfiles,
  comfyuiServers,
  comfyuiWorkflows,
  llmConfigs,
  promptTemplates,
  jobs,
  audiobooks,
  metricsApi,
  settings,
  apiKeys,
  runpod,
  social,
  youtube,
  videoTemplates,
  schedule,
  license,
  updates,
  onboarding,
  ApiError,
  formatError,
} from './_monolith';

export type {
  SocialPlatform,
  SocialUpload,
  SocialPlatformStats,
  LicenseStatus,
  UpdateStatus,
  UpdateProgress,
  ActivationEntry,
  ActivationsResponse,
  OnboardingStatus,
  SEOCheck,
  SEOScore,
  YouTubeChannelAnalytics,
} from './_monolith';