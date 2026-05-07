import { useQuery } from '@tanstack/react-query';
import { health, license, settings, audiobooks, voiceProfiles } from '@/lib/api';
import { keys } from './keys';

// ---------------------------------------------------------------------------
// Lightweight read-only queries (Phase 3.2)
// ---------------------------------------------------------------------------
//
// Settings sub-screens, the License section, and the audiobook /
// voice-profile lists used to manage their own ``useState(true)`` +
// ``useEffect`` fetch dance. These hooks collapse them to one line.

export function useHealth() {
  return useQuery({
    queryKey: keys.health.overall(),
    queryFn: () => health.check(),
  });
}

export function useStorage() {
  return useQuery({
    queryKey: keys.storage.overall(),
    queryFn: () => settings.storage(),
  });
}

export function useLicenseStatus() {
  return useQuery({
    queryKey: keys.license.status(),
    queryFn: () => license.status(),
  });
}

export function useAudiobooks() {
  return useQuery({
    queryKey: keys.audiobooks.list(),
    queryFn: () => audiobooks.list(),
  });
}

export function useAudiobook(id: string | undefined) {
  return useQuery({
    queryKey: keys.audiobooks.detail(id ?? ''),
    queryFn: () => audiobooks.get(id ?? ''),
    enabled: Boolean(id),
  });
}

export function useVoiceProfiles(params?: {
  provider?: string;
  language_code?: string;
}) {
  return useQuery({
    queryKey: keys.voiceProfiles.list(params),
    queryFn: () => voiceProfiles.list(params),
  });
}
