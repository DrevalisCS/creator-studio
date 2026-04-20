import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Server,
  Mic2,
  Brain,
  HardDrive,
  Film,
  Plus,
  Trash2,
  TestTube2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Play,
  Pause,
  Volume2,
  Youtube,
  Edit3,
  Globe,
  ChevronDown,
  ChevronUp,
  Unlink,
  Key,
  Cloud,
  Eye,
  EyeOff,
  Cpu,
  Zap,
  SquareTerminal,
  CircleDollarSign,
  Link2,
  StopCircle,
  MemoryStick,
  ArrowUpDown,
  Search,
  SlidersHorizontal,
  Monitor,
  LayoutTemplate,
  Star,
  Layers,
  Subtitles,
  AlertTriangle,
  Loader2,
  KeyRound,
  ArrowUpCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { LicenseSection } from '@/pages/Settings/sections/LicenseSection';
import { UpdatesSection } from '@/pages/Settings/sections/UpdatesSection';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Dialog, DialogFooter } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import {
  comfyuiServers,
  voiceProfiles,
  llmConfigs,
  settings as settingsApi,
  youtube,
  social as socialApi,
  apiKeys as apiKeysApi,
  runpod as runpodApi,
  videoTemplates as videoTemplatesApi,
} from '@/lib/api';
import type { SocialPlatform } from '@/lib/api';
import type {
  ComfyUIServer,
  VoiceProfile,
  LLMConfig,
  StorageUsage,
  HealthCheck,
  FFmpegInfo,
} from '@/types';

// ---------------------------------------------------------------------------
// Settings Sections Nav
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'license', label: 'License', icon: KeyRound },
  { id: 'updates', label: 'Updates', icon: ArrowUpCircle },
  { id: 'health', label: 'Health', icon: CheckCircle2 },
  { id: 'comfyui', label: 'ComfyUI Servers', icon: Server },
  { id: 'voice', label: 'Voice Profiles', icon: Mic2 },
  { id: 'llm', label: 'LLM Configs', icon: Brain },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'ffmpeg', label: 'FFmpeg', icon: Film },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
  { id: 'social', label: 'Social Media', icon: Globe },
  { id: 'apikeys', label: 'API Keys', icon: Key },
  { id: 'runpod', label: 'Cloud GPU', icon: Cloud },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

