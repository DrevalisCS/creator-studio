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
  ChevronUp,
  Unlink,
  Key,
  Eye,
  EyeOff,
  Zap,
  Link2,
  LayoutTemplate,
  Star,
  Layers,
  Subtitles,
  KeyRound,
  ArrowUpCircle,
  Archive,
  Users,
  Palette,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LicenseSection } from '@/pages/Settings/sections/LicenseSection';
import { UpdatesSection } from '@/pages/Settings/sections/UpdatesSection';
import { BackupSection } from '@/pages/Settings/sections/BackupSection';
import { TeamSection } from '@/pages/Settings/sections/TeamSection';
import { AppearanceSection } from '@/pages/Settings/sections/AppearanceSection';
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
  videoTemplates as videoTemplatesApi,
  assets as apiAssets,
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

// Settings is grouped semantically rather than as a flat 14-item list —
// account/billing first, then appearance, then service integrations,
// then system internals. The flat layout was fatiguing and put related
// items (e.g. ComfyUI / LLM / Voice / API Keys — all integrations)
// nowhere near each other in the nav.
const SECTION_GROUPS = [
  {
    id: 'account',
    label: 'Account & Billing',
    sections: [
      { id: 'license', label: 'License', icon: KeyRound },
      { id: 'team', label: 'Team', icon: Users },
    ],
  },
  {
    id: 'appearance-group',
    label: 'Appearance',
    sections: [
      { id: 'appearance', label: 'Theme', icon: Palette },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    sections: [
      { id: 'llm', label: 'LLM Configs', icon: Brain },
      { id: 'comfyui', label: 'ComfyUI Servers', icon: Server },
      { id: 'voice', label: 'Voice Profiles', icon: Mic2 },
      { id: 'social', label: 'Social Media', icon: Globe },
      { id: 'apikeys', label: 'API Keys', icon: Key },
    ],
  },
  {
    id: 'system',
    label: 'System',
    sections: [
      { id: 'health', label: 'Health', icon: CheckCircle2 },
      { id: 'storage', label: 'Storage', icon: HardDrive },
      { id: 'ffmpeg', label: 'FFmpeg', icon: Film },
      { id: 'backup', label: 'Backup', icon: Archive },
      { id: 'updates', label: 'Updates', icon: ArrowUpCircle },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    sections: [
      { id: 'templates', label: 'Templates', icon: LayoutTemplate },
    ],
  },
] as const;

const SECTIONS = SECTION_GROUPS.flatMap((g) => g.sections);
type SectionId = (typeof SECTIONS)[number]['id'];

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

function Settings() {
  const [activeSection, setActiveSection] = useState<SectionId>('license');

  return (
    <div>
      {/* Banner already shows "Settings" — keep subtitle only. */}
      <p className="text-sm text-txt-secondary mb-6">
        Configure backend services, voice profiles, and system settings.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Left nav — grouped sections with collapsible-style headers.
            On mobile (<md) the whole nav becomes a horizontal scroll
            row so we flatten the groups into a single strip. */}
        <div className="md:col-span-3">
          {/* Mobile: flat horizontal scroll list */}
          <nav className="flex md:hidden gap-0.5 overflow-x-auto -mx-4 px-4 snap-x">
            {SECTIONS.map((section) => {
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={[
                    'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-fast text-left whitespace-nowrap shrink-0 snap-start',
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
          {/* Desktop: grouped vertical nav */}
          <nav className="hidden md:flex md:flex-col gap-3">
            {SECTION_GROUPS.map((group) => (
              <div key={group.id} className="space-y-0.5">
                <div className="px-3 pb-1 text-[10px] font-display font-bold uppercase tracking-[0.15em] text-txt-tertiary">
                  {group.label}
                </div>
                {group.sections.map((section) => {
                  const isActive = activeSection === section.id;
                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      className={[
                        'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-fast text-left w-full',
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
              </div>
            ))}
          </nav>
        </div>

        {/* Right content */}
        <div className="md:col-span-9">
          {activeSection === 'license' && <LicenseSection />}
          {activeSection === 'appearance' && <AppearanceSection />}
          {activeSection === 'team' && <TeamSection />}
          {activeSection === 'updates' && <UpdatesSection />}
          {activeSection === 'backup' && <BackupSection />}
          {activeSection === 'health' && <HealthSection />}
          {activeSection === 'comfyui' && <ComfyUISection />}
          {activeSection === 'voice' && <VoiceSection />}
          {activeSection === 'llm' && <LLMSection />}
          {activeSection === 'storage' && <StorageSection />}
          {activeSection === 'ffmpeg' && <FFmpegSection />}
          {activeSection === 'templates' && <TemplatesSection />}
          {activeSection === 'social' && <SocialSection />}
          {activeSection === 'apikeys' && <ApiKeysSection onNavigateToApiKeys={() => setActiveSection('apikeys')} />}
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
        <EmptyState
          icon={Server}
          title="No ComfyUI servers configured"
          description="Add a server above to start generating scenes."
        />
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
  const [cloneOpen, setCloneOpen] = useState(false);
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
        toast.success('Voice sample generated — playing');
        void fetchProfiles();
        // Auto-play the test result. The path the API returns is
        // absolute inside the container (storage/temp/…); convert to
        // the frontend-proxied /storage URL for playback.
        let src = result.audio_path;
        const idx = src.indexOf('storage/');
        if (idx >= 0) src = '/' + src.slice(idx);
        else if (!src.startsWith('/')) src = '/' + src;
        const audio = new Audio(src);
        audio.play().catch(() => {
          /* autoplay might be blocked — the toast already told the user it's ready */
        });
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
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCloneOpen(true)}>
            <Mic2 size={14} />
            Clone voice
          </Button>
          <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)}>
            <Plus size={14} />
            Add Profile
          </Button>
        </div>
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
        <EmptyState
          icon={Mic2}
          title={
            filter === 'all'
              ? 'No voice profiles configured'
              : `No ${filter} voice profiles`
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredProfiles.map((p) => (
            <Card key={p.id} padding="md" className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-txt-primary truncate">
                    {p.name}
                  </h4>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <Badge variant={getProviderBadgeVariant(p.provider)} className="text-[10px]">
                      {p.provider}
                    </Badge>
                    <span className="text-[10px] text-txt-tertiary">
                      {p.speed}x speed
                    </span>
                    {p.sample_audio_path && p.provider === 'elevenlabs' && !p.elevenlabs_voice_id && (
                      <Badge variant="neutral" className="text-[10px]">
                        clone · pending training
                      </Badge>
                    )}
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
      {cloneOpen && (
        <VoiceCloneDialog
          onClose={() => setCloneOpen(false)}
          onDone={() => {
            setCloneOpen(false);
            void fetchProfiles();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice Clone Dialog (Phase E)
// ---------------------------------------------------------------------------

function VoiceCloneDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [assets, setAssetsList] = useState<Array<{ id: string; filename: string; duration_seconds: number | null }>>([]);
  const [displayName, setDisplayName] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [provider, setProvider] = useState<'elevenlabs' | 'piper' | 'kokoro'>('elevenlabs');
  const [busy, setBusy] = useState(false);

  // Mic recording state
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    void apiAssets.list({ kind: 'audio' }).then((rows) =>
      setAssetsList(
        rows.map((a) => ({
          id: a.id,
          filename: a.filename,
          duration_seconds: a.duration_seconds,
        })),
      ),
    );
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) mediaChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(mediaChunksRef.current, { type: 'audio/webm' });
        setRecordedBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setRecStart(Date.now());
    } catch (err) {
      toast.error('Mic access denied', {
        description: 'Fall back to picking an existing audio asset.',
      });
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    setRecStart(null);
  };

  const uploadRecording = async (): Promise<string | null> => {
    if (!recordedBlob) return null;
    try {
      const file = new File([recordedBlob], `voice-sample-${Date.now()}.webm`, {
        type: 'audio/webm',
      });
      const a = await apiAssets.upload(file, { tags: ['voice-sample'] });
      return a.id;
    } catch (err) {
      toast.error('Sample upload failed', { description: String(err) });
      return null;
    }
  };

  const submit = async () => {
    if (!displayName.trim()) {
      toast.error('Give the voice a name');
      return;
    }
    let assetId = selectedAssetId;
    if (!assetId && recordedBlob) {
      const id = await uploadRecording();
      if (!id) return;
      assetId = id;
    }
    if (!assetId) {
      toast.error('Pick an existing audio asset or record a sample');
      return;
    }
    setBusy(true);
    try {
      const res = await voiceProfiles.clone({
        asset_id: assetId,
        display_name: displayName.trim(),
        provider,
      });
      toast.success('Voice profile created', {
        description: res.note,
      });
      onDone();
    } catch (err) {
      toast.error('Clone failed', { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Clone voice from sample">
      <div className="space-y-3">
        <p className="text-xs text-txt-secondary">
          Record a 30-60 second clean take right here, OR pick an existing
          audio asset. ElevenLabs IVC uploads on the first voice test;
          Piper / Kokoro clones require offline fine-tuning.
        </p>

        {/* Mic capture */}
        <div className="p-3 rounded border border-white/[0.06] bg-bg-elevated space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-txt-primary">Browser mic</div>
            {recording && recStart && (
              <RecordingTimer startedAt={recStart} />
            )}
          </div>
          <div className="flex gap-2">
            {!recording ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void startRecording()}
                disabled={!!recordedBlob}
              >
                {recordedBlob ? 'Recorded' : 'Record'}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={stopRecording}>
                Stop
              </Button>
            )}
            {recordedBlob && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRecordedBlob(null);
                  if (previewUrl) URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                }}
              >
                Discard
              </Button>
            )}
          </div>
          {previewUrl && (
            <audio src={previewUrl} controls className="w-full h-8" />
          )}
          <div className="text-[10px] text-txt-muted">
            Tip: speak at conversational volume, no background music, 30s+.
          </div>
        </div>
        <div className="text-[11px] text-txt-muted text-center">— or —</div>
        <label className="block text-xs">
          <span className="text-txt-secondary mb-1 block">Display name</span>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My narrator voice"
          />
        </label>
        <label className="block text-xs">
          <span className="text-txt-secondary mb-1 block">Sample (audio asset)</span>
          <select
            value={selectedAssetId}
            onChange={(e) => setSelectedAssetId(e.target.value)}
            className="w-full px-3 py-2 bg-bg-base border border-white/[0.08] rounded-md text-sm text-txt-primary"
          >
            <option value="">— select an audio asset —</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.filename}
                {a.duration_seconds ? ` (${Math.round(a.duration_seconds)}s)` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-txt-secondary mb-1 block">Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as any)}
            className="w-full px-3 py-2 bg-bg-base border border-white/[0.08] rounded-md text-sm text-txt-primary"
          >
            <option value="elevenlabs">ElevenLabs (Instant Voice Cloning)</option>
            <option value="piper">Piper (local, needs offline training)</option>
            <option value="kokoro">Kokoro (local, needs offline training)</option>
          </select>
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Cloning…' : 'Create voice profile'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function RecordingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - startedAt) / 1000);
  return <span className="text-xs font-mono text-error">● {s}s</span>;
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
        <EmptyState
          icon={Brain}
          title="No LLM configurations yet"
          description="Add an endpoint above (LM Studio, Ollama, OpenAI, or Anthropic) to power scripts."
        />
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
              <span className="text-xs text-txt-tertiary">Storage Path (container)</span>
              <p className="text-sm text-txt-secondary font-mono mt-0.5 break-all">
                {storage.storage_base_abs || storage.storage_base_path}
              </p>
              {storage.host_source_path && (
                <>
                  <span className="text-xs text-txt-tertiary mt-3 block">
                    On host (copy media here)
                  </span>
                  <p className="text-sm text-accent font-mono mt-0.5 break-all">
                    {storage.host_source_path}
                  </p>
                  {(storage.host_source_path.startsWith('/project/') ||
                    storage.host_source_path.startsWith('/run/desktop/') ||
                    storage.host_source_path.startsWith('/mnt/host_mnt/')) && (
                    <p className="text-[11px] text-txt-tertiary mt-1">
                      That's Docker Desktop's Linux-VM label for the compose
                      file's directory. On Windows it's the same folder as{' '}
                      <code className="text-txt-secondary">
                        %USERPROFILE%\Drevalis\storage\
                      </code>
                      ; on macOS it's{' '}
                      <code className="text-txt-secondary">
                        ~/Drevalis/storage/
                      </code>
                      .
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          {storage.subdir_sizes && Object.keys(storage.subdir_sizes).length > 0 && (
            <div className="mt-6 pt-4 border-t border-border">
              <p className="text-xs text-txt-tertiary mb-2">Subdirectory breakdown</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {Object.entries(storage.subdir_sizes)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, size]) => (
                    <div
                      key={name}
                      className="rounded bg-bg-elevated p-2 font-mono"
                    >
                      <div className="text-txt-primary">{name}</div>
                      <div
                        className={
                          size > 0 ? 'text-txt-secondary' : 'text-txt-tertiary'
                        }
                      >
                        {formatBytes(size)}
                      </div>
                    </div>
                  ))}
              </div>
              {storage.total_size_bytes < 10 * 1024 * 1024 && (
                <p className="mt-3 text-xs text-amber-300 bg-amber-500/10 p-2 rounded border border-amber-500/30">
                  Storage is nearly empty. If you copied media files to your
                  host, make sure the destination is
                  {storage.host_source_path && (
                    <> <code className="font-mono">{storage.host_source_path}</code></>
                  )}
                  {' — '}
                  the app only sees files under the bind-mounted directory.
                  Copying elsewhere (e.g. a sibling folder with a different
                  case, or a drive the compose file doesn't map) won't be
                  picked up.
                </p>
              )}
              {storage.mountinfo_lines && storage.mountinfo_lines.length > 0 && (
                <details className="mt-3 rounded bg-bg-elevated p-3 text-[11px]">
                  <summary className="cursor-pointer text-txt-secondary">
                    Raw mount info ({storage.mountinfo_lines.length} lines) — paste for support
                  </summary>
                  <pre className="mt-2 font-mono text-[10px] text-txt-primary whitespace-pre-wrap break-all leading-relaxed">
                    {storage.mountinfo_lines.join('\n')}
                  </pre>
                  <p className="mt-2 text-[11px] text-txt-secondary leading-relaxed">
                    The 4th whitespace-separated field of the ``/app/storage``
                    line is the host source path Docker recorded. If it doesn't
                    match the directory where your 21 GB lives, the containers
                    were started from a different folder. Stop them, cd to the
                    directory that HAS your files + the docker-compose.yml,
                    then ``docker compose up -d`` from there.
                  </p>
                </details>
              )}
            </div>
          )}
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

  // Renew OAuth for an existing channel. The callback endpoint upserts
  // by Google channel_id, so sending the user through the consent flow
  // again will replace the expired tokens on the existing row — no
  // need to disconnect first, and the channel's upload history + the
  // series/audiobook FK assignments are preserved.
  const handleReconnect = async (channelId: string) => {
    try {
      const data = await youtube.getAuthUrl();
      // Remember which channel we're re-authing so that if the user
      // returns we can show a hint. Non-fatal if sessionStorage is
      // unavailable (private mode etc.).
      try {
        sessionStorage.setItem('youtube_reconnect_target', channelId);
      } catch { /* ignore */ }
      window.location.href = data.auth_url;
    } catch (err) {
      toast.error('Failed to start YouTube reconnection', {
        description: String(err),
      });
    }
  };

  // Hard-delete a channel row. Destructive — also removes that
  // channel's upload history via the FK cascade. Behind a confirm.
  const handleRemove = async (channelId: string, name: string) => {
    const ok = window.confirm(
      `Remove "${name}" completely?\n\nThis deletes the channel AND its upload history from this workspace. It does NOT touch the videos on YouTube itself.`,
    );
    if (!ok) return;
    try {
      await youtube.deleteChannel(channelId);
      toast.success(`Removed ${name}`);
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
    } catch (err) {
      toast.error('Failed to remove YouTube channel', {
        description: String(err),
      });
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
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <Youtube size={18} className="text-red-500 shrink-0" />
                <span className="text-sm font-semibold text-txt-primary truncate">
                  {ch.channel_name}
                </span>
                {ch.is_active ? (
                  <Badge variant="success" className="text-[10px]">Connected</Badge>
                ) : (
                  <Badge variant="warning" className="text-[10px]">Disconnected</Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleReconnect(ch.id)}
                  className="text-txt-secondary hover:text-accent"
                  title="Re-authorize this channel with Google (refreshes OAuth token)"
                >
                  Reconnect
                </Button>
                {ch.is_active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDisconnect(ch.id)}
                    className="text-txt-tertiary hover:text-warning"
                    title="Wipe OAuth tokens but keep upload history"
                  >
                    Disconnect
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRemove(ch.id, ch.channel_name)}
                  className="text-txt-tertiary hover:text-error"
                  title="Permanently remove this channel and its upload history"
                >
                  <Trash2 size={13} />
                </Button>
              </div>
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
  { id: 'facebook', name: 'Facebook', colorClass: 'text-blue-400', bgClass: 'bg-blue-500/10', dotClass: 'bg-blue-400' },
  { id: 'x', name: 'X (Twitter)', colorClass: 'text-gray-300', bgClass: 'bg-gray-500/10', dotClass: 'bg-gray-300' },
];

interface ConnectFormState {
  accountName: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  publicVideoBaseUrl: string;
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
  const [accountId, setAccountId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [publicVideoBaseUrl, setPublicVideoBaseUrl] = useState('');
  const [connecting, setConnecting] = useState(false);

  const needsAccountId = platform.id === 'facebook' || platform.id === 'instagram';
  const needsPublicUrl = platform.id === 'instagram';
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
    if (needsAccountId && !accountId.trim()) {
      setConnectError(
        platform.id === 'facebook'
          ? 'Facebook needs the numeric Page ID.'
          : 'Instagram needs the Business/Creator account ID.',
      );
      return;
    }
    if (needsPublicUrl && !publicVideoBaseUrl.trim()) {
      setConnectError(
        'Instagram Reels need a public HTTPS URL that maps to your storage folder.',
      );
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      await onConnect(platform.id, {
        accountName,
        accountId,
        accessToken,
        refreshToken,
        publicVideoBaseUrl,
      });
      setFormOpen(false);
      setAccountName('');
      setAccountId('');
      setAccessToken('');
      setRefreshToken('');
      setPublicVideoBaseUrl('');
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

          {needsAccountId && (
            <div>
              <label
                htmlFor={`${platform.id}-account-id`}
                className="block text-xs font-medium text-txt-secondary mb-1"
              >
                {platform.id === 'facebook' ? 'Facebook Page ID' : 'Instagram Account ID'}
                <span className="text-error ml-1">*</span>
              </label>
              <Input
                id={`${platform.id}-account-id`}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder={
                  platform.id === 'facebook'
                    ? 'e.g. 102034567890123'
                    : 'e.g. 17841400000000000'
                }
                aria-required="true"
              />
              <p className="text-[11px] text-txt-tertiary mt-1">
                {platform.id === 'facebook'
                  ? 'Numeric ID of the Page you want uploads to land on. Get it from facebook.com/{your-page}/about.'
                  : 'Business/Creator account ID from Meta Graph — required to create Reels containers.'}
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor={`${platform.id}-access-token`}
              className="block text-xs font-medium text-txt-secondary mb-1"
            >
              {platform.id === 'facebook' ? 'Page Access Token' : 'API Access Token'}
              <span className="text-error ml-1">*</span>
            </label>
            <Input
              id={`${platform.id}-access-token`}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={
                platform.id === 'facebook'
                  ? 'Page Access Token (not a user token)'
                  : 'Paste your access token...'
              }
              aria-required="true"
            />
            {platform.id === 'facebook' && (
              <p className="text-[11px] text-txt-tertiary mt-1">
                Exchange a user token for a long-lived Page Access Token via Graph
                API’s <code>/me/accounts</code>. User tokens will fail on upload.
              </p>
            )}
          </div>

          {needsPublicUrl && (
            <div>
              <label
                htmlFor={`${platform.id}-public-url`}
                className="block text-xs font-medium text-txt-secondary mb-1"
              >
                Public video base URL
                <span className="text-error ml-1">*</span>
              </label>
              <Input
                id={`${platform.id}-public-url`}
                value={publicVideoBaseUrl}
                onChange={(e) => setPublicVideoBaseUrl(e.target.value)}
                placeholder="https://cdn.yoursite.com/storage"
                aria-required="true"
              />
              <p className="text-[11px] text-txt-tertiary mt-1">
                Instagram Reels need a public HTTPS URL that maps to the storage folder
                Drevalis writes videos into. Without this, upload will fail.
              </p>
            </div>
          )}

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
      const meta: Record<string, string> = {};
      if (form.publicVideoBaseUrl?.trim()) {
        meta.public_video_base_url = form.publicVideoBaseUrl.trim();
      }
      await socialApi.connectPlatform({
        platform: platformId,
        account_name: form.accountName.trim(),
        account_id: form.accountId?.trim() || undefined,
        access_token: form.accessToken.trim(),
        refresh_token: form.refreshToken.trim() || undefined,
        account_metadata: Object.keys(meta).length ? meta : undefined,
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
    description: 'Cloud GPU pods — manage at /cloud-gpu',
    iconBg: 'bg-violet-500/10',
    iconColor: 'text-violet-400',
  },
  {
    id: 'vast_ai',
    label: 'Vast.ai',
    description: 'Spot-market GPU pods — manage at /cloud-gpu',
    iconBg: 'bg-sky-500/10',
    iconColor: 'text-sky-400',
  },
  {
    id: 'lambda_labs',
    label: 'Lambda Labs',
    description: 'On-demand A100/H100 — manage at /cloud-gpu',
    iconBg: 'bg-teal-500/10',
    iconColor: 'text-teal-400',
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
  { value: 'vastai_api_key', label: 'Vast.ai API Key' },
  { value: 'lambda_api_key', label: 'Lambda Labs API Key' },
  { value: 'elevenlabs', label: 'ElevenLabs API Key' },
  { value: 'anthropic', label: 'Anthropic API Key' },
  { value: 'openai', label: 'OpenAI API Key' },
  { value: 'tiktok_client_key', label: 'TikTok Client Key' },
  { value: 'tiktok_client_secret', label: 'TikTok Client Secret' },
  { value: 'tiktok_redirect_uri', label: 'TikTok Redirect URI' },
  { value: 'instagram', label: 'Instagram API Key' },
  { value: 'facebook_page_access_token', label: 'Facebook Page Access Token' },
  { value: 'facebook_page_id', label: 'Facebook Page ID' },
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
        <EmptyState
          icon={Layers}
          title="No templates yet"
          description="Create a template to reuse settings across multiple series."
          action={
            <Button variant="primary" size="sm" onClick={openCreateDialog}>
              <Plus size={14} />
              Create First Template
            </Button>
          }
        />
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