function Settings() {
  const [activeSection, setActiveSection] = useState<SectionId>('license');

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-txt-primary">Settings</h2>
        <p className="mt-1 text-sm text-txt-secondary">
          Configure backend services, voice profiles, and system settings.
        </p>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Left nav */}
        <div className="col-span-3">
          <nav className="space-y-0.5">
            {SECTIONS.map((section) => {
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={[
                    'flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm font-medium transition-colors duration-fast text-left',
                    isActive
                      ? 'bg-accent-muted text-accent'
                      : 'text-txt-secondary hover:text-txt-primary hover:bg-bg-hover',
                  ].join(' ')}
                >
                  <section.icon size={16} />
                  {section.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right content */}
        <div className="col-span-9">
          {activeSection === 'license' && <LicenseSection />}
          {activeSection === 'updates' && <UpdatesSection />}
          {activeSection === 'health' && <HealthSection />}
          {activeSection === 'comfyui' && <ComfyUISection />}
          {activeSection === 'voice' && <VoiceSection />}
          {activeSection === 'llm' && <LLMSection />}
          {activeSection === 'storage' && <StorageSection />}
          {activeSection === 'ffmpeg' && <FFmpegSection />}
          {activeSection === 'templates' && <TemplatesSection />}
          {activeSection === 'social' && <SocialSection />}
          {activeSection === 'apikeys' && <ApiKeysSection onNavigateToApiKeys={() => setActiveSection('apikeys')} />}
          {activeSection === 'runpod' && <RunPodSection onNavigateToApiKeys={() => setActiveSection('apikeys')} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health Section
// ---------------------------------------------------------------------------

function HealthSection() {
  const { toast } = useToast();
  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await settingsApi.health();
      setHealth(res);
    } catch (err) {
      toast.error('Failed to load system health', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  if (loading) return <Spinner />;

  const statusIcon = (status: string) => {
    if (status === 'ok') return <CheckCircle2 size={16} className="text-success" />;
    if (status === 'degraded') return <AlertCircle size={16} className="text-warning" />;
    return <XCircle size={16} className="text-error" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">System Health</h3>
        <Button variant="ghost" size="sm" onClick={() => void fetch()}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {health && (
        <>
          <Card padding="md">
            <div className="flex items-center gap-3">
              {statusIcon(health.overall)}
              <span className="text-md font-semibold text-txt-primary">
                Overall: {health.overall}
              </span>
              <Badge variant={health.overall}>{health.overall}</Badge>
            </div>
          </Card>

          <div className="space-y-2">
            {health.services.map((svc) => (
              <Card key={svc.name} padding="sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {statusIcon(svc.status)}
                    <span className="text-sm font-medium text-txt-primary capitalize">
                      {svc.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {svc.message && (
                      <span className="text-xs text-txt-tertiary max-w-xs text-truncate">
                        {svc.message}
                      </span>
                    )}
                    <Badge variant={svc.status}>{svc.status}</Badge>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComfyUI Section
// ---------------------------------------------------------------------------

function ComfyUISection() {
  const { toast } = useToast();
  const [servers, setServers] = useState<ComfyUIServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ComfyUIServer | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [toggling, setToggling] = useState<string | null>(null);

  // Form
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formMaxConcurrent, setFormMaxConcurrent] = useState('2');

  const resetForm = () => {
    setFormName('');
    setFormUrl('');
    setFormApiKey('');
    setFormMaxConcurrent('2');
    setEditingServer(null);
  };

  const fetchServers = useCallback(async () => {
    try {
      const res = await comfyuiServers.list();
      setServers(res);
    } catch (err) {
      toast.error('Failed to load ComfyUI servers', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (srv: ComfyUIServer) => {
    setEditingServer(srv);
    setFormName(srv.name);
    setFormUrl(srv.url);
    setFormApiKey('');
    setFormMaxConcurrent(String(srv.max_concurrent));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setCreating(true);
    try {
      if (editingServer) {
        // Update existing server
        const updateData: Record<string, unknown> = {};
        if (formName.trim() !== editingServer.name) updateData.name = formName.trim();
        if (formUrl.trim() !== editingServer.url) updateData.url = formUrl.trim();
        if (formApiKey.trim()) updateData.api_key = formApiKey.trim();
        if (Number(formMaxConcurrent) !== editingServer.max_concurrent)
          updateData.max_concurrent = Number(formMaxConcurrent);
        if (Object.keys(updateData).length > 0) {
          await comfyuiServers.update(editingServer.id, updateData);
        }
      } else {
        // Create new server
        await comfyuiServers.create({
          name: formName.trim(),
          url: formUrl.trim(),
          api_key: formApiKey.trim() || undefined,
          max_concurrent: Number(formMaxConcurrent),
        });
      }
      toast.success(editingServer ? 'Server updated' : 'Server added');
      setDialogOpen(false);
      resetForm();
      void fetchServers();
    } catch (err) {
      toast.error(editingServer ? 'Failed to update server' : 'Failed to add server', { description: String(err) });
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (srv: ComfyUIServer) => {
    setToggling(srv.id);
    try {
      await comfyuiServers.update(srv.id, { is_active: !srv.is_active });
      void fetchServers();
    } catch (err) {
      toast.error('Failed to update server status', { description: String(err) });
    } finally {
      setToggling(null);
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await comfyuiServers.test(id);
      setTestResults((prev) => ({
        ...prev,
        [id]: { success: result.success, message: result.message },
      }));
      void fetchServers();
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: { success: false, message: 'Test request failed' },
      }));
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await comfyuiServers.delete(id);
      toast.success('Server removed');
      void fetchServers();
    } catch (err) {
      toast.error('Failed to remove server', { description: String(err) });
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">
          ComfyUI Servers
        </h3>
        <Button variant="primary" size="sm" onClick={openCreateDialog}>
          <Plus size={14} />
          Add Server
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="empty-state py-12">
          <Server size={32} />
          <p className="text-sm">No ComfyUI servers configured</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {servers.map((srv) => (
            <Card key={srv.id} padding="md" className="flex flex-col">
              {/* Header row with name + active toggle */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div
                      className={[
                        'w-2.5 h-2.5 rounded-full shrink-0',
                        srv.is_active ? 'bg-success' : 'bg-txt-tertiary/40',
                      ].join(' ')}
                      title={srv.is_active ? 'Active' : 'Inactive'}
                    />
                    <h4 className="text-sm font-semibold text-txt-primary truncate">
                      {srv.name}
                    </h4>
                  </div>
                  <p className="text-[11px] text-txt-secondary font-mono mt-1 truncate">
                    {srv.url}
                  </p>
                </div>
                {/* Active toggle */}
                <button
                  onClick={() => void handleToggleActive(srv)}
                  disabled={toggling === srv.id}
                  className="shrink-0"
                  title={srv.is_active ? 'Disable server' : 'Enable server'}
                >
                  <div className={[
                    'w-9 h-5 rounded-full transition-colors duration-fast relative',
                    srv.is_active ? 'bg-success' : 'bg-bg-active',
                  ].join(' ')}>
                    <div className={[
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-fast',
                      srv.is_active ? 'translate-x-4' : 'translate-x-0.5',
                    ].join(' ')} />
                  </div>
                </button>
              </div>

              {/* Info row */}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <Badge variant="neutral" className="text-[10px]">
                  Max: {srv.max_concurrent}
                </Badge>
                {srv.has_api_key && (
                  <Badge variant="accent" className="text-[10px]">API key set</Badge>
                )}
                {srv.last_test_status && (
                  <Badge
                    variant={srv.last_test_status === 'ok' ? 'success' : 'error'}
                    className="text-[10px]"
                  >
                    {srv.last_test_status}
                  </Badge>
                )}
              </div>

              {/* Last tested timestamp */}
              {srv.last_tested_at && (
                <p className="text-[10px] text-txt-tertiary mt-1">
                  Tested: {new Date(srv.last_tested_at).toLocaleString()}
                </p>
              )}

              {/* Inline test result */}
              {testResults[srv.id] && (() => {
                const r = testResults[srv.id]!;
                return (
                <div className={[
                  'mt-2 text-[11px] px-2 py-1.5 rounded',
                  r.success
                    ? 'bg-success-muted text-success'
                    : 'bg-error-muted text-error',
                ].join(' ')}>
                  {r.success ? (
                    <span className="flex items-center gap-1"><CheckCircle2 size={10} /> {r.message}</span>
                  ) : (
                    <span className="flex items-center gap-1"><XCircle size={10} /> {r.message}</span>
                  )}
                </div>
                );
              })()}

              {/* Action buttons */}
              <div className="mt-auto pt-3 flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={testing === srv.id}
                  onClick={() => void handleTest(srv.id)}
                >
                  <TestTube2 size={12} />
                  Test
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEditDialog(srv)}
                >
                  <Edit3 size={12} />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDelete(srv.id)}
                  className="text-txt-tertiary hover:text-error ml-auto"
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); resetForm(); }}
        title={editingServer ? 'Edit ComfyUI Server' : 'Add ComfyUI Server'}
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="My ComfyUI Server"
          />
          <Input
            label="URL"
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            placeholder="http://localhost:8188"
          />
          <Input
            label={editingServer ? 'API Key (leave blank to keep current)' : 'API Key (optional)'}
            type="password"
            value={formApiKey}
            onChange={(e) => setFormApiKey(e.target.value)}
            placeholder="Optional API key..."
          />
          <Input
            label="Max Concurrent Jobs"
            type="number"
            value={formMaxConcurrent}
            onChange={(e) => setFormMaxConcurrent(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setDialogOpen(false); resetForm(); }}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={creating}
            disabled={!formName.trim() || !formUrl.trim()}
            onClick={() => void handleSave()}
          >
            {editingServer ? 'Save Changes' : 'Add Server'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice Profiles Section
// ---------------------------------------------------------------------------

type ProviderFilter = 'all' | 'edge' | 'piper' | 'kokoro' | 'elevenlabs' | 'comfyui_elevenlabs';
type ProviderOption = 'piper' | 'elevenlabs' | 'kokoro' | 'edge' | 'comfyui_elevenlabs';

const PROVIDER_OPTIONS: Array<{ value: ProviderOption; label: string }> = [
  { value: 'edge', label: 'Edge TTS (Free)' },
  { value: 'piper', label: 'Piper (Local)' },
  { value: 'kokoro', label: 'Kokoro (Local)' },
  { value: 'elevenlabs', label: 'ElevenLabs (Cloud)' },
  { value: 'comfyui_elevenlabs', label: 'ElevenLabs via ComfyUI' },
];

const COMFYUI_ELEVENLABS_VOICES: Array<{ value: string; label: string }> = [
  { value: 'Roger (male, american)', label: 'Roger (male, american)' },
  { value: 'Sarah (female, american)', label: 'Sarah (female, american)' },
  { value: 'Laura (female, american)', label: 'Laura (female, american)' },
  { value: 'Charlie (male, australian)', label: 'Charlie (male, australian)' },
  { value: 'George (male, british)', label: 'George (male, british)' },
  { value: 'Callum (male, american)', label: 'Callum (male, american)' },
  { value: 'River (neutral, american)', label: 'River (neutral, american)' },
  { value: 'Harry (male, american)', label: 'Harry (male, american)' },
  { value: 'Liam (male, american)', label: 'Liam (male, american)' },
  { value: 'Alice (female, british)', label: 'Alice (female, british)' },
  { value: 'Matilda (female, american)', label: 'Matilda (female, american)' },
  { value: 'Will (male, american)', label: 'Will (male, american)' },
  { value: 'Jessica (female, american)', label: 'Jessica (female, american)' },
  { value: 'Eric (male, american)', label: 'Eric (male, american)' },
  { value: 'Bella (female, american)', label: 'Bella (female, american)' },
  { value: 'Chris (male, american)', label: 'Chris (male, american)' },
  { value: 'Brian (male, american)', label: 'Brian (male, american)' },
  { value: 'Daniel (male, british)', label: 'Daniel (male, british)' },
  { value: 'Lily (female, british)', label: 'Lily (female, british)' },
  { value: 'Adam (male, american)', label: 'Adam (male, american)' },
  { value: 'Bill (male, american)', label: 'Bill (male, american)' },
];

const FILTER_TABS: Array<{ value: ProviderFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'edge', label: 'Edge' },
  { value: 'piper', label: 'Piper' },
  { value: 'kokoro', label: 'Kokoro' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'comfyui_elevenlabs', label: 'ComfyUI 11L' },
];

function VoiceSection() {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProviderFilter>('all');
  const [playingId, setPlayingId] = useState<string | null>(null);

  // Form
  const [formName, setFormName] = useState('');
  const [formProvider, setFormProvider] = useState<ProviderOption>('edge');
  const [formPiperModel, setFormPiperModel] = useState('');
  const [formElevenLabsId, setFormElevenLabsId] = useState('');
  const [formKokoroVoiceName, setFormKokoroVoiceName] = useState('');
  const [formKokoroModelPath, setFormKokoroModelPath] = useState('');
  const [formEdgeVoiceId, setFormEdgeVoiceId] = useState('');
  const [formSpeed, setFormSpeed] = useState('1.0');

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await voiceProfiles.list();
      setProfiles(res);
    } catch (err) {
      toast.error('Failed to load voice profiles', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      // Auto-detect gender from ComfyUI ElevenLabs voice name
      let gender: string | undefined;
      if (formProvider === 'comfyui_elevenlabs' && formElevenLabsId) {
        if (formElevenLabsId.includes('female')) gender = 'female';
        else if (formElevenLabsId.includes('male')) gender = 'male';
      }

      await voiceProfiles.create({
        name: formName.trim(),
        provider: formProvider,
        speed: parseFloat(formSpeed) || 1.0,
        piper_model_path: formProvider === 'piper' ? formPiperModel.trim() || undefined : undefined,
        elevenlabs_voice_id: (formProvider === 'elevenlabs' || formProvider === 'comfyui_elevenlabs') ? formElevenLabsId.trim() || undefined : undefined,
        kokoro_voice_name: formProvider === 'kokoro' ? formKokoroVoiceName.trim() || undefined : undefined,
        kokoro_model_path: formProvider === 'kokoro' ? formKokoroModelPath.trim() || undefined : undefined,
        edge_voice_id: formProvider === 'edge' ? formEdgeVoiceId.trim() || undefined : undefined,
        gender,
      });
      toast.success('Voice profile added');
      setDialogOpen(false);
      resetForm();
      void fetchProfiles();
    } catch (err) {
      toast.error('Failed to add voice profile', { description: String(err) });
    } finally {
      setCreating(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormProvider('edge');
    setFormPiperModel('');
    setFormElevenLabsId('');
    setFormKokoroVoiceName('');
    setFormKokoroModelPath('');
    setFormEdgeVoiceId('');
    setFormSpeed('1.0');
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await voiceProfiles.test(id);
      if (result.audio_path) {
        toast.success('Voice sample generated');
        void fetchProfiles();
      }
    } catch (err) {
      toast.error('Failed to generate voice sample', { description: String(err) });
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await voiceProfiles.delete(id);
      toast.success('Voice profile deleted');
      void fetchProfiles();
    } catch (err) {
      toast.error('Failed to delete voice profile', { description: String(err) });
    }
  };

  const handlePlayPause = (profileId: string) => {
    // Stop ALL currently playing audio first
    document.querySelectorAll('audio').forEach((a) => {
      if (a.id !== `audio-${profileId}`) {
        (a as HTMLAudioElement).pause();
        (a as HTMLAudioElement).currentTime = 0;
      }
    });

    const audio = document.getElementById(`audio-${profileId}`) as HTMLAudioElement | null;
    if (!audio) return;

    if (audio.paused) {
      audio.play().catch(() => {});
      setPlayingId(profileId);

      audio.onended = () => setPlayingId(null);
      audio.onpause = () => {
        if (playingId === profileId) setPlayingId(null);
      };
    } else {
      audio.pause();
      setPlayingId(null);
    }
  };

  const filteredProfiles = filter === 'all'
    ? profiles
    : profiles.filter((p) => p.provider === filter);

  const getProviderBadgeVariant = (provider: string) => {
    switch (provider) {
      case 'edge': return 'info';
      case 'piper': return 'success';
      case 'kokoro': return 'accent';
      case 'elevenlabs': return 'warning';
      default: return 'neutral';
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">
          Voice Profiles
        </h3>
        <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)}>
          <Plus size={14} />
          Add Profile
        </Button>
      </div>

      {/* Provider filter tabs */}
      <div className="flex items-center gap-1 p-1 bg-bg-elevated rounded-md w-fit">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={[
              'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-fast',
              filter === tab.value
                ? 'bg-bg-surface text-txt-primary shadow-sm'
                : 'text-txt-secondary hover:text-txt-primary',
            ].join(' ')}
          >
            {tab.label}
            {tab.value !== 'all' && (
              <span className="ml-1 text-txt-tertiary">
                ({profiles.filter((p) => p.provider === tab.value).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {filteredProfiles.length === 0 ? (
        <div className="empty-state py-12">
          <Mic2 size={32} />
          <p className="text-sm">
            {filter === 'all'
              ? 'No voice profiles configured'
              : `No ${filter} voice profiles`}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredProfiles.map((p) => (
            <Card key={p.id} padding="md" className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-txt-primary truncate">
                    {p.name}
                  </h4>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <Badge variant={getProviderBadgeVariant(p.provider)} className="text-[10px]">
                      {p.provider}
                    </Badge>
                    <span className="text-[10px] text-txt-tertiary">
                      {p.speed}x speed
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDelete(p.id)}
                  className="shrink-0"
                >
                  <Trash2 size={12} />
                </Button>
              </div>

              <p className="text-[11px] text-txt-tertiary mt-2 truncate">
                {p.piper_model_path && `Model: ${p.piper_model_path}`}
                {p.elevenlabs_voice_id && `Voice: ${p.elevenlabs_voice_id}`}
                {p.kokoro_voice_name && `Voice: ${p.kokoro_voice_name}`}
                {p.edge_voice_id && `Voice: ${p.edge_voice_id}`}
                {!p.piper_model_path && !p.elevenlabs_voice_id && !p.kokoro_voice_name && !p.edge_voice_id && 'Default configuration'}
              </p>

              <div className="mt-auto pt-3 flex items-center gap-2">
                {p.sample_audio_path ? (
                  <>
                    <button
                      onClick={() => handlePlayPause(p.id)}
                      className={[
                        'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors duration-fast',
                        playingId === p.id
                          ? 'bg-accent text-txt-onAccent'
                          : 'bg-accent-muted text-accent hover:bg-accent/20',
                      ].join(' ')}
                    >
                      {playingId === p.id ? <Pause size={12} /> : <Play size={12} />}
                      {playingId === p.id ? 'Pause' : 'Preview'}
                    </button>
                    <audio
                      id={`audio-${p.id}`}
                      src={`/storage/${p.sample_audio_path}`}
                      preload="none"
                    />
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={testing === p.id}
                    onClick={() => void handleTest(p.id)}
                  >
                    <Volume2 size={12} />
                    Generate Sample
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); resetForm(); }}
        title="Add Voice Profile"
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="e.g., Narrator Voice"
          />
          <Select
            label="Provider"
            value={formProvider}
            onChange={(e) =>
              setFormProvider(e.target.value as ProviderOption)
            }
            options={PROVIDER_OPTIONS}
          />
          {formProvider === 'edge' && (
            <Input
              label="Edge Voice ID"
              value={formEdgeVoiceId}
              onChange={(e) => setFormEdgeVoiceId(e.target.value)}
              placeholder="e.g., en-US-AriaNeural"
              hint="Microsoft Edge neural voice name. Leave empty for default."
            />
          )}
          {formProvider === 'piper' && (
            <Input
              label="Piper Model Path"
              value={formPiperModel}
              onChange={(e) => setFormPiperModel(e.target.value)}
              placeholder="Path to .onnx model file"
            />
          )}
          {formProvider === 'kokoro' && (
            <>
              <Input
                label="Kokoro Voice Name"
                value={formKokoroVoiceName}
                onChange={(e) => setFormKokoroVoiceName(e.target.value)}
                placeholder="e.g., af_bella"
              />
              <Input
                label="Kokoro Model Path (optional)"
                value={formKokoroModelPath}
                onChange={(e) => setFormKokoroModelPath(e.target.value)}
                placeholder="Path to Kokoro model file"
              />
            </>
          )}
          {formProvider === 'elevenlabs' && (
            <Input
              label="ElevenLabs Voice ID"
              value={formElevenLabsId}
              onChange={(e) => setFormElevenLabsId(e.target.value)}
              placeholder="Voice ID from ElevenLabs"
            />
          )}
          {formProvider === 'comfyui_elevenlabs' && (
            <Select
              label="ElevenLabs Voice"
              value={formElevenLabsId}
              placeholder="Select a voice..."
              onChange={(e) => {
                setFormElevenLabsId(e.target.value);
                // Auto-fill name from voice selection
                if (!formName.trim() || formName.startsWith('ElevenLabs ')) {
                  const shortName = e.target.value.split(' (')[0];
                  setFormName(`ElevenLabs ${shortName}`);
                }
              }}
              options={COMFYUI_ELEVENLABS_VOICES}
            />
          )}
          <Input
            label="Speed"
            type="number"
            value={formSpeed}
            onChange={(e) => setFormSpeed(e.target.value)}
            hint="1.0 = normal speed. Range: 0.5 - 2.0"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setDialogOpen(false); resetForm(); }}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={creating}
            disabled={!formName.trim()}
            onClick={() => void handleCreate()}
          >
            Add Profile
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM Configs Section
// ---------------------------------------------------------------------------

function LLMSection() {
  const { toast } = useToast();
  const [configs, setConfigs] = useState<LLMConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<LLMConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string; response?: string }>>({});

  // Form
  const [formName, setFormName] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formMaxTokens, setFormMaxTokens] = useState('4096');
  const [formTemperature, setFormTemperature] = useState('0.7');

  const resetForm = () => {
    setFormName('');
    setFormBaseUrl('');
    setFormModel('');
    setFormApiKey('');
    setFormMaxTokens('4096');
    setFormTemperature('0.7');
    setEditingConfig(null);
  };

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await llmConfigs.list();
      setConfigs(res);
    } catch (err) {
      toast.error('Failed to load LLM configurations', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchConfigs();
  }, [fetchConfigs]);

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (c: LLMConfig) => {
    setEditingConfig(c);
    setFormName(c.name);
    setFormBaseUrl(c.base_url);
    setFormModel(c.model_name);
    setFormApiKey('');
    setFormMaxTokens(String(c.max_tokens));
    setFormTemperature(String(c.temperature));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setCreating(true);
    try {
      if (editingConfig) {
        const updateData: Record<string, unknown> = {};
        if (formName.trim() !== editingConfig.name) updateData.name = formName.trim();
        if (formBaseUrl.trim() !== editingConfig.base_url) updateData.base_url = formBaseUrl.trim();
        if (formModel.trim() !== editingConfig.model_name) updateData.model_name = formModel.trim();
        if (formApiKey.trim()) updateData.api_key = formApiKey.trim();
        if (Number(formMaxTokens) !== editingConfig.max_tokens) updateData.max_tokens = Number(formMaxTokens);
        if (Number(formTemperature) !== editingConfig.temperature) updateData.temperature = Number(formTemperature);
        if (Object.keys(updateData).length > 0) {
          await llmConfigs.update(editingConfig.id, updateData);
        }
      } else {
        await llmConfigs.create({
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          model_name: formModel.trim(),
          api_key: formApiKey.trim() || undefined,
          max_tokens: Number(formMaxTokens),
          temperature: Number(formTemperature),
        });
      }
      toast.success(editingConfig ? 'LLM config updated' : 'LLM config added');
      setDialogOpen(false);
      resetForm();
      void fetchConfigs();
    } catch (err) {
      toast.error(editingConfig ? 'Failed to update LLM config' : 'Failed to add LLM config', { description: String(err) });
    } finally {
      setCreating(false);
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await llmConfigs.test(id);
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          success: result.success,
          message: result.message,
          response: result.response_text ?? undefined,
        },
      }));
    } catch (err) {
      toast.error('LLM test request failed', { description: String(err) });
      setTestResults((prev) => ({
        ...prev,
        [id]: { success: false, message: 'Test request failed' },
      }));
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await llmConfigs.delete(id);
      toast.success('LLM config deleted');
      void fetchConfigs();
    } catch (err) {
      toast.error('Failed to delete LLM config', { description: String(err) });
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">
          LLM Configurations
        </h3>
        <Button variant="primary" size="sm" onClick={openCreateDialog}>
          <Plus size={14} />
          Add Config
        </Button>
      </div>

      {configs.length === 0 ? (
        <div className="empty-state py-12">
          <Brain size={32} />
          <p className="text-sm">No LLM configurations yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {configs.map((c) => (
            <Card key={c.id} padding="md" className="flex flex-col">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-txt-primary truncate">
                    {c.name}
                  </h4>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge variant="accent" className="text-[10px]">{c.model_name}</Badge>
                    {c.has_api_key && (
                      <Badge variant="info" className="text-[10px]">API key</Badge>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDelete(c.id)}
                  className="shrink-0 text-txt-tertiary hover:text-error"
                >
                  <Trash2 size={12} />
                </Button>
              </div>

              {/* Details */}
              <p className="text-[11px] text-txt-secondary font-mono mt-2 truncate">
                {c.base_url}
              </p>
              <p className="text-[10px] text-txt-tertiary mt-1">
                Max tokens: {c.max_tokens} | Temp: {c.temperature}
              </p>

              {/* Inline test result */}
              {testResults[c.id] && (() => {
                const tr = testResults[c.id]!;
                return (
                <div className={[
                  'mt-2 text-[11px] px-2 py-1.5 rounded',
                  tr.success
                    ? 'bg-success-muted text-success'
                    : 'bg-error-muted text-error',
                ].join(' ')}>
                  <span className="flex items-center gap-1">
                    {tr.success ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                    {tr.message}
                  </span>
                  {tr.response && (
                    <p className="mt-1 text-[10px] text-txt-secondary line-clamp-2">
                      {tr.response}
                    </p>
                  )}
                </div>
                );
              })()}

              {/* Actions */}
              <div className="mt-auto pt-3 flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={testing === c.id}
                  onClick={() => void handleTest(c.id)}
                >
                  <TestTube2 size={12} />
                  Test
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEditDialog(c)}
                >
                  <Edit3 size={12} />
                  Edit
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); resetForm(); }}
        title={editingConfig ? 'Edit LLM Configuration' : 'Add LLM Configuration'}
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="e.g., GPT-4 Local"
          />
          <Input
            label="Base URL"
            value={formBaseUrl}
            onChange={(e) => setFormBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
          />
          <Input
            label="Model Name"
            value={formModel}
            onChange={(e) => setFormModel(e.target.value)}
            placeholder="e.g., llama3, gpt-4"
          />
          <Input
            label={editingConfig ? 'API Key (leave blank to keep current)' : 'API Key (optional)'}
            type="password"
            value={formApiKey}
            onChange={(e) => setFormApiKey(e.target.value)}
            placeholder="Optional API key..."
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Max Tokens"
              type="number"
              value={formMaxTokens}
              onChange={(e) => setFormMaxTokens(e.target.value)}
            />
            <Input
              label="Temperature"
              type="number"
              value={formTemperature}
              onChange={(e) => setFormTemperature(e.target.value)}
              hint="0.0 = deterministic, 1.0 = creative"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setDialogOpen(false); resetForm(); }}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={creating}
            disabled={
              !formName.trim() || !formBaseUrl.trim() || !formModel.trim()
            }
            onClick={() => void handleSave()}
          >
            {editingConfig ? 'Save Changes' : 'Add Config'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storage Section
// ---------------------------------------------------------------------------

function StorageSection() {
  const { toast } = useToast();
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStorage = useCallback(async () => {
    try {
      const res = await settingsApi.storage();
      setStorage(res);
    } catch (err) {
      toast.error('Failed to load storage information', { description: String(err) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchStorage();
  }, [fetchStorage]);

  const handleRefresh = () => {
    setRefreshing(true);
    void fetchStorage();
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">Storage</h3>
        <Button variant="ghost" size="sm" loading={refreshing} onClick={handleRefresh}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {storage ? (
        <Card padding="md">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <span className="text-xs text-txt-tertiary">Total Disk Usage</span>
              <p className="text-2xl font-bold text-txt-primary mt-0.5">
                {storage.total_size_human}
              </p>
              <p className="text-[10px] text-txt-tertiary mt-1">
                {storage.total_size_bytes.toLocaleString()} bytes
              </p>
            </div>
            <div>
              <span className="text-xs text-txt-tertiary">Storage Path</span>
              <p className="text-sm text-txt-secondary font-mono mt-0.5 break-all">
                {storage.storage_base_path}
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <Card padding="md">
          <p className="text-sm text-txt-secondary">
            Unable to fetch storage information.
          </p>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FFmpeg Section
// ---------------------------------------------------------------------------

function FFmpegSection() {
  const [ffmpeg, setFfmpeg] = useState<FFmpegInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    settingsApi
      .ffmpeg()
      .then(setFfmpeg)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-txt-primary">FFmpeg</h3>

      {ffmpeg ? (
        <Card padding="md">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant={ffmpeg.available ? 'success' : 'error'}>
                {ffmpeg.available ? 'Available' : 'Not Available'}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-txt-tertiary">Path</span>
                <p className="text-sm text-txt-secondary font-mono mt-0.5">
                  {ffmpeg.ffmpeg_path}
                </p>
              </div>
              {ffmpeg.version && (
                <div>
                  <span className="text-xs text-txt-tertiary">Version</span>
                  <p className="text-sm text-txt-secondary mt-0.5">
                    {ffmpeg.version}
                  </p>
                </div>
              )}
            </div>
            {ffmpeg.message && (
              <p className="text-xs text-txt-tertiary">{ffmpeg.message}</p>
            )}
          </div>
        </Card>
      ) : (
        <Card padding="md">
          <p className="text-sm text-txt-secondary">
            Unable to fetch FFmpeg information.
          </p>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// YouTube Section
// ---------------------------------------------------------------------------

function YouTubeSection() {
  const { toast } = useToast();
  const [channels, setChannels] = useState<Array<{
    id: string; channel_id: string; channel_name: string; is_active: boolean;
    upload_days: string[] | null; upload_time: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);

  const fetchChannels = async () => {
    try {
      const chs = await youtube.listChannels();
      setChannels(chs);
    } catch (err) {
      toast.error('Failed to load YouTube channels', { description: String(err) });
      setChannels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchChannels(); }, []);

  const handleConnect = async () => {
    try {
      const data = await youtube.getAuthUrl();
      window.location.href = data.auth_url;
    } catch (err) {
      toast.error('Failed to start YouTube connection', { description: String(err) });
    }
  };

  const handleDisconnect = async (channelId: string) => {
    try {
      await youtube.disconnect(channelId);
      toast.success('YouTube channel disconnected');
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
    } catch (err) {
      toast.error('Failed to disconnect YouTube channel', { description: String(err) });
    }
  };

  const handleUpdateSchedule = async (
    channelId: string,
    uploadDays: string[] | null,
    uploadTime: string | null,
  ) => {
    try {
      const updated = await youtube.updateChannel(channelId, {
        upload_days: uploadDays,
        upload_time: uploadTime,
      });
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, ...updated } : c)),
      );
    } catch (err) {
      toast.error('Failed to update upload schedule', { description: String(err) });
    }
  };

  if (loading) return <Spinner />;

  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">YouTube Channels</h3>
        <Button variant="primary" size="sm" onClick={() => void handleConnect()}>
          <Youtube size={14} /> Connect Channel
        </Button>
      </div>

      {channels.length === 0 ? (
        <Card padding="md">
          <p className="text-sm text-txt-secondary">
            No YouTube channels connected. Click "Connect Channel" to authorize a YouTube account.
          </p>
        </Card>
      ) : (
        channels.map((ch) => (
          <Card key={ch.id} padding="md">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Youtube size={18} className="text-red-500" />
                <span className="text-sm font-semibold text-txt-primary">{ch.channel_name}</span>
                <Badge variant="success" className="text-[10px]">Connected</Badge>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDisconnect(ch.id)}
                className="text-txt-tertiary hover:text-error"
              >
                Disconnect
              </Button>
            </div>

            {/* Upload schedule */}
            <div className="space-y-2 mt-2">
              <label className="text-xs font-medium text-txt-secondary">Upload Days</label>
              <div className="flex gap-1.5">
                {DAYS.map((day) => {
                  const active = (ch.upload_days || []).includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => {
                        const newDays = active
                          ? (ch.upload_days || []).filter((d) => d !== day)
                          : [...(ch.upload_days || []), day];
                        void handleUpdateSchedule(ch.id, newDays.length > 0 ? newDays : null, ch.upload_time);
                      }}
                      className={[
                        'px-2 py-1 rounded text-[10px] font-medium uppercase transition',
                        active
                          ? 'bg-accent text-white'
                          : 'bg-bg-elevated text-txt-tertiary border border-border hover:border-border-hover',
                      ].join(' ')}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>

              <label className="text-xs font-medium text-txt-secondary">Upload Time</label>
              <input
                type="time"
                value={ch.upload_time || ''}
                onChange={(e) =>
                  void handleUpdateSchedule(ch.id, ch.upload_days, e.target.value || null)
                }
                className="bg-bg-elevated border border-border rounded px-2 py-1 text-sm text-txt-primary w-32"
              />
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Social Media Section
// ---------------------------------------------------------------------------

interface SocialPlatformDef {
  id: string;
  name: string;
  colorClass: string;
  bgClass: string;
  dotClass: string;
  oauth?: boolean;  // true = use OAuth flow instead of manual token
}

const SOCIAL_PLATFORMS: SocialPlatformDef[] = [
  { id: 'tiktok', name: 'TikTok', colorClass: 'text-cyan-400', bgClass: 'bg-cyan-500/10', dotClass: 'bg-cyan-400', oauth: true },
  { id: 'instagram', name: 'Instagram', colorClass: 'text-pink-400', bgClass: 'bg-pink-500/10', dotClass: 'bg-pink-400' },
  { id: 'x', name: 'X (Twitter)', colorClass: 'text-gray-300', bgClass: 'bg-gray-500/10', dotClass: 'bg-gray-300' },
];

interface ConnectFormState {
  accountName: string;
  accessToken: string;
  refreshToken: string;
}

interface PlatformCardProps {
  platform: SocialPlatformDef;
  connectedAccount: SocialPlatform | null;
  onConnect: (platform: string, form: ConnectFormState) => Promise<void>;
  onDisconnect: (platformId: string) => Promise<void>;
}

function PlatformCard({
  platform,
  connectedAccount,
  onConnect,
  onDisconnect,
}: PlatformCardProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const handleConnect = async () => {
    // OAuth flow for platforms that support it
    if (platform.oauth) {
      setConnecting(true);
      setConnectError(null);
      try {
        if (platform.id === 'tiktok') {
          const data = await socialApi.tiktokAuthUrl();
          window.location.href = data.auth_url;
        }
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : 'Failed to start OAuth flow.');
        setConnecting(false);
      }
      return;
    }

    // Manual token entry for other platforms
    if (!accountName.trim() || !accessToken.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await onConnect(platform.id, { accountName, accessToken, refreshToken });
      setFormOpen(false);
      setAccountName('');
      setAccessToken('');
      setRefreshToken('');
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect.');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!connectedAccount) return;
    setDisconnecting(true);
    try {
      await onDisconnect(connectedAccount.id);
    } catch {
      // swallow — parent state will remain until next reload
    } finally {
      setDisconnecting(false);
    }
  };

  const isConnected = connectedAccount !== null;

  return (
    <Card padding="md">
      {/* Platform header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={['w-9 h-9 rounded-lg flex items-center justify-center shrink-0', platform.bgClass].join(' ')}>
            <span className={['w-3 h-3 rounded-full', platform.dotClass].join(' ')} />
          </div>
          <div>
            <p className={['text-sm font-semibold', platform.colorClass].join(' ')}>
              {platform.name}
            </p>
            {isConnected && connectedAccount?.account_name ? (
              <p className="text-xs text-txt-tertiary">
                @{connectedAccount.account_name}
              </p>
            ) : (
              <p className="text-xs text-txt-tertiary">Not connected</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isConnected ? (
            <>
              <Badge variant="success" dot>
                Connected
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                loading={disconnecting}
                onClick={() => void handleDisconnect()}
                className="text-txt-tertiary hover:text-error"
                aria-label={`Disconnect ${platform.name}`}
              >
                <Unlink size={13} />
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <Badge variant="neutral">Not connected</Badge>
              <Button
                variant="secondary"
                size="sm"
                loading={platform.oauth ? connecting : undefined}
                onClick={() => platform.oauth ? void handleConnect() : setFormOpen((v) => !v)}
                aria-expanded={platform.oauth ? undefined : formOpen}
                aria-controls={platform.oauth ? undefined : `connect-form-${platform.id}`}
              >
                {platform.oauth ? (
                  <>
                    <Link2 size={13} />
                    Connect {platform.name}
                  </>
                ) : formOpen ? (
                  <>
                    <ChevronUp size={13} />
                    Cancel
                  </>
                ) : (
                  <>
                    <Plus size={13} />
                    Connect
                  </>
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Connect form (inline, collapsible) */}
      {!isConnected && formOpen && (
        <div
          id={`connect-form-${platform.id}`}
          className="mt-4 space-y-3 pt-4 border-t border-border"
          role="group"
          aria-label={`Connect ${platform.name} account`}
        >
          <div>
            <label
              htmlFor={`${platform.id}-account-name`}
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              Account Name
            </label>
            <Input
              id={`${platform.id}-account-name`}
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="yourhandle"
              aria-required="true"
            />
          </div>

          <div>
            <label
              htmlFor={`${platform.id}-access-token`}
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              API Access Token
            </label>
            <Input
              id={`${platform.id}-access-token`}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="Paste your access token..."
              aria-required="true"
            />
          </div>

          <div>
            <label
              htmlFor={`${platform.id}-refresh-token`}
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              Refresh Token{' '}
              <span className="text-txt-tertiary font-normal">(optional)</span>
            </label>
            <Input
              id={`${platform.id}-refresh-token`}
              type="password"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder="Paste your refresh token..."
            />
          </div>

          {connectError && (
            <div
              className="flex items-center gap-2 text-sm text-error"
              role="alert"
              aria-live="polite"
            >
              <AlertCircle size={13} className="shrink-0" />
              {connectError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFormOpen(false);
                setConnectError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={connecting}
              disabled={!accountName.trim() || !accessToken.trim()}
              onClick={() => void handleConnect()}
            >
              Connect {platform.name}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SocialSection() {
  const { toast } = useToast();
  const [platforms, setPlatforms] = useState<SocialPlatform[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPlatforms = useCallback(async () => {
    setLoading(true);
    try {
      const data = await socialApi.listPlatforms();
      setPlatforms(data);
    } catch (err) {
      toast.error('Failed to load social media accounts', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchPlatforms();
  }, [fetchPlatforms]);

  const handleConnect = useCallback(
    async (platformId: string, form: ConnectFormState) => {
      await socialApi.connectPlatform({
        platform: platformId,
        account_name: form.accountName.trim(),
        access_token: form.accessToken.trim(),
        refresh_token: form.refreshToken.trim() || undefined,
      });
      toast.success('Account connected', { description: `${platformId} account linked` });
      void fetchPlatforms();
    },
    [fetchPlatforms, toast],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      await socialApi.disconnectPlatform(id);
      toast.success('Account disconnected');
      void fetchPlatforms();
    },
    [fetchPlatforms, toast],
  );

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">
            Social Media Accounts
          </h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Connect your social media accounts to post content across platforms.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void fetchPlatforms()}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {/* YouTube (OAuth-based) */}
      <YouTubeSection />

      {/* Other platforms (token-based) */}
      <div className="space-y-3">
        {SOCIAL_PLATFORMS.map((platformDef) => {
          const connected =
            platforms.find((p) => p.platform.toLowerCase() === platformDef.id) ?? null;
          return (
            <PlatformCard
              key={platformDef.id}
              platform={platformDef}
              connectedAccount={connected}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Keys Section
// ---------------------------------------------------------------------------

interface ApiKeyRecord {
  key_name: string;
  created_at: string;
  updated_at: string;
}

interface IntegrationInfo {
  configured: boolean;
  source: string;
}

const INTEGRATION_DEFS: Array<{
  id: string;
  label: string;
  description: string;
  iconBg: string;
  iconColor: string;
}> = [
  {
    id: 'runpod',
    label: 'RunPod',
    description: 'Cloud GPU for image generation',
    iconBg: 'bg-violet-500/10',
    iconColor: 'text-violet-400',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'Premium text-to-speech voices',
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude LLM for script generation',
    iconBg: 'bg-orange-500/10',
    iconColor: 'text-orange-400',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    description: 'Direct video upload via OAuth',
    iconBg: 'bg-red-500/10',
    iconColor: 'text-red-400',
  },
];

const KEY_NAME_OPTIONS = [
  { value: 'runpod', label: 'RunPod API Key' },
  { value: 'elevenlabs', label: 'ElevenLabs API Key' },
  { value: 'anthropic', label: 'Anthropic API Key' },
  { value: 'openai', label: 'OpenAI API Key' },
  { value: 'tiktok_client_key', label: 'TikTok Client Key' },
  { value: 'tiktok_client_secret', label: 'TikTok Client Secret' },
  { value: 'tiktok_redirect_uri', label: 'TikTok Redirect URI' },
  { value: 'instagram', label: 'Instagram API Key' },
  { value: 'youtube_client_id', label: 'YouTube Client ID' },
  { value: 'youtube_client_secret', label: 'YouTube Client Secret' },
  { value: 'hf_token', label: 'HuggingFace Token' },
];

function sourceLabel(source: string): string {
  if (source === 'db') return 'Database';
  if (source === 'env') return 'Environment';
  return source;
}

function sourceBadgeVariant(source: string): string {
  if (source === 'db') return 'accent';
  if (source === 'env') return 'info';
  return 'neutral';
}

function ApiKeysSection({ onNavigateToApiKeys: _onNavigateToApiKeys }: { onNavigateToApiKeys: () => void }) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [integrations, setIntegrations] = useState<Record<string, IntegrationInfo>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form
  const [formKeyName, setFormKeyName] = useState('runpod');
  const [formApiKey, setFormApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setSuccessMsg(null), 3500);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [keysRes, intRes] = await Promise.all([
        apiKeysApi.list(),
        apiKeysApi.integrations(),
      ]);
      setKeys(Array.isArray(keysRes) ? keysRes : (keysRes as any).items ?? []);
      setIntegrations(intRes);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleSave = async () => {
    if (!formKeyName || !formApiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await apiKeysApi.store(formKeyName, formApiKey.trim());
      setFormApiKey('');
      showSuccess(`${formKeyName} API key saved successfully.`);
      void fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (keyName: string) => {
    setDeletingKey(keyName);
    try {
      await apiKeysApi.remove(keyName);
      showSuccess(`${keyName} API key removed.`);
      void fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete API key.');
    } finally {
      setDeletingKey(null);
      setConfirmDelete(null);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-txt-primary">API Keys</h3>
        <p className="text-sm text-txt-secondary mt-0.5">
          Manage encrypted API keys for third-party services. Keys are stored encrypted at rest.
        </p>
      </div>

      {/* Success / Error banners */}
      {successMsg && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-success-muted text-success text-sm"
          role="status"
          aria-live="polite"
        >
          <CheckCircle2 size={14} className="shrink-0" />
          {successMsg}
        </div>
      )}
      {error && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-error-muted text-error text-sm"
          role="alert"
          aria-live="assertive"
        >
          <AlertCircle size={14} className="shrink-0" />
          {error}
          <button
            className="ml-auto text-error/60 hover:text-error transition-colors"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <XCircle size={14} />
          </button>
        </div>
      )}

      {/* Integration Status Grid */}
      <Card padding="md">
        <h4 className="text-sm font-semibold text-txt-primary mb-3 flex items-center gap-2">
          <Zap size={14} className="text-accent" />
          Integration Status
        </h4>
        <div className="grid grid-cols-2 gap-3">
          {INTEGRATION_DEFS.map((def) => {
            const info = integrations[def.id];
            const configured = info?.configured ?? false;
            const source = info?.source ?? 'Not configured';
            return (
              <div
                key={def.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-bg-hover border border-border"
              >
                <div className={['w-8 h-8 rounded-lg flex items-center justify-center shrink-0', def.iconBg].join(' ')}>
                  <Key size={14} className={def.iconColor} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-txt-primary leading-tight">{def.label}</p>
                  <p className="text-[11px] text-txt-tertiary leading-tight mt-0.5 truncate">{def.description}</p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  {configured ? (
                    <CheckCircle2 size={15} className="text-success" aria-label="Configured" />
                  ) : (
                    <XCircle size={15} className="text-txt-tertiary/50" aria-label="Not configured" />
                  )}
                  {configured && (
                    <Badge variant={sourceBadgeVariant(source)} className="text-[10px] leading-none">
                      {sourceLabel(source)}
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Stored Keys List */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
            <Key size={14} className="text-accent" />
            Stored Keys
          </h4>
          <Button variant="ghost" size="sm" onClick={() => void fetchData()}>
            <RefreshCw size={12} />
            Refresh
          </Button>
        </div>

        {keys.length === 0 ? (
          <div className="py-8 text-center">
            <Key size={24} className="mx-auto text-txt-tertiary/40 mb-2" />
            <p className="text-sm text-txt-tertiary">No API keys stored in database.</p>
            <p className="text-xs text-txt-tertiary/70 mt-0.5">
              Keys set via environment variables are shown in Integration Status above.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {(Array.isArray(keys) ? keys : []).map((k) => {
              const intInfo = integrations[k.key_name];
              return (
                <div
                  key={k.key_name}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-bg-hover border border-border group"
                >
                  <div className="w-7 h-7 rounded-md bg-accent-muted flex items-center justify-center shrink-0">
                    <Key size={12} className="text-accent" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-mono font-medium text-txt-primary">{k.key_name}</span>
                      <Badge variant="success" className="text-[10px]">Configured</Badge>
                      {intInfo?.source && (
                        <Badge variant={sourceBadgeVariant(intInfo.source)} className="text-[10px]">
                          {sourceLabel(intInfo.source)}
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-txt-tertiary mt-0.5">
                      Added {new Date(k.created_at).toLocaleDateString()}
                      {k.updated_at !== k.created_at && (
                        <span> · Updated {new Date(k.updated_at).toLocaleDateString()}</span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={deletingKey === k.key_name}
                    onClick={() => setConfirmDelete(k.key_name)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-txt-tertiary hover:text-error shrink-0"
                    aria-label={`Delete ${k.key_name} API key`}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Add New Key */}
      <Card padding="md">
        <h4 className="text-sm font-semibold text-txt-primary mb-3 flex items-center gap-2">
          <Plus size={14} className="text-accent" />
          Add New Key
        </h4>
        <div className="space-y-3">
          <Select
            label="Service"
            value={formKeyName}
            onChange={(e) => setFormKeyName(e.target.value)}
            options={KEY_NAME_OPTIONS}
          />
          <div>
            <label className="block text-xs font-medium text-txt-secondary mb-1" htmlFor="new-api-key-input">
              API Key
            </label>
            <div className="relative">
              <input
                id="new-api-key-input"
                type={showApiKey ? 'text' : 'password'}
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                placeholder="Paste your API key here..."
                className="w-full h-8 pr-10 pl-2.5 text-sm text-txt-primary bg-bg-elevated border border-border rounded placeholder:text-txt-tertiary focus:border-accent focus:shadow-accent-glow transition-all duration-fast font-mono"
                aria-describedby="api-key-hint"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-txt-tertiary hover:text-txt-secondary transition-colors"
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p id="api-key-hint" className="text-[11px] text-txt-tertiary mt-1">
              Your key is encrypted before being stored in the database.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!formKeyName || !formApiKey.trim()}
              onClick={() => void handleSave()}
            >
              <Key size={13} />
              Save Key
            </Button>
          </div>
        </div>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete API Key"
      >
        <p className="text-sm text-txt-secondary">
          Are you sure you want to delete the <strong className="text-txt-primary">{confirmDelete}</strong> API key?
          This action cannot be undone. If the service relies on this key, it will stop working.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deletingKey === confirmDelete}
            onClick={() => confirmDelete && void handleDelete(confirmDelete)}
          >
            <Trash2 size={13} />
            Delete Key
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunPod Cloud GPU Section
// ---------------------------------------------------------------------------

interface RunPodGpuType {
  id: string;
  displayName: string;
  memoryInGb: number;
  secureCloud: boolean;
  communityCloud: boolean;
  securePrice: number | null;
  communityPrice: number | null;
}

interface RunPodTemplate {
  id: string;
  name: string;
  imageName: string | null;
  isPublic: boolean;
  category: string | null;
}

interface RunPodPod {
  id: string;
  name: string;
  desiredStatus: string;
  gpuCount?: number;
  vcpuCount?: number;
  memoryInGb?: number;
  volumeInGb?: number;
  imageName?: string;
  costPerHr?: number;
  runtime?: {
    uptimeInSeconds?: number;
    ports?: Array<{ ip: string; isIpPublic: boolean; privatePort: number; publicPort: number; type: string }>;
    gpus?: Array<{ id: string; gpuUtilPercent: number; memoryUtilPercent: number }>;
  };
  machine?: { gpuDisplayName?: string };
}

type PodStatus = 'RUNNING' | 'STOPPED' | 'STARTING' | 'TERMINATING' | 'PENDING' | 'EXITED';

/** Return the cheapest non-null price for a GPU, or null if none available. */
function cheapestPrice(gpu: RunPodGpuType): number | null {
  const prices = [gpu.securePrice, gpu.communityPrice].filter(
    (p): p is number => p != null && p > 0,
  );
  return prices.length > 0 ? Math.min(...prices) : null;
}

type GpuSortKey = 'price' | 'vram' | 'name';

function podStatusVariant(status: string): string {
  switch (status?.toUpperCase()) {
    case 'RUNNING': return 'success';
    case 'STOPPED': return 'warning';
    case 'STARTING':
    case 'PENDING': return 'info';
    case 'TERMINATING':
    case 'EXITED': return 'error';
    default: return 'neutral';
  }
}

function podStatusLabel(status: string): string {
  if (!status) return 'Unknown';
  const s = status.toUpperCase() as PodStatus;
  if (s === 'RUNNING') return 'Running';
  if (s === 'STOPPED') return 'Stopped';
  if (s === 'STARTING') return 'Starting';
  if (s === 'PENDING') return 'Pending';
  if (s === 'TERMINATING') return 'Terminating';
  if (s === 'EXITED') return 'Exited';
  return status;
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m uptime`;
  return `${m}m uptime`;
}

function formatPrice(price: number | null | undefined): string {
  if (price == null || price <= 0) return '--';
  return `$${price.toFixed(2)}/hr`;
}

function getProxyUrls(pod: RunPodPod): Array<{ port: number; url: string; label: string }> {
  const urls: Array<{ port: number; url: string; label: string }> = [];
  const ports = pod.runtime?.ports ?? [];
  const knownPorts: Record<number, string> = {
    8188: 'ComfyUI',
    1234: 'LM Studio',
    8080: 'HTTP',
    3000: 'Web UI',
    7860: 'Gradio',
    8888: 'Jupyter',
  };
  for (const p of ports) {
    if (p.isIpPublic && p.privatePort) {
      const url = `https://${pod.id}-${p.privatePort}.proxy.runpod.net`;
      const label = knownPorts[p.privatePort] ?? `Port ${p.privatePort}`;
      urls.push({ port: p.privatePort, url, label });
    }
  }
  // Fallback: if no runtime ports, construct standard ComfyUI proxy
  if (urls.length === 0 && pod.id) {
    urls.push({ port: 8188, url: `https://${pod.id}-8188.proxy.runpod.net`, label: 'ComfyUI' });
  }
  return urls;
}

// -- GPU Card Component -------------------------------------------------------

interface GpuCardProps {
  gpu: RunPodGpuType;
  selected: boolean;
  onSelect: () => void;
}

function GpuCard({ gpu, selected, onSelect }: GpuCardProps) {
  const best = cheapestPrice(gpu);
  const available = best != null;

  return (
    <button
      onClick={onSelect}
      disabled={!available}
      className={[
        'relative flex flex-col gap-2 p-3.5 rounded-lg border text-left transition-all duration-fast',
        selected
          ? 'border-accent bg-accent-muted ring-1 ring-accent/30'
          : available
            ? 'border-border bg-bg-secondary hover:border-border-strong hover:bg-bg-hover'
            : 'border-border/50 bg-bg-secondary/50 opacity-50 cursor-not-allowed',
      ].join(' ')}
    >
      {/* GPU name */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu size={14} className={selected ? 'text-accent' : 'text-txt-tertiary'} />
          <span className="text-sm font-semibold text-txt-primary truncate">{gpu.displayName}</span>
        </div>
        {selected && (
          <CheckCircle2 size={14} className="text-accent shrink-0" />
        )}
      </div>

      {/* VRAM */}
      <div className="flex items-center gap-1.5">
        <MemoryStick size={11} className="text-txt-tertiary" />
        <span className="text-xs font-medium text-txt-secondary">{gpu.memoryInGb} GB VRAM</span>
      </div>

      {/* Pricing row */}
      <div className="flex items-center gap-3 mt-0.5">
        {gpu.securePrice != null && gpu.securePrice > 0 && (
          <div className="flex items-center gap-1">
            <CircleDollarSign size={10} className="text-accent" />
            <span className="text-xs font-semibold text-accent">{formatPrice(gpu.securePrice)}</span>
            <span className="text-[10px] text-txt-tertiary">secure</span>
          </div>
        )}
        {gpu.communityPrice != null && gpu.communityPrice > 0 && (
          <div className="flex items-center gap-1">
            <Zap size={10} className="text-info" />
            <span className="text-xs font-semibold text-info">{formatPrice(gpu.communityPrice)}</span>
            <span className="text-[10px] text-txt-tertiary">community</span>
          </div>
        )}
        {!available && (
          <span className="text-xs text-txt-tertiary">Pricing unavailable</span>
        )}
      </div>

      {/* Cloud availability */}
      <div className="flex items-center gap-2 mt-0.5">
        {gpu.secureCloud && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success font-medium">Secure</span>
        )}
        {gpu.communityCloud && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-info/10 text-info font-medium">Community</span>
        )}
        {!gpu.secureCloud && !gpu.communityCloud && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-error/10 text-error font-medium">Unavailable</span>
        )}
      </div>
    </button>
  );
}

// -- Pod Card Component -------------------------------------------------------

interface PodCardProps {
  pod: RunPodPod;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  onRegister: (id: string) => Promise<void>;
  onRegisterLlm: (id: string) => Promise<void>;
}

function PodCard({ pod, onStart, onStop, onDelete, onRegister, onRegisterLlm }: PodCardProps) {
  const [actioning, setActioning] = useState<string | null>(null);
  const status = (pod.desiredStatus ?? '').toUpperCase();
  const isRunning = status === 'RUNNING';
  const isStopped = status === 'STOPPED' || status === 'EXITED';
  const isPending = status === 'STARTING' || status === 'PENDING' || status === 'TERMINATING';
  const proxyUrls = getProxyUrls(pod);

  const doAction = async (action: string, fn: () => Promise<void>) => {
    setActioning(action);
    try {
      await fn();
    } finally {
      setActioning(null);
    }
  };

  return (
    <Card padding="md" className="flex flex-col gap-3 hover:border-border-strong transition-colors duration-fast">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className={[
              'w-2.5 h-2.5 rounded-full shrink-0',
              isRunning ? 'bg-success animate-pulse' : isPending ? 'bg-info animate-pulse' : 'bg-txt-tertiary/40',
            ].join(' ')} />
            <h4 className="text-sm font-semibold text-txt-primary truncate">{pod.name}</h4>
            <Badge variant={podStatusVariant(pod.desiredStatus)}>
              {podStatusLabel(pod.desiredStatus)}
            </Badge>
          </div>
          <p className="text-[11px] text-txt-tertiary font-mono mt-1 truncate">ID: {pod.id}</p>
        </div>
        {pod.costPerHr != null && pod.costPerHr > 0 && (
          <div className="shrink-0 flex items-center gap-1 text-xs font-semibold text-accent bg-accent-muted px-2.5 py-1 rounded-full">
            <CircleDollarSign size={12} />
            ${pod.costPerHr.toFixed(3)}/hr
          </div>
        )}
      </div>

      {/* Info grid */}
      <div className="flex items-center gap-2 flex-wrap">
        {pod.machine?.gpuDisplayName && (
          <div className="flex items-center gap-1.5 text-xs text-txt-secondary bg-bg-hover px-2 py-1 rounded-md">
            <Cpu size={11} className="text-accent" />
            {pod.machine.gpuDisplayName}
            {pod.gpuCount != null && pod.gpuCount > 1 && (
              <span className="text-txt-tertiary font-medium">x{pod.gpuCount}</span>
            )}
          </div>
        )}
        {pod.memoryInGb != null && (
          <div className="flex items-center gap-1.5 text-xs text-txt-secondary bg-bg-hover px-2 py-1 rounded-md">
            <MemoryStick size={11} className="text-txt-tertiary" />
            {pod.memoryInGb} GB RAM
          </div>
        )}
        {pod.volumeInGb != null && (
          <div className="flex items-center gap-1.5 text-xs text-txt-secondary bg-bg-hover px-2 py-1 rounded-md">
            <HardDrive size={11} className="text-txt-tertiary" />
            {pod.volumeInGb} GB Vol
          </div>
        )}
        {pod.imageName && (
          <div className="flex items-center gap-1.5 text-xs text-txt-secondary bg-bg-hover px-2 py-1 rounded-md truncate max-w-[220px]">
            <SquareTerminal size={11} className="text-txt-tertiary" />
            <span className="truncate">{pod.imageName.split('/').pop()}</span>
          </div>
        )}
        {pod.runtime?.uptimeInSeconds != null && pod.runtime.uptimeInSeconds > 0 && (
          <span className="text-[11px] text-txt-tertiary italic">
            {formatUptime(pod.runtime.uptimeInSeconds)}
          </span>
        )}
      </div>

      {/* GPU utilization bars */}
      {isRunning && pod.runtime?.gpus && pod.runtime.gpus.length > 0 && (
        <div className="space-y-1.5">
          {pod.runtime.gpus.map((gpu, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-txt-tertiary">
                <span>GPU Utilization</span>
                <span className="font-medium text-txt-secondary">{gpu.gpuUtilPercent}%</span>
              </div>
              <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                <div
                  className={[
                    'h-full rounded-full transition-all duration-300',
                    gpu.gpuUtilPercent > 80 ? 'bg-error' : gpu.gpuUtilPercent > 50 ? 'bg-warning' : 'bg-accent',
                  ].join(' ')}
                  style={{ width: `${Math.min(gpu.gpuUtilPercent, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-txt-tertiary">
                <span>VRAM Usage</span>
                <span className="font-medium text-txt-secondary">{gpu.memoryUtilPercent}%</span>
              </div>
              <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                <div
                  className={[
                    'h-full rounded-full transition-all duration-300',
                    gpu.memoryUtilPercent > 80 ? 'bg-error' : gpu.memoryUtilPercent > 50 ? 'bg-warning' : 'bg-accent',
                  ].join(' ')}
                  style={{ width: `${Math.min(gpu.memoryUtilPercent, 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Proxy URLs when running */}
      {isRunning && proxyUrls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {proxyUrls.map(({ port, url, label }) => (
            <a
              key={port}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors font-mono bg-accent-muted px-2.5 py-1.5 rounded-md w-fit"
            >
              <Link2 size={11} />
              <span className="font-sans font-medium mr-1">{label}:</span>
              {url}
            </a>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-border flex-wrap">
        {isStopped && (
          <Button
            variant="ghost"
            size="sm"
            loading={actioning === 'start'}
            disabled={isPending || actioning !== null}
            onClick={() => void doAction('start', () => onStart(pod.id))}
          >
            <Play size={12} />
            Start
          </Button>
        )}
        {isRunning && (
          <Button
            variant="ghost"
            size="sm"
            loading={actioning === 'stop'}
            disabled={actioning !== null}
            onClick={() => void doAction('stop', () => onStop(pod.id))}
          >
            <StopCircle size={12} />
            Stop
          </Button>
        )}
        {isRunning && (() => {
          const img = (pod.imageName ?? '').toLowerCase();
          const name = (pod.name ?? '').toLowerCase();
          const isComfyPod = img.includes('comfyui') || name.includes('comfyui') || name.includes('comfy') || name.startsWith('comfyui-');
          const isLlmPod = img.includes('vllm') || img.includes('ollama') || img.includes('tgi') || name.includes('llm') || name.includes('vllm') || name.startsWith('vllm-');
          return (
            <>
              {isComfyPod && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={actioning === 'register'}
                  disabled={actioning !== null}
                  onClick={() => void doAction('register', () => onRegister(pod.id))}
                  title="Register as ComfyUI server"
                >
                  <Server size={12} />
                  Register ComfyUI
                </Button>
              )}
              {isLlmPod && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={actioning === 'register-llm'}
                  disabled={actioning !== null}
                  onClick={() => void doAction('register-llm', () => onRegisterLlm(pod.id))}
                  title="Register as LLM server"
                >
                  <Cpu size={12} />
                  Register LLM
                </Button>
              )}
              {!isComfyPod && !isLlmPod && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={actioning === 'register'}
                    disabled={actioning !== null}
                    onClick={() => void doAction('register', () => onRegister(pod.id))}
                    title="Register as ComfyUI server"
                  >
                    <Server size={12} />
                    Register ComfyUI
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={actioning === 'register-llm'}
                    disabled={actioning !== null}
                    onClick={() => void doAction('register-llm', () => onRegisterLlm(pod.id))}
                    title="Register as LLM server"
                  >
                    <Cpu size={12} />
                    Register LLM
                  </Button>
                </>
              )}
            </>
          );
        })()}
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending || actioning !== null}
          onClick={() => onDelete(pod.id)}
          className="ml-auto text-txt-tertiary hover:text-error"
          aria-label={`Delete pod ${pod.name}`}
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </Card>
  );
}

// -- Main RunPod Section Component --------------------------------------------

function RunPodSection({ onNavigateToApiKeys }: { onNavigateToApiKeys: () => void }) {
  const [pods, setPods] = useState<RunPodPod[]>([]);
  const [gpuTypes, setGpuTypes] = useState<RunPodGpuType[]>([]);
  const [templates, setTemplates] = useState<RunPodTemplate[]>([]);
  const [templateSearch, setTemplateSearch] = useState('');
  const [integrations, setIntegrations] = useState<Record<string, { configured: boolean; source: string }>>({});
  const [loading, setLoading] = useState(true);
  const [creatingPod, setCreatingPod] = useState(false);
  const [confirmDeletePod, setConfirmDeletePod] = useState<RunPodPod | null>(null);
  const [deletingPod, setDeletingPod] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDeploy, setConfirmDeploy] = useState<{
    label: string; type: string; gpuId: string; gpu: string;
    vram: number; price: string; volume: number; desc: string; ports: string;
    templateName?: string;
  } | null>(null);

  const [deployingPods, setDeployingPods] = useState<Map<string, { status: string; message: string; registered?: boolean; service_url?: string }>>(new Map());

  // Create form state
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [podName, setPodName] = useState('');
  const [selectedGpu, setSelectedGpu] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [customImage, setCustomImage] = useState('');
  const [useCustomImage, setUseCustomImage] = useState(false);
  const [volumeGb, setVolumeGb] = useState(20);
  const [gpuCount, setGpuCount] = useState(1);
  const [ports, setPorts] = useState('8188/http,1234/http');

  // GPU filter/sort state
  const [gpuSearch, setGpuSearch] = useState('');
  const [gpuSort, setGpuSort] = useState<GpuSortKey>('price');
  const [vramRange, setVramRange] = useState<[number, number]>([0, 999]);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRegisterSuccess = (podId: string) => {
    setRegisterSuccess(podId);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setRegisterSuccess(null), 4000);
  };

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const intRes = await apiKeysApi.integrations().catch(() => ({} as Record<string, { configured: boolean; source: string }>));
      setIntegrations(intRes);

      const configured = intRes?.runpod?.configured ?? false;
      if (configured) {
        const [podsRes, gpuRes, tplRes] = await Promise.all([
          runpodApi.listPods().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : '';
            if (msg.includes('401') || msg.includes('403')) {
              setError('Invalid RunPod API key. Please check your key in the API Keys section.');
            } else if (msg.includes('429')) {
              setError('RunPod rate limit exceeded. Please wait a moment and try again.');
            }
            return [] as RunPodPod[];
          }),
          runpodApi.gpuTypes().catch(() => [] as RunPodGpuType[]),
          runpodApi.templates().catch(() => [] as RunPodTemplate[]),
        ]);
        setPods(podsRes);
        setGpuTypes(gpuRes);
        setTemplates(tplRes);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load RunPod data.';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // -- GPU filtering & sorting ------------------------------------------------

  const filteredGpus = gpuTypes
    .filter((g) => {
      if (gpuSearch) {
        const q = gpuSearch.toLowerCase();
        if (!g.displayName.toLowerCase().includes(q) && !g.id.toLowerCase().includes(q)) return false;
      }
      if (g.memoryInGb < vramRange[0] || g.memoryInGb > vramRange[1]) return false;
      return true;
    })
    .sort((a, b) => {
      if (gpuSort === 'price') {
        const pa = cheapestPrice(a) ?? Infinity;
        const pb = cheapestPrice(b) ?? Infinity;
        return pa - pb;
      }
      if (gpuSort === 'vram') return b.memoryInGb - a.memoryInGb;
      return a.displayName.localeCompare(b.displayName);
    });

  // Filter templates by search query (or show curated defaults)
  const relevantTemplates = templates.filter((t) => {
    const name = (t.name ?? '').toLowerCase();
    const cat = (t.category ?? '').toLowerCase();
    const image = (t.imageName ?? '').toLowerCase();
    const q = templateSearch.toLowerCase().trim();

    if (q) {
      // User is searching — match against name, category, image
      return name.includes(q) || cat.includes(q) || image.includes(q);
    }
    // Default: show ComfyUI, PyTorch, Stable Diffusion templates
    return (
      name.includes('comfyui') || cat.includes('comfyui') ||
      name.includes('pytorch') || cat.includes('pytorch') ||
      name.includes('stable diffusion') || name.includes('sd') ||
      image.includes('comfyui') || image.includes('pytorch')
    );
  });

  // Unique VRAM values for the filter presets
  const vramValues = [...new Set(gpuTypes.map((g) => g.memoryInGb))].sort((a, b) => a - b);
  const vramPresets = [
    { label: 'All', min: 0, max: 999 },
    ...(vramValues.some((v) => v <= 16) ? [{ label: '8-16 GB', min: 8, max: 16 }] : []),
    ...(vramValues.some((v) => v >= 24 && v <= 48) ? [{ label: '24-48 GB', min: 24, max: 48 }] : []),
    ...(vramValues.some((v) => v >= 80) ? [{ label: '80+ GB', min: 80, max: 999 }] : []),
  ];

  // -- Pod creation -----------------------------------------------------------

  const selectedGpuType = gpuTypes.find((g) => g.id === selectedGpu);
  const selectedTpl = templates.find((t) => t.id === selectedTemplate);
  const dockerImage = useCustomImage ? customImage : (selectedTpl?.imageName ?? '');
  const gpuBestPrice = selectedGpuType ? cheapestPrice(selectedGpuType) : null;
  const estimatedCost = gpuBestPrice != null ? gpuBestPrice * gpuCount : null;

  const handleCreatePod = async () => {
    if (!podName.trim() || !selectedGpu) return;
    setCreatingPod(true);
    setError(null);
    try {
      await runpodApi.createPod({
        name: podName.trim(),
        gpu_type_id: selectedGpu,
        image: dockerImage || undefined,
        gpu_count: gpuCount,
        volume_gb: volumeGb,
        ports: ports || '8188/http',
        template_id: selectedTemplate ?? undefined,
      });
      // Reset form
      setPodName('');
      setSelectedGpu('');
      setSelectedTemplate(null);
      setCustomImage('');
      setUseCustomImage(false);
      setVolumeGb(20);
      setGpuCount(1);
      setPorts('8188/http,1234/http');
      setCreateFormOpen(false);
      void fetchData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pod.');
    } finally {
      setCreatingPod(false);
    }
  };

  const handleStart = async (podId: string) => {
    setError(null);
    try {
      await runpodApi.startPod(podId);
      void fetchData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start pod.');
    }
  };

  const handleStop = async (podId: string) => {
    setError(null);
    try {
      await runpodApi.stopPod(podId);
      void fetchData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop pod.');
    }
  };

  const handleDelete = async (podId: string) => {
    setDeletingPod(podId);
    setError(null);
    try {
      await runpodApi.deletePod(podId);
      setConfirmDeletePod(null);
      void fetchData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete pod.');
    } finally {
      setDeletingPod(null);
    }
  };

  const handleRegister = async (podId: string) => {
    setError(null);
    try {
      await runpodApi.registerPod(podId, 8188);
      showRegisterSuccess(podId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register pod as ComfyUI server.');
    }
  };

  const handleRegisterLlm = async (podId: string) => {
    setError(null);
    try {
      const result = await runpodApi.registerLlm(podId);
      setRegisterSuccess(`LLM registered: ${result.model_name ?? 'auto'} at ${result.llm_url ?? 'unknown'}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register pod as LLM server.');
    }
  };

  const isConfigured = integrations?.runpod?.configured ?? false;

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary flex items-center gap-2">
            <Cloud size={18} className="text-accent" />
            Cloud GPU -- RunPod
          </h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Provision cloud GPUs for image generation and LLM inference. Register running pods as ComfyUI servers.
          </p>
        </div>
        {isConfigured && (
          <Button
            variant="ghost"
            size="sm"
            loading={refreshing}
            onClick={() => void fetchData(true)}
          >
            <RefreshCw size={13} />
            Refresh
          </Button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-error-muted text-error text-sm"
          role="alert"
          aria-live="assertive"
        >
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            className="text-error/60 hover:text-error transition-colors"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <XCircle size={14} />
          </button>
        </div>
      )}

      {/* Not configured warning */}
      {!isConfigured && (
        <Card padding="md" className="border-warning/30 bg-warning-muted">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center shrink-0 mt-0.5">
              <AlertCircle size={18} className="text-warning" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-txt-primary">RunPod API Key Required</h4>
              <p className="text-sm text-txt-secondary mt-1">
                To manage cloud GPU pods, add your RunPod API key first. You can find it in your{' '}
                <a href="https://www.runpod.io/console/user/settings" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">RunPod account settings</a>.
              </p>
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                onClick={onNavigateToApiKeys}
              >
                <Key size={13} />
                Go to API Keys
              </Button>
            </div>
          </div>
        </Card>
      )}

      {isConfigured && (
        <>
          {/* Connection status */}
          <Card padding="sm" className="border-success/30 bg-success-muted">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
              <span className="text-sm font-medium text-success">Connected to RunPod</span>
              <span className="text-xs text-txt-tertiary ml-1">
                ({gpuTypes.length} GPU type{gpuTypes.length !== 1 ? 's' : ''} available)
              </span>
              <Badge variant="success" className="text-[10px] ml-auto">
                {sourceLabel(integrations.runpod?.source ?? 'db')}
              </Badge>
            </div>
          </Card>

          {/* ============================================================== */}
          {/* Quick Deploy Presets                                             */}
          {/* ============================================================== */}
          <Card padding="md">
            <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-2 mb-3">
              <Zap size={14} className="text-accent" />
              Quick Deploy
            </h4>
            <p className="text-xs text-txt-tertiary mb-4">
              Pre-configured pods ready to deploy. Click to start with optimal settings.
            </p>

            {(() => {
              const COMFYUI_TIERS = [
                { label: 'Budget', gpu: 'RTX A4000', gpuId: 'NVIDIA RTX A4000', vram: 16, price: '~$0.17', volume: 30, desc: 'SD 1.5, basic workflows', ports: '8188/http' },
                { label: 'Standard', gpu: 'RTX 4090', gpuId: 'NVIDIA GeForce RTX 4090', vram: 24, price: '~$0.34', volume: 50, desc: 'SDXL, Wan 2.2, most workflows', ports: '8188/http' },
                { label: 'Pro', gpu: 'RTX A6000', gpuId: 'NVIDIA RTX A6000', vram: 48, price: '~$0.33', volume: 75, desc: 'Large models, video gen, batch', ports: '8188/http' },
                { label: 'Pro+', gpu: 'L40S', gpuId: 'NVIDIA L40S', vram: 48, price: '~$0.79', volume: 75, desc: 'Ada gen, fast video, pro workflows', ports: '8188/http' },
                { label: 'Ultra', gpu: 'A100 80GB', gpuId: 'NVIDIA A100 80GB PCIe', vram: 80, price: '~$1.19', volume: 100, desc: '80GB VRAM, large models + video', ports: '8188/http' },
                { label: 'Ultra+', gpu: 'H200 SXM', gpuId: 'NVIDIA H200', vram: 141, price: '~$3.59', volume: 150, desc: '141GB HBM3e, fastest generation', ports: '8188/http' },
              ];
              const LLM_TIERS = [
                { label: 'Budget', gpu: 'RTX 4090', gpuId: 'NVIDIA GeForce RTX 4090', vram: 24, price: '~$0.34', volume: 40, desc: 'Qwen 7B — fast scripts', ports: '8000/http', model: 'Qwen/Qwen2.5-7B-Instruct' },
                { label: 'Standard', gpu: 'RTX A6000', gpuId: 'NVIDIA RTX A6000', vram: 48, price: '~$0.33', volume: 60, desc: 'Qwen 32B AWQ — best value', ports: '8000/http', model: 'Qwen/Qwen2.5-32B-Instruct-AWQ' },
                { label: 'Pro', gpu: 'A100 80GB', gpuId: 'NVIDIA A100 80GB PCIe', vram: 80, price: '~$1.19', volume: 100, desc: 'Qwen 72B AWQ — top quality', ports: '8000/http', model: 'Qwen/Qwen2.5-72B-Instruct-AWQ' },
                { label: 'Ultra', gpu: 'H100 SXM', gpuId: 'NVIDIA H100 80GB HBM3', vram: 80, price: '~$2.69', volume: 150, desc: 'Qwen 72B AWQ — fastest inference', ports: '8000/http', model: 'Qwen/Qwen2.5-72B-Instruct-AWQ' },
                { label: 'Ultra+', gpu: 'H200 SXM', gpuId: 'NVIDIA H200', vram: 141, price: '~$3.59', volume: 200, desc: 'Qwen 72B FP16 — full precision', ports: '8000/http', model: 'Qwen/Qwen2.5-72B-Instruct' },
              ];

              const renderTierGrid = (tiers: typeof COMFYUI_TIERS, type: string) => (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {tiers.map((tier) => (
                    <button
                      key={tier.label}
                      disabled={creatingPod}
                      onClick={() => setConfirmDeploy({ ...tier, type })}
                      className="flex flex-col p-3 rounded-lg border border-border bg-bg-elevated hover:border-accent/50 hover:bg-bg-hover transition-all text-left"
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className="text-xs font-bold text-txt-primary">{tier.label}</span>
                        <span className="text-[10px] font-mono text-accent">{tier.price}/hr</span>
                      </div>
                      <span className="text-[10px] text-txt-secondary">{tier.gpu} · {tier.vram}GB</span>
                      <span className="text-[10px] text-txt-tertiary mt-1">{tier.desc}</span>
                    </button>
                  ))}
                </div>
              );

              return (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-txt-tertiary mb-2">ComfyUI — Image & Video Generation</p>
                    {renderTierGrid(COMFYUI_TIERS, 'comfyui')}
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-txt-tertiary mb-2">vLLM — Script & AI Generation</p>
                    {renderTierGrid(LLM_TIERS, 'vllm')}
                  </div>
                </div>
              );
            })()}

            {/* Confirm Deploy Dialog */}
            <Dialog open={confirmDeploy !== null} onClose={() => setConfirmDeploy(null)} title="Confirm Deployment">
              {confirmDeploy && (
                <div className="space-y-3">
                  <p className="text-sm text-txt-primary">
                    Deploy a <strong>{confirmDeploy.type === 'comfyui' ? 'ComfyUI' : 'vLLM'}</strong> pod?
                  </p>
                  <div className="bg-bg-elevated rounded-lg p-3 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-txt-secondary">GPU</span>
                      <span className="text-txt-primary font-medium">{confirmDeploy.gpu} ({confirmDeploy.vram}GB)</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-txt-secondary">Cost</span>
                      <span className="text-accent font-mono">{confirmDeploy.price}/hr</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-txt-secondary">Storage</span>
                      <span className="text-txt-primary">{confirmDeploy.volume}GB</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-txt-tertiary">
                    You will be charged by RunPod for the time the pod is running. Stop the pod when not in use.
                  </p>
                </div>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirmDeploy(null)}>Cancel</Button>
                <Button
                  variant="primary"
                  loading={creatingPod}
                  onClick={async () => {
                    if (!confirmDeploy) return;
                    setCreatingPod(true);
                    setError(null);
                    try {
                      const isComfy = confirmDeploy.type === 'comfyui';
                      let result: any;

                      if (isComfy) {
                        // ComfyUI: use runpod/comfyui image WITHOUT template
                        // docker_args runs setup script that installs models + nodes, then starts ComfyUI
                        const setupCmd = [
                          'bash -c "',
                          'cd /workspace/ComfyUI 2>/dev/null || cd /workspace/runpod-slim/ComfyUI 2>/dev/null || { echo No ComfyUI found; exit 1; };',
                          // Install API nodes (ElevenLabs, AceStep)
                          'cd custom_nodes; git clone https://github.com/comfyanonymous/ComfyUI_api_nodes.git 2>/dev/null; cd ..;',
                          'pip install -q -r custom_nodes/ComfyUI_api_nodes/requirements.txt 2>/dev/null;',
                          // Qwen Image models
                          'cd models; mkdir -p unet clip vae;',
                          '[ -f unet/qwen_image_2512_fp8_e4m3fn.safetensors ] || wget -q -O unet/qwen_image_2512_fp8_e4m3fn.safetensors https://huggingface.co/Comfy-Org/Qwen2.5-VL-Image-Diffusion/resolve/main/qwen_image_2512_fp8_e4m3fn.safetensors;',
                          '[ -f clip/qwen_2.5_vl_7b_fp8_scaled.safetensors ] || wget -q -O clip/qwen_2.5_vl_7b_fp8_scaled.safetensors https://huggingface.co/Comfy-Org/Qwen2.5-VL-Image-Diffusion/resolve/main/qwen_2.5_vl_7b_fp8_scaled.safetensors;',
                          '[ -f vae/qwen_image_vae.safetensors ] || wget -q -O vae/qwen_image_vae.safetensors https://huggingface.co/Comfy-Org/Qwen2.5-VL-Image-Diffusion/resolve/main/qwen_image_vae.safetensors;',
                          // AceStep music models
                          '[ -f unet/acestep_v1.5_turbo.safetensors ] || wget -q -O unet/acestep_v1.5_turbo.safetensors https://huggingface.co/AceStep/AceStep-v1-5-turbo/resolve/main/acestep_v1.5_turbo.safetensors;',
                          '[ -f clip/qwen_0.6b_ace15.safetensors ] || wget -q -O clip/qwen_0.6b_ace15.safetensors https://huggingface.co/AceStep/AceStep-v1-5/resolve/main/qwen_0.6b_ace15.safetensors;',
                          '[ -f clip/qwen_1.7b_ace15.safetensors ] || wget -q -O clip/qwen_1.7b_ace15.safetensors https://huggingface.co/AceStep/AceStep-v1-5/resolve/main/qwen_1.7b_ace15.safetensors;',
                          '[ -f vae/ace_1.5_vae.safetensors ] || wget -q -O vae/ace_1.5_vae.safetensors https://huggingface.co/AceStep/AceStep-v1-5/resolve/main/ace_1.5_vae.safetensors;',
                          'cd ..;',
                          // Start ComfyUI
                          'python main.py --listen 0.0.0.0 --port 8188',
                          '"',
                        ].join(' ');

                        result = await runpodApi.createPod({
                          name: `comfyui-${confirmDeploy.label.toLowerCase()}`,
                          gpu_type_id: confirmDeploy.gpuId,
                          image: 'runpod/comfyui:latest',
                          volume_gb: confirmDeploy.volume,
                          ports: confirmDeploy.ports,
                          docker_args: setupCmd,
                        });
                      } else {
                        // vLLM: use raw vllm image WITHOUT template (template forces API key)
                        // Start vLLM without --api-key so RunPod proxy works
                        const model = (confirmDeploy as any).model ?? 'Qwen/Qwen2.5-7B-Instruct';
                        result = await runpodApi.createPod({
                          name: `vllm-${confirmDeploy.label.toLowerCase()}`,
                          gpu_type_id: confirmDeploy.gpuId,
                          image: 'vllm/vllm-openai:v0.6.6',
                          volume_gb: confirmDeploy.volume,
                          ports: confirmDeploy.ports,
                          docker_args: model.includes('AWQ')
                            ? `--model ${model} --host 0.0.0.0 --port 8000 --quantization awq --dtype float16`
                            : `--model ${model} --host 0.0.0.0 --port 8000 --dtype auto`,
                          env: {
                            HF_HUB_ENABLE_HF_TRANSFER: '1',
                          },
                        });
                      }

                      const newPodId = result?.id;
                      if (newPodId) {
                        // Start polling deploy status
                        setDeployingPods(prev => new Map(prev).set(newPodId, { status: 'deploying', message: 'Creating pod...' }));

                        const pollInterval = setInterval(async () => {
                          try {
                            const statusData = await runpodApi.deployStatus(newPodId);
                            setDeployingPods(prev => {
                              const next = new Map(prev);
                              next.set(newPodId, statusData);
                              return next;
                            });

                            if (statusData.status === 'ready' || statusData.status === 'failed') {
                              clearInterval(pollInterval);
                              void fetchData(true);
                            }
                          } catch {
                            // Keep polling on transient errors
                          }
                        }, 5000);
                      }

                      setConfirmDeploy(null);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Deploy failed');
                    } finally {
                      setCreatingPod(false);
                    }
                  }}
                >
                  <Zap size={14} />
                  Deploy Now
                </Button>
              </DialogFooter>
            </Dialog>
          </Card>

          {/* ============================================================== */}
          {/* Custom Deploy Section                                           */}
          {/* ============================================================== */}
          <Card padding="md">
            <button
              className="flex items-center justify-between w-full"
              onClick={() => setCreateFormOpen((v) => !v)}
              aria-expanded={createFormOpen}
            >
              <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
                <Plus size={14} className="text-accent" />
                Custom Deploy
              </h4>
              {createFormOpen ? <ChevronUp size={14} className="text-txt-tertiary" /> : <ChevronDown size={14} className="text-txt-tertiary" />}
            </button>

            {createFormOpen && (
              <div className="mt-4 space-y-5 border-t border-border pt-4">

                {/* Step 1: Pod Name */}
                <Input
                  label="Pod Name"
                  value={podName}
                  onChange={(e) => setPodName(e.target.value)}
                  placeholder="my-comfyui-pod"
                />

                {/* Step 2: GPU Type Selector */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-txt-secondary flex items-center gap-1.5">
                      <Cpu size={12} />
                      Select GPU
                    </label>
                    {selectedGpuType && (
                      <span className="text-xs text-accent font-medium">
                        Selected: {selectedGpuType.displayName} ({selectedGpuType.memoryInGb} GB)
                      </span>
                    )}
                  </div>

                  {/* Search & filters bar */}
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <div className="relative flex-1 min-w-[180px]">
                      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-tertiary" />
                      <input
                        type="text"
                        value={gpuSearch}
                        onChange={(e) => setGpuSearch(e.target.value)}
                        placeholder="Search GPUs..."
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-bg-secondary border border-border rounded-md text-txt-primary placeholder:text-txt-tertiary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                      />
                    </div>
                    {/* VRAM filter presets */}
                    <div className="flex items-center gap-1">
                      <MemoryStick size={12} className="text-txt-tertiary mr-0.5" />
                      {vramPresets.map((p) => (
                        <button
                          key={p.label}
                          onClick={() => setVramRange([p.min, p.max])}
                          className={[
                            'px-2 py-1 text-[10px] font-medium rounded-md transition-colors',
                            vramRange[0] === p.min && vramRange[1] === p.max
                              ? 'bg-accent text-white'
                              : 'bg-bg-hover text-txt-secondary hover:bg-bg-secondary',
                          ].join(' ')}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {/* Sort */}
                    <div className="flex items-center gap-1">
                      <ArrowUpDown size={12} className="text-txt-tertiary" />
                      {(['price', 'vram', 'name'] as GpuSortKey[]).map((key) => (
                        <button
                          key={key}
                          onClick={() => setGpuSort(key)}
                          className={[
                            'px-2 py-1 text-[10px] font-medium rounded-md transition-colors capitalize',
                            gpuSort === key
                              ? 'bg-accent text-white'
                              : 'bg-bg-hover text-txt-secondary hover:bg-bg-secondary',
                          ].join(' ')}
                        >
                          {key}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* GPU card grid */}
                  {filteredGpus.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 max-h-[320px] overflow-y-auto pr-1">
                      {filteredGpus.map((gpu) => (
                        <GpuCard
                          key={gpu.id}
                          gpu={gpu}
                          selected={selectedGpu === gpu.id}
                          onSelect={() => setSelectedGpu(gpu.id)}
                        />
                      ))}
                    </div>
                  ) : gpuTypes.length === 0 ? (
                    <div className="py-6 text-center text-sm text-txt-tertiary">
                      <Spinner />
                      <p className="mt-2">Loading GPU types...</p>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-sm text-txt-tertiary">
                      No GPUs match your filters. Try adjusting the VRAM range or search term.
                    </div>
                  )}
                </div>

                {/* Step 3: Template / Docker Image */}
                <div>
                  <label className="text-xs font-medium text-txt-secondary flex items-center gap-1.5 mb-2">
                    <Monitor size={12} />
                    Pod Template
                  </label>

                  {/* Template search */}
                  <input
                    type="text"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Search templates (e.g. comfyui, pytorch, llama)..."
                    className="w-full h-8 px-2.5 mb-2 text-sm text-txt-primary bg-bg-elevated border border-border rounded placeholder:text-txt-tertiary focus:border-accent transition-all duration-fast"
                  />

                  {/* Template cards */}
                  {relevantTemplates.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 mb-2 max-h-[200px] overflow-y-auto pr-1">
                      {relevantTemplates.map((tpl) => (
                        <button
                          key={tpl.id}
                          onClick={() => {
                            setSelectedTemplate(selectedTemplate === tpl.id ? null : tpl.id);
                            setUseCustomImage(false);
                          }}
                          className={[
                            'flex flex-col gap-1 p-3 rounded-lg border text-left transition-all duration-fast',
                            selectedTemplate === tpl.id
                              ? 'border-accent bg-accent-muted ring-1 ring-accent/30'
                              : 'border-border bg-bg-secondary hover:border-border-strong hover:bg-bg-hover',
                          ].join(' ')}
                        >
                          <div className="flex items-center gap-2">
                            {(tpl.name ?? '').toLowerCase().includes('comfyui')
                              ? <Cpu size={13} className={selectedTemplate === tpl.id ? 'text-accent' : 'text-txt-tertiary'} />
                              : <Brain size={13} className={selectedTemplate === tpl.id ? 'text-accent' : 'text-txt-tertiary'} />}
                            <span className="text-xs font-semibold text-txt-primary truncate">{tpl.name}</span>
                            {selectedTemplate === tpl.id && (
                              <CheckCircle2 size={12} className="text-accent ml-auto shrink-0" />
                            )}
                          </div>
                          {tpl.category && (
                            <span className="text-[10px] text-txt-tertiary">{tpl.category}</span>
                          )}
                          {tpl.imageName && (
                            <span className="text-[10px] text-txt-tertiary font-mono truncate">{tpl.imageName}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="py-3 text-center text-xs text-txt-tertiary mb-2">
                      No relevant templates found. Use a custom Docker image below.
                    </div>
                  )}

                  {/* Custom image toggle */}
                  <button
                    onClick={() => {
                      setUseCustomImage(!useCustomImage);
                      if (!useCustomImage) setSelectedTemplate(null);
                    }}
                    className={[
                      'flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all duration-fast w-full',
                      useCustomImage
                        ? 'border-accent bg-accent-muted ring-1 ring-accent/30'
                        : 'border-border bg-bg-secondary hover:border-border-strong hover:bg-bg-hover',
                    ].join(' ')}
                  >
                    <SquareTerminal size={13} className={useCustomImage ? 'text-accent' : 'text-txt-tertiary'} />
                    <span className="text-xs font-semibold text-txt-primary">Custom Docker Image</span>
                    {useCustomImage && <CheckCircle2 size={12} className="text-accent ml-auto" />}
                  </button>
                  {useCustomImage && (
                    <Input
                      label=""
                      value={customImage}
                      onChange={(e) => setCustomImage(e.target.value)}
                      placeholder="e.g. pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime"
                      className="mt-2"
                    />
                  )}
                </div>

                {/* Step 4: Configuration row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {/* Volume size */}
                  <div>
                    <label className="text-xs font-medium text-txt-secondary mb-1 flex items-center gap-1.5">
                      <HardDrive size={11} />
                      Volume ({volumeGb} GB)
                    </label>
                    <input
                      type="range"
                      min={5}
                      max={100}
                      step={5}
                      value={volumeGb}
                      onChange={(e) => setVolumeGb(Number(e.target.value))}
                      className="w-full h-1.5 bg-bg-hover rounded-full appearance-none cursor-pointer accent-accent"
                    />
                    <div className="flex justify-between text-[10px] text-txt-tertiary mt-0.5">
                      <span>5 GB</span>
                      <span>100 GB</span>
                    </div>
                  </div>

                  {/* GPU count */}
                  <div>
                    <label className="text-xs font-medium text-txt-secondary mb-1 flex items-center gap-1.5">
                      <Cpu size={11} />
                      GPU Count
                    </label>
                    <Select
                      value={String(gpuCount)}
                      onChange={(e) => setGpuCount(Number(e.target.value))}
                      options={[1, 2, 4, 8].map((n) => ({ value: String(n), label: `${n} GPU${n > 1 ? 's' : ''}` }))}
                    />
                  </div>

                  {/* Ports */}
                  <div>
                    <label className="text-xs font-medium text-txt-secondary mb-1 flex items-center gap-1.5">
                      <Globe size={11} />
                      Ports
                    </label>
                    <input
                      type="text"
                      value={ports}
                      onChange={(e) => setPorts(e.target.value)}
                      placeholder="8188/http"
                      className="w-full px-2.5 py-1.5 text-xs bg-bg-secondary border border-border rounded-md text-txt-primary font-mono placeholder:text-txt-tertiary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                    />
                  </div>
                </div>

                {/* Selected template info */}
                {selectedTpl && !useCustomImage && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-muted text-xs text-accent">
                    <SlidersHorizontal size={11} />
                    <span>Template: <strong>{selectedTpl.name}</strong></span>
                    {selectedTpl.imageName && (
                      <span className="text-txt-tertiary font-mono truncate ml-1">({selectedTpl.imageName})</span>
                    )}
                  </div>
                )}

                {/* Cost estimate & deploy button */}
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div>
                    {estimatedCost != null && (
                      <div className="flex items-center gap-2">
                        <CircleDollarSign size={14} className="text-accent" />
                        <span className="text-sm font-semibold text-txt-primary">
                          Estimated: <span className="text-accent">${(estimatedCost).toFixed(2)}/hr</span>
                        </span>
                        {gpuCount > 1 && (
                          <span className="text-xs text-txt-tertiary">
                            (${(estimatedCost / gpuCount).toFixed(2)} x {gpuCount} GPUs)
                          </span>
                        )}
                      </div>
                    )}
                    {estimatedCost == null && selectedGpu && (
                      <span className="text-xs text-txt-tertiary">Pricing not available for this GPU</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCreateFormOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={creatingPod}
                      disabled={!podName.trim() || !selectedGpu}
                      onClick={() => void handleCreatePod()}
                    >
                      <Zap size={13} />
                      Deploy Pod
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* ============================================================== */}
          {/* Deployment Progress Cards                                        */}
          {/* ============================================================== */}
          {deployingPods.size > 0 && (
            <div className="space-y-2 mb-4">
              {[...deployingPods.entries()].map(([podId, info]) => (
                <Card key={podId} className={`p-3 border-l-4 ${
                  info.status === 'ready' ? 'border-l-green-500 bg-green-500/5' :
                  info.status === 'failed' ? 'border-l-red-500 bg-red-500/5' :
                  'border-l-accent bg-accent/5'
                }`}>
                  <div className="flex items-center gap-3">
                    {info.status === 'ready' ? (
                      <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                    ) : info.status === 'failed' ? (
                      <AlertTriangle size={16} className="text-red-500 shrink-0" />
                    ) : (
                      <Loader2 size={16} className="animate-spin text-accent shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-txt-primary">
                        {info.status === 'ready' ? 'Pod Ready!' :
                         info.status === 'failed' ? 'Deployment Failed' :
                         'Deploying...'}
                      </p>
                      <p className="text-xs text-txt-secondary">{info.message}</p>
                      {info.service_url && (
                        <p className="text-[10px] font-mono text-accent mt-0.5 truncate">{info.service_url}</p>
                      )}
                    </div>
                    {info.status === 'ready' && (
                      <Badge variant="success">Ready</Badge>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* ============================================================== */}
          {/* Active Pods                                                      */}
          {/* ============================================================== */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
                <Monitor size={14} className="text-accent" />
                Active Pods
                {pods.length > 0 && (
                  <Badge variant="neutral" className="text-[10px]">{pods.length}</Badge>
                )}
              </h4>
              {pods.length > 0 && (
                <div className="flex items-center gap-3 text-xs text-txt-tertiary">
                  <span>{pods.filter((p) => p.desiredStatus?.toUpperCase() === 'RUNNING').length} running</span>
                  <span>{pods.filter((p) => p.desiredStatus?.toUpperCase() === 'STOPPED').length} stopped</span>
                </div>
              )}
            </div>

            {pods.length === 0 ? (
              <Card padding="md">
                <div className="py-8 text-center">
                  <Cloud size={28} className="mx-auto text-txt-tertiary/40 mb-2" />
                  <p className="text-sm text-txt-tertiary">No active pods.</p>
                  <p className="text-xs text-txt-tertiary/70 mt-0.5">
                    Deploy a pod above to get started with cloud GPU rendering.
                  </p>
                </div>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {pods.map((pod) => (
                  <div key={pod.id}>
                    {registerSuccess === pod.id && (
                      <div
                        className="flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-success-muted text-success text-sm"
                        role="status"
                        aria-live="polite"
                      >
                        <CheckCircle2 size={13} className="shrink-0" />
                        Pod registered as ComfyUI server. It will appear in the ComfyUI Servers section.
                      </div>
                    )}
                    <PodCard
                      pod={pod}
                      onStart={handleStart}
                      onStop={handleStop}
                      onDelete={(id) => setConfirmDeletePod(pods.find((p) => p.id === id) ?? null)}
                      onRegister={handleRegister}
                      onRegisterLlm={handleRegisterLlm}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Delete pod confirmation dialog */}
      <Dialog
        open={confirmDeletePod !== null}
        onClose={() => setConfirmDeletePod(null)}
        title="Terminate Pod"
      >
        <p className="text-sm text-txt-secondary">
          Are you sure you want to terminate{' '}
          <strong className="text-txt-primary">{confirmDeletePod?.name}</strong>?
          This will permanently delete the pod and stop any running workloads.
          <span className="block mt-2 text-warning text-xs font-medium flex items-center gap-1">
            <AlertCircle size={11} />
            Any unsaved data on the pod will be lost.
          </span>
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmDeletePod(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deletingPod === confirmDeletePod?.id}
            onClick={() => confirmDeletePod && void handleDelete(confirmDeletePod.id)}
          >
            <Trash2 size={13} />
            Terminate Pod
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Templates Section
// ---------------------------------------------------------------------------

const CAPTION_STYLE_PRESETS = [
  { value: 'default', label: 'Default' },
  { value: 'bold', label: 'Bold' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'neon', label: 'Neon' },
] as const;

const MUSIC_MOOD_OPTIONS = [
  { value: 'upbeat', label: 'Upbeat' },
  { value: 'dramatic', label: 'Dramatic' },
  { value: 'calm', label: 'Calm' },
  { value: 'energetic', label: 'Energetic' },
  { value: 'mysterious', label: 'Mysterious' },
  { value: 'playful', label: 'Playful' },
  { value: 'inspirational', label: 'Inspirational' },
  { value: 'dark', label: 'Dark' },
  { value: 'romantic', label: 'Romantic' },
  { value: 'epic', label: 'Epic' },
  { value: 'chill', label: 'Chill' },
  { value: 'tense', label: 'Tense' },
] as const;

interface TemplateFormState {
  name: string;
  description: string;
  voice_profile_id: string;
  visual_style: string;
  caption_style: string;
  music_mood: string;
  music_volume_db: number;
  target_duration_seconds: number;
  is_default: boolean;
}

const DEFAULT_TEMPLATE_FORM: TemplateFormState = {
  name: '',
  description: '',
  voice_profile_id: '',
  visual_style: '',
  caption_style: 'default',
  music_mood: 'upbeat',
  music_volume_db: -14,
  target_duration_seconds: 30,
  is_default: false,
};

function TemplatesSection() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<any[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Form state
  const [form, setForm] = useState<TemplateFormState>(DEFAULT_TEMPLATE_FORM);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [tmpl, vp] = await Promise.all([
        videoTemplatesApi.list().catch(() => [] as any[]),
        voiceProfiles.list().catch(() => [] as any[]),
      ]);
      setTemplates(tmpl);
      setVoices(vp.map((v: any) => ({ id: v.id, name: v.name })));
    } catch (err) {
      toast.error('Failed to load templates', { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const openCreateDialog = () => {
    setEditingTemplate(null);
    setForm(DEFAULT_TEMPLATE_FORM);
    setDialogOpen(true);
  };

  const openEditDialog = (tmpl: any) => {
    setEditingTemplate(tmpl);
    setForm({
      name: tmpl.name ?? '',
      description: tmpl.description ?? '',
      voice_profile_id: tmpl.voice_profile_id ?? '',
      visual_style: tmpl.visual_style ?? '',
      caption_style: tmpl.caption_style ?? 'default',
      music_mood: tmpl.music_mood ?? 'upbeat',
      music_volume_db: tmpl.music_volume_db ?? -14,
      target_duration_seconds: tmpl.target_duration_seconds ?? 30,
      is_default: tmpl.is_default ?? false,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        voice_profile_id: form.voice_profile_id || undefined,
        visual_style: form.visual_style.trim() || undefined,
        caption_style: form.caption_style,
        music_mood: form.music_mood,
        music_volume_db: form.music_volume_db,
        target_duration_seconds: form.target_duration_seconds,
        is_default: form.is_default,
      };
      if (editingTemplate) {
        await videoTemplatesApi.update(editingTemplate.id, payload);
      } else {
        await videoTemplatesApi.create(payload);
      }
      toast.success(editingTemplate ? 'Template updated' : 'Template created');
      setDialogOpen(false);
      void fetchData();
    } catch (err) {
      toast.error(editingTemplate ? 'Failed to update template' : 'Failed to create template', { description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await videoTemplatesApi.remove(id);
      toast.success('Template deleted');
      setDeleteConfirmId(null);
      void fetchData();
    } catch (err) {
      toast.error('Failed to delete template', { description: String(err) });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Video Templates</h3>
          <p className="text-xs text-txt-secondary mt-0.5">
            Reusable configuration presets for voice, captions, music, and visual style.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openCreateDialog}>
          <Plus size={14} />
          Create Template
        </Button>
      </div>

      {/* Empty state */}
      {templates.length === 0 && (
        <div className="empty-state py-16">
          <Layers size={36} />
          <p className="text-sm">No templates yet</p>
          <p className="text-xs text-txt-tertiary mt-1">
            Create a template to reuse settings across multiple series.
          </p>
          <Button variant="primary" size="sm" className="mt-4" onClick={openCreateDialog}>
            <Plus size={14} />
            Create First Template
          </Button>
        </div>
      )}

      {/* Templates grid */}
      {templates.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {templates.map((tmpl) => (
            <Card key={tmpl.id} padding="md" className="flex flex-col gap-3">
              {/* Card header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <LayoutTemplate size={13} className="text-accent shrink-0" />
                    <h4 className="text-sm font-semibold text-txt-primary truncate">
                      {tmpl.name}
                    </h4>
                    {tmpl.is_default && (
                      <Star
                        size={11}
                        className="text-warning shrink-0"
                        aria-label="Default template"
                      />
                    )}
                  </div>
                  {tmpl.description && (
                    <p className="text-[11px] text-txt-secondary mt-0.5 line-clamp-2">
                      {tmpl.description}
                    </p>
                  )}
                </div>
                {typeof tmpl.usage_count === 'number' && (
                  <Badge variant="neutral" className="text-[10px] shrink-0">
                    {tmpl.usage_count} uses
                  </Badge>
                )}
              </div>

              {/* Settings pills */}
              <div className="flex flex-wrap gap-1.5">
                {tmpl.caption_style && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[10px] font-medium border border-accent/20">
                    <Subtitles size={9} />
                    {tmpl.caption_style}
                  </span>
                )}
                {tmpl.music_mood && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-elevated text-txt-secondary text-[10px] font-medium border border-border">
                    <Volume2 size={9} />
                    {tmpl.music_mood}
                  </span>
                )}
                {tmpl.target_duration_seconds && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-elevated text-txt-secondary text-[10px] font-medium border border-border">
                    {tmpl.target_duration_seconds}s
                  </span>
                )}
                {tmpl.music_volume_db !== undefined && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-elevated text-txt-secondary text-[10px] font-medium border border-border">
                    {tmpl.music_volume_db} dB
                  </span>
                )}
                {tmpl.voice_profile_id && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-elevated text-txt-secondary text-[10px] font-medium border border-border">
                    <Mic2 size={9} />
                    {voices.find((v) => v.id === tmpl.voice_profile_id)?.name ?? 'Voice'}
                  </span>
                )}
              </div>

              {/* Visual style preview */}
              {tmpl.visual_style && (
                <p className="text-[10px] text-txt-tertiary line-clamp-2 italic border-l-2 border-border pl-2">
                  {tmpl.visual_style}
                </p>
              )}

              {/* Actions */}
              <div className="mt-auto flex items-center gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={() => openEditDialog(tmpl)}
                  aria-label={`Edit template ${tmpl.name}`}
                >
                  <Edit3 size={12} />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteConfirmId(tmpl.id)}
                  aria-label={`Delete template ${tmpl.name}`}
                  className="text-error hover:bg-error-muted"
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingTemplate ? 'Edit Template' : 'Create Template'}
        description={
          editingTemplate
            ? 'Update the template settings below.'
            : 'Define a reusable configuration preset for your series.'
        }
      >
        <div className="space-y-4">
          {/* Name */}
          <Input
            label="Name"
            required
            placeholder="e.g. Sci-Fi Shorts, Dark Drama..."
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus
          />

          {/* Description */}
          <Textarea
            label="Description"
            placeholder="Optional description of this template..."
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={2}
          />

          {/* Voice profile */}
          <Select
            label="Voice Profile"
            value={form.voice_profile_id}
            onChange={(e) => setForm((f) => ({ ...f, voice_profile_id: e.target.value }))}
            options={[
              { value: '', label: 'No voice preference' },
              ...voices.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />

          {/* Visual style */}
          <Textarea
            label="Visual Style"
            placeholder="Describe the visual aesthetic: color palette, lighting, mood, art style..."
            value={form.visual_style}
            onChange={(e) => setForm((f) => ({ ...f, visual_style: e.target.value }))}
            rows={2}
          />

          {/* Caption style */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-txt-secondary">Caption Style</label>
            <div className="flex flex-wrap gap-1.5">
              {CAPTION_STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, caption_style: preset.value }))}
                  className={[
                    'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors duration-fast',
                    form.caption_style === preset.value
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover hover:text-txt-primary',
                  ].join(' ')}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Music mood */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-txt-secondary">Music Mood</label>
            <div className="flex flex-wrap gap-1.5">
              {MUSIC_MOOD_OPTIONS.map((mood) => (
                <button
                  key={mood.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, music_mood: mood.value }))}
                  className={[
                    'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors duration-fast',
                    form.music_mood === mood.value
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg-elevated text-txt-secondary hover:bg-bg-hover hover:text-txt-primary',
                  ].join(' ')}
                >
                  {mood.label}
                </button>
              ))}
            </div>
          </div>

          {/* Music volume */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-txt-secondary">
              Music Volume: {form.music_volume_db} dB
            </label>
            <div className="flex items-center gap-3 h-8">
              <input
                type="range"
                min={-20}
                max={-6}
                step={1}
                value={form.music_volume_db}
                onChange={(e) =>
                  setForm((f) => ({ ...f, music_volume_db: Number(e.target.value) }))
                }
                aria-label="Music volume in decibels"
                className="w-full accent-accent h-1.5 bg-bg-elevated rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm
                  [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-bg-base"
              />
              <span className="text-xs text-txt-tertiary font-mono w-10 text-right shrink-0">
                {form.music_volume_db} dB
              </span>
            </div>
            <p className="text-[10px] text-txt-tertiary">
              Lower values make the music quieter relative to narration
            </p>
          </div>

          {/* Target duration */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-txt-secondary">
              Target Duration: {form.target_duration_seconds}s
            </label>
            <div className="flex items-center gap-3 h-8">
              <input
                type="range"
                min={15}
                max={120}
                step={5}
                value={form.target_duration_seconds}
                onChange={(e) =>
                  setForm((f) => ({ ...f, target_duration_seconds: Number(e.target.value) }))
                }
                aria-label="Target video duration in seconds"
                className="w-full accent-accent h-1.5 bg-bg-elevated rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm
                  [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-bg-base"
              />
              <span className="text-xs text-txt-tertiary font-mono w-10 text-right shrink-0">
                {form.target_duration_seconds}s
              </span>
            </div>
          </div>

          {/* Set as default */}
          <div className="flex items-center gap-3 py-1">
            <button
              type="button"
              role="checkbox"
              aria-checked={form.is_default}
              onClick={() => setForm((f) => ({ ...f, is_default: !f.is_default }))}
              className={[
                'relative w-9 h-5 rounded-full transition-colors duration-fast shrink-0',
                form.is_default ? 'bg-accent' : 'bg-bg-active',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-fast',
                  form.is_default ? 'translate-x-4' : 'translate-x-0.5',
                ].join(' ')}
              />
            </button>
            <div>
              <label className="text-sm font-medium text-txt-primary">
                Set as default template
              </label>
              <p className="text-[10px] text-txt-tertiary">
                Applied automatically when creating new series.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!form.name.trim()}
            onClick={() => void handleSave()}
          >
            {editingTemplate ? 'Save Changes' : 'Create Template'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        title="Delete Template"
        description="Are you sure? This template will be permanently removed. Series that used it will keep their current settings."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteConfirmId(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deleting}
            onClick={() => deleteConfirmId && void handleDelete(deleteConfirmId)}
          >
            <Trash2 size={13} />
            Delete Template
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

export default Settings;
