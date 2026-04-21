import { useState, useEffect, useRef, useCallback } from 'react';
import {
  BookOpen,
  Code,
  Sparkles,
  Film,
  Mic,
  Settings,
  Keyboard,
  CheckSquare,
  Layers,
  Music,
  Youtube,
  AlertTriangle,
  Info,
  Lightbulb,
  Search,
  ChevronRight,
  FileText,
  Volume2,
  Image,
  Zap,
  Monitor,
  Server,
  HardDrive,
  Play,
  Scissors,
  Star,
  Hash,
  Clock,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TocEntry {
  id: string;
  label: string;
  icon: typeof Film;
  subsections: { id: string; label: string }[];
}

// ---------------------------------------------------------------------------
// TOC structure
// ---------------------------------------------------------------------------

const TOC: TocEntry[] = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    icon: Sparkles,
    subsections: [
      { id: 'what-is', label: 'What is Drevalis Creator Studio' },
      { id: 'system-requirements', label: 'System Requirements' },
      { id: 'setup-checklist', label: 'First-Time Setup Checklist' },
      { id: 'quick-start', label: 'Quick Start: First Video in 5 Steps' },
    ],
  },
  {
    id: 'content-studio',
    label: 'Content Studio',
    icon: Film,
    subsections: [
      { id: 'series', label: 'Series' },
      { id: 'episodes', label: 'Episodes & The Pipeline' },
      { id: 'ai-generation', label: 'AI Generation' },
      { id: 'scene-modes', label: 'Scene Modes' },
      { id: 'walkthrough', label: 'Example Walkthrough' },
    ],
  },
  {
    id: 'episode-detail',
    label: 'Episode Detail',
    icon: FileText,
    subsections: [
      { id: 'script-tab', label: 'Script Tab' },
      { id: 'scenes-tab', label: 'Scenes Tab' },
      { id: 'captions-tab', label: 'Captions Tab' },
      { id: 'music-tab', label: 'Music Tab' },
      { id: 'video-editor', label: 'Video Editor' },
      { id: 'per-episode-settings', label: 'Per-Episode Settings' },
    ],
  },
  {
    id: 'text-to-voice',
    label: 'Text to Voice',
    icon: Mic,
    subsections: [
      { id: 'single-voice', label: 'Single Voice Narration' },
      { id: 'multi-voice', label: 'Multi-Voice with Speaker Tags' },
      { id: 'chapters', label: 'Chapter Support' },
      { id: 'output-formats', label: 'Output Formats' },
      { id: 'audiobook-captions', label: 'Caption Styles' },
    ],
  },
  {
    id: 'voice-profiles',
    label: 'Voice Profiles',
    icon: Volume2,
    subsections: [
      { id: 'providers', label: 'Supported Providers' },
      { id: 'creating-profile', label: 'Creating a Profile' },
      { id: 'voice-preview', label: 'Previewing Voices' },
      { id: 'speed-pitch', label: 'Speed and Pitch Controls' },
    ],
  },
  {
    id: 'music-audio',
    label: 'Music & Audio',
    icon: Music,
    subsections: [
      { id: 'acestep', label: 'AceStep AI Music Generation' },
      { id: 'mood-presets', label: '12 Mood Presets' },
      { id: 'mastering', label: 'Audio Mastering Chain' },
      { id: 'sidechain', label: 'Sidechain Ducking Explained' },
    ],
  },
  {
    id: 'longform-videos',
    label: 'Long-Form Videos',
    icon: Film,
    subsections: [
      { id: 'longform-overview', label: 'Overview & Content Format' },
      { id: 'longform-series', label: 'Creating a Long-Form Series' },
      { id: 'longform-chapters', label: 'Chapter-Aware Assembly' },
      { id: 'longform-output', label: '16:9 Output & Visual Consistency' },
    ],
  },
  {
    id: 'multi-channel',
    label: 'Multi-Channel YouTube',
    icon: Youtube,
    subsections: [
      { id: 'multi-channel-connect', label: 'Connecting Multiple Channels' },
      { id: 'multi-channel-assign', label: 'Assigning Channels to Series' },
      { id: 'multi-channel-schedule', label: 'Scheduled Publishing' },
    ],
  },
  {
    id: 'worker-management',
    label: 'Worker Management',
    icon: Server,
    subsections: [
      { id: 'worker-health', label: 'Worker Health & Monitoring' },
      { id: 'worker-priority', label: 'Priority Queue' },
      { id: 'worker-restart', label: 'Restarting the Worker' },
    ],
  },
  {
    id: 'load-balancing',
    label: 'Load Balancing',
    icon: Layers,
    subsections: [
      { id: 'lb-comfyui', label: 'Multiple ComfyUI Servers' },
      { id: 'lb-llm', label: 'Multiple LLM Configs' },
      { id: 'lb-distribution', label: 'How Distribution Works' },
    ],
  },
  {
    id: 'social-youtube',
    label: 'Social Media & YouTube',
    icon: Youtube,
    subsections: [
      { id: 'connect-youtube', label: 'Connecting YouTube' },
      { id: 'connect-other', label: 'TikTok, Instagram, X' },
      { id: 'uploading', label: 'Uploading Videos' },
      { id: 'playlists', label: 'Playlists' },
      { id: 'privacy', label: 'Privacy Settings' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    subsections: [
      { id: 'comfyui-settings', label: 'ComfyUI Servers' },
      { id: 'llm-settings', label: 'LLM Configs' },
      { id: 'storage-settings', label: 'Storage' },
      { id: 'ffmpeg-settings', label: 'FFmpeg' },
    ],
  },
  {
    id: 'keyboard-shortcuts',
    label: 'Keyboard Shortcuts',
    icon: Keyboard,
    subsections: [
      { id: 'player-shortcuts', label: 'Video Player' },
      { id: 'activity-monitor', label: 'Activity Monitor' },
    ],
  },
  {
    id: 'license-tiers',
    label: 'License & Tiers',
    icon: Star,
    subsections: [
      { id: 'tier-solo', label: 'Solo' },
      { id: 'tier-pro', label: 'Pro' },
      { id: 'tier-studio', label: 'Studio' },
      { id: 'tier-compare', label: 'Feature Matrix' },
      { id: 'tier-grace', label: 'Grace Period & Renewal' },
    ],
  },
  {
    id: 'hardware-performance',
    label: 'Hardware & Performance',
    icon: HardDrive,
    subsections: [
      { id: 'hw-matrix', label: 'Hardware Matrix' },
      { id: 'hw-gpu', label: 'GPU Recommendations' },
      { id: 'hw-scaling', label: 'Scaling: Multiple Servers' },
      { id: 'hw-cloud', label: 'RunPod Cloud GPU' },
      { id: 'hw-network', label: 'Network & Storage' },
    ],
  },
  {
    id: 'backup-restore',
    label: 'Backup & Restore',
    icon: HardDrive,
    subsections: [
      { id: 'br-manual', label: 'Manual Backup' },
      { id: 'br-auto', label: 'Auto-Backup Schedule' },
      { id: 'br-restore', label: 'Restoring an Archive' },
      { id: 'br-smb', label: 'Off-Box: SMB / NFS Mount' },
      { id: 'br-encryption', label: 'Encryption Keys & Migration' },
    ],
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: Zap,
    subsections: [
      { id: 'updates-how', label: 'How Updates Work' },
      { id: 'updates-auto', label: 'In-App Update' },
      { id: 'updates-manual', label: 'Manual Update' },
      { id: 'updates-rollback', label: 'Rolling Back' },
    ],
  },
  {
    id: 'pro-tips',
    label: 'Pro Tips',
    icon: Lightbulb,
    subsections: [
      { id: 'tips-quality', label: 'Output Quality' },
      { id: 'tips-speed', label: 'Generation Speed' },
      { id: 'tips-workflow', label: 'Workflow' },
      { id: 'tips-youtube', label: 'YouTube Growth' },
      { id: 'tips-safety', label: 'Safety & Compliance' },
    ],
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    icon: AlertTriangle,
    subsections: [
      { id: 'stuck-generation', label: 'Generation Stuck' },
      { id: 'video-playback', label: 'Video Won\'t Play' },
      { id: 'comfyui-connection', label: 'No ComfyUI Connection' },
      { id: 'captions-missing', label: 'Captions Not Showing' },
      { id: 'music-missing', label: 'Music Not Generated' },
      { id: 'ts-uploads', label: 'YouTube Upload Fails' },
      { id: 'ts-license', label: 'License Gate / 402 Errors' },
      { id: 'ts-worker', label: 'Worker Stuck / Unhealthy' },
      { id: 'ts-logs', label: 'Reading Logs' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Utility sub-components
// ---------------------------------------------------------------------------

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="px-1.5 py-0.5 text-xs font-mono bg-bg-elevated border border-border rounded text-txt-primary">
      {children}
    </kbd>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 p-3 rounded-md bg-green-500/10 border-l-2 border-green-500 my-4">
      <Lightbulb size={14} className="text-green-400 mt-0.5 shrink-0" />
      <p className="text-sm text-txt-secondary leading-relaxed">{children}</p>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 p-3 rounded-md bg-amber-500/10 border-l-2 border-amber-500 my-4">
      <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
      <p className="text-sm text-txt-secondary leading-relaxed">{children}</p>
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 p-3 rounded-md bg-blue-500/10 border-l-2 border-blue-500 my-4">
      <Info size={14} className="text-blue-400 mt-0.5 shrink-0" />
      <p className="text-sm text-txt-secondary leading-relaxed">{children}</p>
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-bg-elevated border border-border rounded-md p-4 text-xs font-mono text-txt-secondary overflow-x-auto my-3 leading-relaxed">
      {children}
    </pre>
  );
}

function SectionHeading({ id, icon: Icon, title }: { id: string; icon: typeof Film; title: string }) {
  return (
    <div id={id} className="flex items-center gap-3 mb-5 pt-2">
      <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center shrink-0">
        <Icon size={17} className="text-accent" />
      </div>
      <h2 className="text-xl font-semibold text-txt-primary">{title}</h2>
    </div>
  );
}

function SubHeading({ id, title }: { id: string; title: string }) {
  return (
    <h3 id={id} className="text-md font-semibold text-txt-primary mt-8 mb-3 scroll-mt-6">
      {title}
    </h3>
  );
}

function StepBadge({ step, color }: { step: string; color: string }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold"
      style={{ background: `${color}22`, color }}
    >
      {step}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Help component
// ---------------------------------------------------------------------------

function Help() {
  const [tab, setTab] = useState<'guide' | 'api'>('guide');

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-txt-primary">Help & Documentation</h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Comprehensive guides, examples, and reference for every feature in Drevalis Creator Studio.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-0 border-b border-border shrink-0">
        <button
          onClick={() => setTab('guide')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
            tab === 'guide'
              ? 'border-accent text-accent'
              : 'border-transparent text-txt-tertiary hover:text-txt-primary'
          }`}
        >
          <BookOpen size={14} className="inline mr-1.5" />
          User Guide
        </button>
        <button
          onClick={() => setTab('api')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
            tab === 'api'
              ? 'border-accent text-accent'
              : 'border-transparent text-txt-tertiary hover:text-txt-primary'
          }`}
        >
          <Code size={14} className="inline mr-1.5" />
          API Reference
        </button>
      </div>

      {tab === 'guide' && <UserGuide />}
      {tab === 'api' && (
        <div className="rounded-lg overflow-hidden border border-border mt-4 flex-1" style={{ minHeight: 0 }}>
          <iframe
            src="/docs"
            title="API Documentation"
            className="w-full h-full border-0"
            style={{ colorScheme: 'dark', height: 'calc(100vh - 220px)' }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserGuide — sidebar + scrollable content
// ---------------------------------------------------------------------------

function UserGuide() {
  const [activeSection, setActiveSection] = useState<string>('getting-started');
  const [activeSubsection, setActiveSubsection] = useState<string>('what-is');
  const [search, setSearch] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Collect all section + subsection ids
  const allIds = TOC.flatMap(entry => [
    entry.id,
    ...entry.subsections.map(s => s.id),
  ]);

  const handleIntersect = useCallback((entries: IntersectionObserverEntry[]) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        // Check if it's a top-level section
        const section = TOC.find(t => t.id === id);
        if (section) {
          setActiveSection(id);
          setActiveSubsection(section.subsections[0]?.id ?? '');
        } else {
          // It's a subsection — find its parent
          for (const t of TOC) {
            const sub = t.subsections.find(s => s.id === id);
            if (sub) {
              setActiveSection(t.id);
              setActiveSubsection(id);
              break;
            }
          }
        }
        break;
      }
    }
  }, []);

  useEffect(() => {
    if (!contentRef.current) return;
    observerRef.current = new IntersectionObserver(handleIntersect, {
      root: contentRef.current,
      rootMargin: '-10% 0px -70% 0px',
      threshold: 0,
    });
    allIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) observerRef.current!.observe(el);
    });
    return () => observerRef.current?.disconnect();
  }, [handleIntersect]);

  function scrollTo(id: string) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const filteredToc = TOC.filter(entry => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      entry.label.toLowerCase().includes(q) ||
      entry.subsections.some(s => s.label.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex gap-0 mt-4 flex-1 min-h-0" style={{ height: 'calc(100vh - 220px)' }}>
      {/* Left TOC sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-border pr-3 overflow-hidden">
        {/* Search */}
        <div className="relative mb-3 shrink-0">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-tertiary pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter sections..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-bg-elevated border border-border rounded-md text-txt-primary placeholder:text-txt-tertiary focus:outline-none focus:border-border-accent"
            aria-label="Filter documentation sections"
          />
        </div>

        {/* TOC entries */}
        <nav className="overflow-y-auto flex-1 space-y-0.5" aria-label="Table of contents">
          {filteredToc.map(entry => {
            const Icon = entry.icon;
            const isActive = activeSection === entry.id;
            return (
              <div key={entry.id}>
                <button
                  onClick={() => scrollTo(entry.id)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-medium transition text-left ${
                    isActive
                      ? 'bg-accent/15 text-accent'
                      : 'text-txt-secondary hover:text-txt-primary hover:bg-bg-elevated'
                  }`}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <Icon size={13} className={isActive ? 'text-accent' : 'text-txt-tertiary'} />
                  {entry.label}
                </button>
                {isActive && (
                  <div className="ml-5 mt-0.5 space-y-0.5 mb-1">
                    {entry.subsections
                      .filter(s => !search || s.label.toLowerCase().includes(search.toLowerCase()))
                      .map(sub => (
                        <button
                          key={sub.id}
                          onClick={() => scrollTo(sub.id)}
                          className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs transition text-left ${
                            activeSubsection === sub.id
                              ? 'text-accent'
                              : 'text-txt-tertiary hover:text-txt-secondary'
                          }`}
                        >
                          <ChevronRight size={10} />
                          {sub.label}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Right scrollable content */}
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto pl-8 pr-4 pb-24"
      >
        <div className="max-w-3xl">

          {/* ================================================================
              1. GETTING STARTED
          ================================================================ */}
          <section id="getting-started" className="mb-16 scroll-mt-4">
            <SectionHeading id="getting-started-heading" icon={Sparkles} title="Getting Started" />

            <SubHeading id="what-is" title="What is Drevalis Creator Studio" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Drevalis Creator Studio is a local-first AI-powered video creation studio built for YouTube Shorts and
              long-form text-to-speech content. It automates the entire production pipeline — from generating
              scripts with an LLM, synthesizing voiceovers with TTS, generating scene visuals with ComfyUI,
              adding animated captions, compositing the final video with FFmpeg, and uploading directly to YouTube.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              All heavy processing (LLM inference, TTS synthesis, image/video generation) runs on your local
              machine by default. Cloud providers (Claude AI, ElevenLabs, Edge TTS) are available as opt-in
              alternatives for each component.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed">
              Drevalis Creator Studio handles two primary workflows:
            </p>
            <ul className="mt-3 space-y-2 text-sm text-txt-secondary ml-4">
              <li className="flex gap-2">
                <Film size={14} className="text-accent shrink-0 mt-0.5" />
                <span><strong className="text-txt-primary">YouTube Shorts Studio</strong> — episodic series with AI scripts, TTS narration, ComfyUI scene images or videos, animated word-level captions, and direct upload.</span>
              </li>
              <li className="flex gap-2">
                <Mic size={14} className="text-accent shrink-0 mt-0.5" />
                <span><strong className="text-txt-primary">Text-to-Voice Studio</strong> — converts long-form text into narrated audiobooks or faceless videos with chapter detection, multi-voice dialogue, background music, and multiple output formats.</span>
              </li>
            </ul>

            <SubHeading id="system-requirements" title="System Requirements" />
            <div className="grid grid-cols-2 gap-3 mb-4">
              {[
                {
                  icon: Server,
                  name: 'ComfyUI',
                  desc: 'Required for scene image and video generation. Run locally on GPU or connect to a remote server.',
                  status: 'Required for image/video',
                },
                {
                  icon: Monitor,
                  name: 'FFmpeg',
                  desc: 'Required for all video assembly, caption burning, and audio mixing. Must be on your system PATH.',
                  status: 'Required',
                },
                {
                  icon: HardDrive,
                  name: 'PostgreSQL 16',
                  desc: 'Stores series, episodes, voice profiles, and job state. Run via Docker or install locally.',
                  status: 'Required',
                },
                {
                  icon: Zap,
                  name: 'Redis',
                  desc: 'Powers the arq job queue and real-time progress via pub/sub. Run via Docker or install locally.',
                  status: 'Required',
                },
              ].map(item => (
                <div key={item.name} className="surface p-3 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <item.icon size={14} className="text-accent" />
                    <span className="text-sm font-medium text-txt-primary">{item.name}</span>
                    <span className="ml-auto text-xs text-txt-tertiary">{item.status}</span>
                  </div>
                  <p className="text-xs text-txt-secondary leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
            <InfoBox>
              The fastest way to start all infrastructure is <code className="font-mono text-accent">docker compose up -d</code>. This starts PostgreSQL, Redis, the backend API, the arq worker, and the frontend in one command.
            </InfoBox>

            <SubHeading id="setup-checklist" title="First-Time Setup Checklist" />
            <div className="space-y-2 mb-4">
              {[
                'Docker running — start infrastructure with docker compose up -d',
                'Open http://localhost:5173 in your browser',
                'Go to Settings → ComfyUI — add your ComfyUI server URL and test the connection',
                'Go to Settings → LLM — configure your LM Studio or OpenAI-compatible endpoint',
                'Go to Settings → Voice Profiles — create at least one voice profile (Edge TTS has 17+ free voices)',
                'Optional: Settings → YouTube — connect your Google account for direct uploads',
                'Optional: Configure ElevenLabs API key in a voice profile for premium voices',
                'Create your first Series and generate an episode',
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3 text-sm text-txt-secondary">
                  <CheckSquare size={14} className="text-success shrink-0 mt-0.5" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <SubHeading id="quick-start" title="Quick Start: Your First Video in 5 Steps" />
            <div className="space-y-4">
              {[
                {
                  step: '1',
                  title: 'Configure Services',
                  desc: 'Navigate to Settings. Add a ComfyUI server (usually http://localhost:8188) and test the connection. Set up your LLM endpoint (LM Studio default: http://localhost:1234/v1). Create a voice profile using Edge TTS — pick any voice from the dropdown and click Preview to hear it.',
                },
                {
                  step: '2',
                  title: 'Create a Series',
                  desc: 'Go to Series → New Series. Give it a name like "Fun Science Facts", write a short series bible describing the tone and content style, select your voice profile and ComfyUI workflow, then save. Alternatively, click AI Generate — type a one-sentence idea and the LLM will create the series config and 5 episode topics automatically.',
                },
                {
                  step: '3',
                  title: 'Add an Episode',
                  desc: 'Inside your series, click New Episode. Add a topic like "Why is the sky blue?" and save. You can also bulk-add topics from the series detail page.',
                },
                {
                  step: '4',
                  title: 'Generate',
                  desc: 'Click the Generate button on the episode. Watch the Activity Monitor in the bottom-right corner — it shows real-time progress through all 6 pipeline steps: Script → Voice → Scenes → Captions → Assembly → Thumbnail. Generation time depends on your GPU. An image-mode Short typically takes 3–8 minutes.',
                },
                {
                  step: '5',
                  title: 'Review and Export',
                  desc: 'Open the finished episode. Play the video. Edit any scene narration or visual prompts if needed, then click Reassemble to rebuild with your changes. When satisfied, use the Export menu to download the MP4 bundle or Upload to YouTube directly from the app.',
                },
              ].map(item => (
                <div key={item.step} className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0 text-sm font-bold text-accent">
                    {item.step}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-txt-primary mb-1">{item.title}</p>
                    <p className="text-sm text-txt-secondary leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ================================================================
              2. CONTENT STUDIO
          ================================================================ */}
          <section id="content-studio" className="mb-16 scroll-mt-4">
            <SectionHeading id="content-studio-heading" icon={Film} title="Content Studio" />

            <SubHeading id="series" title="Series" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              A <strong className="text-txt-primary">Series</strong> is the top-level container for your content.
              It holds a <em>series bible</em> — a description of the show's tone, target audience, and content rules
              — along with default settings for voice, visual style, LLM, and ComfyUI workflow. Every episode in a
              series inherits these defaults but can override them individually.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Think of a series as a show template. When the LLM writes episode scripts, it receives the series bible
              as context, which ensures all episodes maintain consistent tone, vocabulary, and structure.
            </p>
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Series Bible Example</p>
              <CodeBlock>{`Name: Fun Science Facts for Kids

Bible:
"Short, engaging science explainers for ages 8-14.
Each episode covers one fascinating science topic in under
60 seconds. Use simple analogies and avoid jargon. Always
end with a surprising 'mind-blowing' fact. Friendly,
curious tone — like a knowledgeable older sibling."

Visual Style: Bright, colorful illustrations. No real photos.
Episode Length: 45-55 seconds
Voice: Energetic female narrator`}</CodeBlock>
            </div>
            <Tip>
              Write a detailed series bible — the more context you give the LLM, the more consistent and on-brand your episodes will be. Include tone, vocabulary level, structure, and what to avoid.
            </Tip>

            <SubHeading id="episodes" title="Episodes & The 6-Step Pipeline" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-4">
              When you click <strong className="text-txt-primary">Generate</strong> on an episode, Drevalis Creator Studio
              runs a six-step pipeline as a single background job. Each step is tracked independently — if the job
              fails or is cancelled mid-run, completed steps are automatically skipped on retry.
            </p>
            <div className="space-y-3 mb-4">
              {[
                {
                  step: 'Script',
                  color: '#818CF8',
                  desc: 'The LLM reads your episode topic and series bible, then generates a structured JSON script. The script contains individual scenes, each with narration text, a visual prompt for image generation, duration in seconds, and optional keywords for caption emphasis.',
                },
                {
                  step: 'Voice',
                  color: '#F472B6',
                  desc: 'The TTS provider converts each scene\'s narration text to speech audio. Piper and Kokoro run locally via ONNX models. Edge TTS uses Microsoft\'s free cloud service. ElevenLabs uses their REST API for premium voices. Audio is saved per scene.',
                },
                {
                  step: 'Scenes',
                  color: '#34D399',
                  desc: 'ComfyUI generates a visual asset for each scene using the scene\'s visual_prompt field. In Image mode, it generates a still image (e.g. via DreamShaper). In Video mode, it generates an animated clip (e.g. via Wan 2.2). Multiple ComfyUI servers can be used in parallel.',
                },
                {
                  step: 'Captions',
                  color: '#FBBF24',
                  desc: 'faster-whisper transcribes the generated voice audio at word-level precision. The transcript is converted to an ASS subtitle file using your chosen caption style preset (font, color, animation). Buzzwords from the script are optionally highlighted with pop-out effects.',
                },
                {
                  step: 'Assembly',
                  color: '#60A5FA',
                  desc: 'FFmpeg composites all elements into the final 9:16 MP4. It combines scene visuals (with Ken Burns pan/zoom for images), voice audio, optional background music (with sidechain ducking), and burned-in caption overlays. Output resolution: 1080x1920 @ 30fps.',
                },
                {
                  step: 'Thumbnail',
                  color: '#A78BFA',
                  desc: 'FFmpeg extracts a representative frame from the final video and applies the series thumbnail style to produce a 1280x720 JPEG. The thumbnail is used as the cover image for YouTube uploads.',
                },
              ].map(item => (
                <div key={item.step} className="flex gap-3 p-3 surface rounded-lg">
                  <StepBadge step={item.step} color={item.color} />
                  <p className="text-sm text-txt-secondary leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
            <InfoBox>
              You can retry any individual failed step from the Episode Detail page (Retry Step dropdown) or from the Jobs page. Completed steps are never re-run unless you explicitly trigger a full regeneration.
            </InfoBox>

            <SubHeading id="ai-generation" title="AI Generation" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The <strong className="text-txt-primary">AI Generate</strong> button on the Series list page lets you
              create an entire series — including the series bible, default settings, and a set of episode topics —
              from a single text prompt. The LLM generates the full configuration in one request.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Similarly, individual episodes can be generated from a topic alone. The LLM receives your topic, the
              series bible, and example episode structures to produce a fully formatted JSON script ready for the
              voice step.
            </p>
            <CodeBlock>{`AI Generate prompt example:
"A YouTube Shorts series about unsolved historical mysteries.
5 episodes. Target audience: history buffs aged 25-40.
Tone: investigative, slightly dramatic. Each episode covers
one mystery in under 60 seconds."`}</CodeBlock>
            <p className="text-sm text-txt-secondary leading-relaxed mt-3">
              This produces a complete series configuration with name, bible, visual style description, and 5
              episode topics — ready to generate immediately.
            </p>

            <SubHeading id="scene-modes" title="Scene Modes: Image vs Video" />
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="surface p-4 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Image size={15} className="text-step-scenes" />
                  <span className="text-sm font-semibold text-txt-primary">Image Mode</span>
                </div>
                <p className="text-xs text-txt-secondary leading-relaxed mb-3">
                  ComfyUI generates one static image per scene. FFmpeg applies a Ken Burns pan/zoom effect (random
                  direction per scene) to add motion. Fast to generate — a typical 6-scene Short takes 2–5 minutes
                  on a mid-range GPU.
                </p>
                <p className="text-xs text-txt-tertiary">Best for: Quick content, high volume, any GPU</p>
              </div>
              <div className="surface p-4 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Play size={15} className="text-step-assembly" />
                  <span className="text-sm font-semibold text-txt-primary">Video Mode</span>
                </div>
                <p className="text-xs text-txt-secondary leading-relaxed mb-3">
                  ComfyUI generates an animated video clip per scene (requires a video generation model like
                  Wan 2.2). Clips are visually richer but generation is significantly slower — 10–30+ minutes
                  per clip depending on GPU.
                </p>
                <p className="text-xs text-txt-tertiary">Best for: High-quality hero content, powerful GPU</p>
              </div>
            </div>
            <Warning>
              Video mode requires the Wan 2.2 (or equivalent) ComfyUI workflow and compatible models installed in ComfyUI. The job timeout is set to 2 hours to accommodate slow GPU inference.
            </Warning>

            <SubHeading id="walkthrough" title='Example: Creating a "Fun Science Facts" Series' />
            <div className="space-y-4 text-sm text-txt-secondary leading-relaxed">
              <p><strong className="text-txt-primary">1. Create the series.</strong> Go to Series → New Series. Name it "Fun Science Facts". In the Series Bible field, write: <em>"Short, engaging science explainers for kids aged 10-14. Each episode answers one question in under 55 seconds. Use the Feynman technique — explain complex ideas simply. End every episode with a surprising fact."</em></p>
              <p><strong className="text-txt-primary">2. Set defaults.</strong> Choose your voice profile (e.g. Edge TTS "en-US-AriaNeural"), set scene mode to Image, select your DreamShaper ComfyUI workflow, set caption style to "youtube_highlight".</p>
              <p><strong className="text-txt-primary">3. Add episodes.</strong> Add topics: "Why is the sky blue?", "How do planes fly?", "What is DNA?", "Why do we dream?", "How does WiFi work?"</p>
              <p><strong className="text-txt-primary">4. Generate.</strong> Click Generate on the first episode. Watch the Activity Monitor. In 5–8 minutes you'll have a finished 9:16 Short with animated captions, voice narration, and AI-generated scene illustrations.</p>
              <p><strong className="text-txt-primary">5. Review and upload.</strong> Open the episode, play the video, make any edits, then Export → Upload to YouTube. The title and description are pre-filled from the script.</p>
            </div>
          </section>

          {/* ================================================================
              3. EPISODE DETAIL
          ================================================================ */}
          <section id="episode-detail" className="mb-16 scroll-mt-4">
            <SectionHeading id="episode-detail-heading" icon={FileText} title="Episode Detail" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              The Episode Detail page is your editing workspace. After generation, every aspect of the episode is
              editable without requiring a full regeneration.
            </p>

            <SubHeading id="script-tab" title="Script Tab" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The Script tab shows the full episode script as a list of scenes. Each scene has four editable fields:
            </p>
            <div className="space-y-2 mb-4">
              {[
                { field: 'Narration', desc: 'The spoken text for this scene. This is what the TTS provider reads aloud. Keep it concise — one clear thought per scene works best.' },
                { field: 'Visual Prompt', desc: 'The image generation prompt sent to ComfyUI. Describe the scene visually. Include style modifiers and negative prompts if needed.' },
                { field: 'Duration', desc: 'Scene duration in seconds. Used during assembly to determine how long the scene visual is shown. Defaults to match the voice audio length.' },
                { field: 'Keywords', desc: 'Comma-separated words that will receive buzzword emphasis in captions. These words will pop to center screen with a glow effect when spoken.' },
              ].map(item => (
                <div key={item.field} className="flex gap-3 p-3 surface rounded">
                  <span className="text-xs font-mono font-semibold text-accent w-28 shrink-0 mt-0.5">{item.field}</span>
                  <p className="text-sm text-txt-secondary">{item.desc}</p>
                </div>
              ))}
            </div>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              After editing scene narration, you have two options: click <strong className="text-txt-primary">Regenerate Voice</strong> to re-run voice synthesis + all downstream steps (captions, assembly, thumbnail), or <strong className="text-txt-primary">Reassemble</strong> to skip re-generating voice and only redo assembly.
            </p>
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Scene Example</p>
              <CodeBlock>{`Scene 3 of 6

Narration:
"Light from the sun looks white, but it's actually made
of all the colors of the rainbow mixed together."

Visual Prompt:
"A beam of white sunlight passing through a glass prism,
splitting into a vibrant rainbow spectrum. Clean studio
background. Photorealistic. Sharp focus."

Duration: 8s

Keywords: rainbow, sunlight, prism`}</CodeBlock>
            </div>

            <SubHeading id="scenes-tab" title="Scenes Tab" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The Scenes tab provides a visual grid of all scene images/videos. From here you can:
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Regenerate a scene</strong> — click the regenerate button on any scene to re-run ComfyUI for that scene only, then automatically reassemble the final video. Useful when one image looks wrong.</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Edit the visual prompt</strong> — modify the prompt for a scene and click Regenerate Scene to get a new image.</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Delete a scene</strong> — removes the scene from the script. Remaining scenes are automatically renumbered.</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Reorder scenes</strong> — drag to reorder or use the reorder endpoint. The new order is saved and reflected in the next assembly.</span></li>
            </ul>
            <Tip>
              If you only want to change the visual for one scene without affecting the audio, edit its visual prompt and click Regenerate Scene. This re-runs just that one ComfyUI job and then reassembles — typically 2–4 minutes.
            </Tip>

            <SubHeading id="captions-tab" title="Captions Tab" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Drevalis Creator Studio includes five built-in caption style presets. Captions are generated from word-level
              timestamps produced by faster-whisper and rendered as an ASS subtitle overlay burned into the video.
            </p>
            <div className="space-y-3 mb-4">
              {[
                {
                  id: 'youtube_highlight',
                  name: 'YouTube Highlight',
                  color: '#FBBF24',
                  desc: 'All words in the current line are visible at once. The active (currently spoken) word is highlighted in gold/amber. Large Impact-style font. The most popular style for educational Shorts.',
                },
                {
                  id: 'karaoke',
                  name: 'Karaoke',
                  color: '#60A5FA',
                  desc: 'One word appears at a time with a smooth fade transition. Clean and minimal. Works well for slower, deliberate narration where each word should land.',
                },
                {
                  id: 'tiktok_pop',
                  name: 'TikTok Pop',
                  color: '#F472B6',
                  desc: 'Words pop in with a scale animation — starting large and snapping to size. High energy. Works well for fast-paced content and hooks.',
                },
                {
                  id: 'minimal',
                  name: 'Minimal',
                  color: '#9898A0',
                  desc: 'Small, clean text with no outline or shadow. Subtle and unobtrusive. Best for content where the visual should dominate and captions are secondary.',
                },
                {
                  id: 'classic',
                  name: 'Classic',
                  color: '#EDEDEF',
                  desc: 'White text with a solid black outline. Timeless, highly readable against any background. Similar to traditional movie subtitles.',
                },
              ].map(style => (
                <div key={style.id} className="flex gap-3 p-3 surface rounded-lg">
                  <div className="w-1 rounded-full shrink-0" style={{ backgroundColor: style.color }} />
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <code className="text-xs font-mono text-txt-tertiary">{style.id}</code>
                      <span className="text-sm font-medium text-txt-primary">— {style.name}</span>
                    </div>
                    <p className="text-xs text-txt-secondary leading-relaxed">{style.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              <strong className="text-txt-primary">Buzzword Effects:</strong> If you add keywords to a scene,
              those words will trigger a special overlay animation when spoken — the word "pops" to the center of
              the screen in a large, glowing style, then fades back. This is separate from the line caption and
              adds emphasis to key terms.
            </p>
            <Warning>
              After changing caption style, you must click Reassemble (not just save) for the new style to appear in the video. The caption file is regenerated as part of the assembly step.
            </Warning>

            <SubHeading id="music-tab" title="Music Tab" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The Music tab lets you add background music to an episode. Drevalis Creator Studio supports two music sources:
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><Music size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">AceStep AI Generation</strong> — generates a custom music track tuned to your selected mood. Requires AceStep models installed in ComfyUI. Click Generate Music and wait 60–180 seconds.</span></li>
              <li className="flex gap-2"><Music size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Curated Library</strong> — a collection of royalty-free music organized by mood. Available immediately without GPU generation.</span></li>
            </ul>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Controls: <strong className="text-txt-primary">Music Volume</strong> sets the background music level (0–100%). When sidechain ducking is enabled (recommended), the music automatically lowers when the narrator speaks and rises during pauses, keeping dialogue clearly audible.
            </p>
            <Tip>
              Set music volume to 20–35% with sidechain ducking enabled for the most natural-sounding mix. Higher volumes can overwhelm the narration.
            </Tip>

            <SubHeading id="video-editor" title="Video Editor" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The Video Editor tab provides post-processing controls applied during the final assembly step:
            </p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {[
                { icon: Scissors, name: 'Trim', desc: 'Set in/out points to trim the beginning and/or end of the final video.' },
                { icon: Layers, name: 'Borders', desc: 'Add colored border/frame overlays. Useful for brand consistency across episodes.' },
                { icon: Star, name: 'Color Filters', desc: 'Apply LUT-based color grading presets (warm, cool, cinematic, etc.).' },
                { icon: Clock, name: 'Speed', desc: 'Adjust playback speed (0.5x to 2x). Audio is pitch-corrected automatically.' },
              ].map(item => (
                <div key={item.name} className="surface p-3 rounded-lg flex gap-2">
                  <item.icon size={14} className="text-accent shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-txt-primary mb-0.5">{item.name}</p>
                    <p className="text-xs text-txt-secondary">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <SubHeading id="per-episode-settings" title="Per-Episode Settings" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Each episode can override the series defaults for:
            </p>
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Voice Profile</strong> — use a different voice for this episode without changing the series default</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">Caption Style</strong> — override the caption preset for this specific episode</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">ComfyUI Workflow</strong> — use a different image/video generation workflow</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span><strong className="text-txt-primary">LLM Config</strong> — use a different model for script regeneration</span></li>
            </ul>
          </section>

          {/* ================================================================
              4. TEXT TO VOICE
          ================================================================ */}
          <section id="text-to-voice" className="mb-16 scroll-mt-4">
            <SectionHeading id="text-to-voice-heading" icon={Mic} title="Text to Voice (Content Studio)" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              The Text to Voice studio converts any long-form text into narrated audio or video content. It supports
              single-voice narration, multi-character dialogue, chapters, background music, and multiple output
              formats.
            </p>

            <SubHeading id="single-voice" title="Single Voice Narration" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The simplest mode. Paste your text, select a voice profile, and click Generate. The entire text is
              read aloud by a single narrator. Ideal for:
            </p>
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" />Faceless YouTube videos with AI narration</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" />Article-to-audio conversion</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" />Simple audiobook generation</li>
            </ul>

            <SubHeading id="multi-voice" title="Multi-Voice with Speaker Tags" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Add <code className="font-mono text-accent text-xs">[Speaker Name]</code> tags at the start of lines
              to assign different voices to different characters. Each tag switches the active voice for all
              following lines until the next tag.
            </p>
            <CodeBlock>{`[Narrator] The door opened slowly, revealing the old library.
A dusty smell filled the room.

[Alice] Who's there? I can hear you breathing.

[Bob] It's me — your old friend from the academy.
      I haven't seen you in fifteen years.

[Alice] Fifteen years... I'd almost given up hope.

[Narrator] She stepped forward, her hand trembling
as she reached for the lamp.`}</CodeBlock>
            <p className="text-sm text-txt-secondary leading-relaxed mt-3 mb-3">
              After writing your script, map each speaker tag to a voice profile. Characters without a mapping
              use the default voice. Voice assignments are saved per audiobook and can be changed and re-generated.
            </p>
            <Tip>
              Use distinct voice profiles for each character — different gender, accent, or speaking speed. This makes dialogue far easier to follow, especially in longer pieces.
            </Tip>

            <SubHeading id="chapters" title="Chapter Support" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Add chapter markers using Markdown H2 headers. Chapters are detected automatically and appear as
              navigation points in the output. This is especially useful for long audiobooks.
            </p>
            <CodeBlock>{`## Chapter 1: The Arrival

[Narrator] The train pulled into the station at exactly midnight.

## Chapter 2: The Discovery

[Alice] I found something in the basement. Come quickly.

## Chapter 3: Revelations

[Narrator] What she had found would change everything.`}</CodeBlock>
            <p className="text-sm text-txt-secondary leading-relaxed mt-3">
              Each chapter can be previewed, edited, and regenerated individually from the audiobook detail page —
              no need to regenerate the entire audiobook to fix one chapter.
            </p>

            <SubHeading id="output-formats" title="Output Formats" />
            <div className="space-y-3 mb-4">
              {[
                {
                  format: 'audio_only',
                  desc: 'Generates a WAV master file and an MP3 for distribution. No video. Best for podcast episodes and audio-only platforms.',
                },
                {
                  format: 'audio_image',
                  desc: 'Generates an MP4 video with the cover image displayed statically while audio plays. Standard for YouTube audiobook uploads. Can be portrait (9:16) or landscape (16:9).',
                },
                {
                  format: 'audio_video',
                  desc: 'Generates an MP4 video with a dark animated background while audio plays. More visually engaging than a static image. Supports caption overlay.',
                },
              ].map(item => (
                <div key={item.format} className="flex gap-3 p-3 surface rounded">
                  <code className="text-xs font-mono text-accent shrink-0 mt-0.5">{item.format}</code>
                  <p className="text-sm text-txt-secondary leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>

            <SubHeading id="audiobook-captions" title="Caption Styles for Audiobooks" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              All five caption styles available for Shorts (youtube_highlight, karaoke, tiktok_pop, minimal,
              classic) are also available for audiobook videos. Captions are generated from the same word-level
              faster-whisper transcription pipeline. Enable captions in the audiobook settings before generating.
            </p>
            <InfoBox>
              Orientation matters for caption legibility. Portrait (9:16) captions are centered with larger font for mobile viewing. Landscape (16:9) uses a wider layout optimized for desktop/TV.
            </InfoBox>
          </section>

          {/* ================================================================
              5. VOICE PROFILES
          ================================================================ */}
          <section id="voice-profiles" className="mb-16 scroll-mt-4">
            <SectionHeading id="voice-profiles-heading" icon={Volume2} title="Voice Profiles" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              A Voice Profile defines a TTS provider, voice model, and audio processing settings. You can create
              as many profiles as you need — one per character, language, or style.
            </p>

            <SubHeading id="providers" title="Supported TTS Providers" />
            <div className="space-y-3 mb-4">
              {[
                {
                  name: 'Edge TTS',
                  tag: 'Free cloud',
                  tagColor: 'success',
                  desc: 'Microsoft\'s neural TTS service. No API key required. 17+ voices included (en-US-AriaNeural, en-US-GuyNeural, en-GB-SoniaNeural, en-AU-NatashaNeural, and more). Good quality for most use cases. Requires internet connection.',
                  voices: 'en-US-AriaNeural, en-US-GuyNeural, en-US-JennyNeural, en-GB-RyanNeural, en-AU-WilliamNeural',
                },
                {
                  name: 'Piper TTS',
                  tag: 'Local / Free',
                  tagColor: 'info',
                  desc: 'Offline ONNX-based TTS. Download voice model files (.onnx + .json) and place them in storage/models/piper/. Completely private — no internet required. Voice quality varies by model.',
                  voices: 'en_US-lessac-medium, en_US-ryan-high, en_GB-alan-low',
                },
                {
                  name: 'Kokoro TTS',
                  tag: 'Local / High Quality',
                  tagColor: 'info',
                  desc: 'High-quality local ONNX TTS via the kokoro library. Optional dependency (pip install .[kokoro]). Better voice quality than Piper for English. Runs on CPU or GPU.',
                  voices: 'af, af_bella, af_sarah, am_adam, bf_emma, bm_george',
                },
                {
                  name: 'ElevenLabs',
                  tag: 'Premium cloud',
                  tagColor: 'warning',
                  desc: 'Premium cloud TTS with the most natural-sounding voices. Requires an ElevenLabs API key (set in the voice profile). Costs credits per character generated.',
                  voices: 'Roger, Sarah, Laura, Charlie, George, Callum, River, Liam',
                },
              ].map(provider => (
                <div key={provider.name} className="surface p-4 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold text-txt-primary">{provider.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full bg-${provider.tagColor}/10 text-${provider.tagColor}`}>
                      {provider.tag}
                    </span>
                  </div>
                  <p className="text-xs text-txt-secondary leading-relaxed mb-2">{provider.desc}</p>
                  <p className="text-xs text-txt-tertiary">
                    <span className="font-medium text-txt-secondary">Example voices: </span>
                    {provider.voices}
                  </p>
                </div>
              ))}
            </div>

            <SubHeading id="creating-profile" title="Creating a Voice Profile Step by Step" />
            <div className="space-y-3 text-sm text-txt-secondary leading-relaxed">
              <p><strong className="text-txt-primary">1.</strong> Go to Settings → Voice Profiles → New Profile.</p>
              <p><strong className="text-txt-primary">2.</strong> Enter a name (e.g. "Aria — Energetic Female EN").</p>
              <p><strong className="text-txt-primary">3.</strong> Select Provider: choose Edge TTS, Piper, Kokoro, or ElevenLabs.</p>
              <p><strong className="text-txt-primary">4.</strong> Select Voice: the dropdown populates with available voices for the chosen provider. For ElevenLabs, enter your API key first.</p>
              <p><strong className="text-txt-primary">5.</strong> Adjust Speed (0.5x–2.0x) and Pitch (-20 to +20 semitones) if needed.</p>
              <p><strong className="text-txt-primary">6.</strong> Click Preview to hear a sample phrase read in the selected voice. Iterate until satisfied.</p>
              <p><strong className="text-txt-primary">7.</strong> Save. The profile is now available in all series and episode settings.</p>
            </div>

            <SubHeading id="voice-preview" title="Previewing Voices" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Every voice profile has a Preview button. Clicking it generates a short audio clip using the
              configured voice, speed, and pitch settings. The preview audio plays directly in the browser.
              Preview audio is cached in <code className="font-mono text-accent text-xs">storage/voice_previews/</code>
              so repeated previews are instant.
            </p>

            <SubHeading id="speed-pitch" title="Speed and Pitch Controls" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Speed and pitch are applied post-synthesis using FFmpeg audio filters:
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Speed:</strong> 0.5x (half speed) to 2.0x (double speed). 1.0x is the natural voice speed. Increasing speed reduces total video duration.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Pitch:</strong> -20 to +20 semitones. Positive values raise pitch (higher, lighter voice). Negative values lower pitch (deeper, heavier voice). 0 is no change.</li>
            </ul>
          </section>

          {/* ================================================================
              6. MUSIC & AUDIO
          ================================================================ */}
          <section id="music-audio" className="mb-16 scroll-mt-4">
            <SectionHeading id="music-audio-heading" icon={Music} title="Music & Audio" />

            <SubHeading id="acestep" title="AceStep AI Music Generation" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              AceStep is an AI music generation model that creates royalty-free background music customized to a
              mood prompt. It runs as a ComfyUI workflow — the music generation request is sent to your ComfyUI
              server the same way scene images are generated.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              When you select a mood and click Generate Music, Drevalis Creator Studio sends the mood description to ComfyUI,
              which runs AceStep and returns a WAV audio file. Generation typically takes 60–180 seconds depending
              on output duration and GPU speed.
            </p>
            <Warning>
              AceStep requires the AceStep ComfyUI custom node and model weights installed separately. If music generation fails with a "node not found" error, AceStep is not installed in your ComfyUI.
            </Warning>

            <SubHeading id="mood-presets" title="12 Mood Presets" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
              {[
                { mood: 'epic', desc: 'Orchestral, powerful build-ups. Good for dramatic reveals.' },
                { mood: 'calm', desc: 'Soft, ambient pads. Meditation and relaxation content.' },
                { mood: 'dark', desc: 'Tense, minor key. Mystery and thriller content.' },
                { mood: 'upbeat', desc: 'Positive, energetic. Lifestyle and travel content.' },
                { mood: 'cinematic', desc: 'Film-score style. Emotional storytelling.' },
                { mood: 'lofi', desc: 'Relaxed hip-hop beats. Study and focus content.' },
                { mood: 'ambient', desc: 'Atmospheric textures. Background filler.' },
                { mood: 'corporate', desc: 'Professional, motivational. Business content.' },
                { mood: 'playful', desc: 'Light, whimsical. Children\'s content.' },
                { mood: 'suspenseful', desc: 'Building tension. True crime, investigative.' },
                { mood: 'inspiring', desc: 'Uplifting, hopeful. Success stories.' },
                { mood: 'retro', desc: 'Vintage synth vibes. Nostalgic content.' },
              ].map(item => (
                <div key={item.mood} className="surface p-2.5 rounded">
                  <p className="text-xs font-mono font-semibold text-accent mb-1">{item.mood}</p>
                  <p className="text-xs text-txt-tertiary leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>

            <SubHeading id="mastering" title="Audio Mastering Chain" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              When background music is mixed with narration, Drevalis Creator Studio applies an automated mastering chain
              via FFmpeg audio filters. The chain runs during the Assembly step:
            </p>
            <div className="space-y-2 mb-4">
              {[
                { stage: 'Voice EQ', desc: 'High-pass filter (80Hz cut) removes low-end rumble from TTS audio. Slight presence boost around 3kHz for clarity.' },
                { stage: 'Compression', desc: 'Soft-knee compression on the voice track normalizes dynamic range so quiet and loud passages are balanced.' },
                { stage: 'Music Reverb', desc: 'Subtle room reverb on the music track blends it into the same acoustic space as the narration.' },
                { stage: 'Sidechain Ducking', desc: 'Music volume is automatically lowered when the narrator speaks. Restores to full level during pauses.' },
                { stage: 'Final Limiter', desc: 'Hard limiter on the mix output prevents clipping at -1dBFS. Ensures consistent loudness across episodes.' },
              ].map(item => (
                <div key={item.stage} className="flex gap-3 p-3 surface rounded">
                  <Hash size={13} className="text-accent shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-txt-primary mb-0.5">{item.stage}</p>
                    <p className="text-xs text-txt-secondary leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <SubHeading id="sidechain" title="Sidechain Ducking Explained Simply" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Sidechain ducking is a professional audio technique used in every podcast and video. The basic idea:
            </p>
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-sm text-txt-secondary leading-relaxed">
                Imagine two audio tracks — the narrator's voice and background music. Without ducking, both play
                at the same volume and the music competes with speech. With sidechain ducking, the music "listens"
                to the voice track. When the narrator starts speaking, the music automatically dips to a lower
                volume. When the narrator pauses (breath, end of sentence), the music rises back up. The result
                sounds natural — like the music is giving way to the voice, then filling the silence again.
              </p>
            </div>
            <p className="text-sm text-txt-secondary leading-relaxed">
              In Drevalis Creator Studio, the ducking ratio is 6dB by default (music drops to ~50% perceived volume when
              voice is present) with a 50ms attack and 500ms release. These values produce natural transitions
              without abrupt pumping.
            </p>
          </section>

          {/* ================================================================
              7. SOCIAL MEDIA & YOUTUBE
          ================================================================ */}
          <section id="social-youtube" className="mb-16 scroll-mt-4">
            <SectionHeading id="social-youtube-heading" icon={Youtube} title="Social Media & YouTube" />

            <SubHeading id="connect-youtube" title="Connecting YouTube (OAuth Flow)" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Drevalis Creator Studio uses Google OAuth 2.0 to connect your YouTube channel. The flow requires a Google
              Cloud project with the YouTube Data API v3 enabled.
            </p>
            <div className="space-y-2 text-sm text-txt-secondary leading-relaxed mb-4">
              <p><strong className="text-txt-primary">Prerequisites:</strong></p>
              <ol className="list-decimal list-inside space-y-1.5 ml-3">
                <li>Create a project in the <a href="https://console.cloud.google.com" className="text-accent hover:underline" target="_blank" rel="noreferrer">Google Cloud Console</a></li>
                <li>Enable the YouTube Data API v3 for the project</li>
                <li>Create OAuth 2.0 credentials (type: Web application)</li>
                <li>Add <code className="font-mono text-xs text-accent">http://localhost:8000/api/v1/youtube/callback</code> as an authorized redirect URI</li>
                <li>Copy the Client ID and Client Secret into your <code className="font-mono text-xs text-accent">.env</code> file as <code className="font-mono text-xs text-accent">YOUTUBE_CLIENT_ID</code> and <code className="font-mono text-xs text-accent">YOUTUBE_CLIENT_SECRET</code></li>
                <li>Restart the backend</li>
              </ol>
              <p className="mt-3"><strong className="text-txt-primary">Connect:</strong> Go to Settings → YouTube → Connect Account. You'll be redirected to Google's OAuth consent screen. After granting permissions, you're returned to the app and the channel is connected.</p>
            </div>
            <InfoBox>
              OAuth tokens are encrypted at rest using Fernet encryption. They are never stored or logged in plaintext. The app automatically refreshes expired tokens using the refresh token.
            </InfoBox>

            <SubHeading id="connect-other" title="Connecting TikTok, Instagram, and X" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              TikTok, Instagram, and X (Twitter) connections use platform-specific API tokens rather than OAuth.
              Go to Settings → Social Media and enter your API credentials for each platform. Once connected,
              videos can be uploaded directly from the episode export menu.
            </p>
            <Warning>
              TikTok and Instagram require developer app approval for upload access. Standard personal accounts do not have API upload permissions without an approved app registration on each platform.
            </Warning>

            <SubHeading id="uploading" title="Uploading Videos" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              From any episode detail page, open the <strong className="text-txt-primary">Export</strong> dropdown
              and select <strong className="text-txt-primary">Upload to YouTube</strong>. An upload dialog
              pre-fills the video title, description, and tags from the episode script. You can edit these before
              uploading.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The description is formatted for YouTube with the episode summary, keywords as hashtags, and a
              generated call-to-action. The export bundle (ZIP) includes the MP4 video, thumbnail JPEG, and
              description text file.
            </p>

            <SubHeading id="playlists" title="Playlists" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Episodes from the same series can be automatically added to a YouTube playlist. Set the playlist ID
              in the series settings. All future uploads from that series will be added to the playlist.
            </p>

            <SubHeading id="privacy" title="Privacy Settings" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {[
                { level: 'Private', desc: 'Only you can see the video. Default for all uploads.' },
                { level: 'Unlisted', desc: 'Anyone with the link can see it. Not searchable.' },
                { level: 'Public', desc: 'Visible to everyone. Indexed by YouTube search.' },
              ].map(item => (
                <div key={item.level} className="surface p-3 rounded-lg text-center">
                  <p className="text-sm font-semibold text-txt-primary mb-1">{item.level}</p>
                  <p className="text-xs text-txt-secondary">{item.desc}</p>
                </div>
              ))}
            </div>
            <Tip>
              Upload as Private first, verify the video looks correct in YouTube Studio, then change to Public manually. This avoids publishing videos with issues.
            </Tip>
          </section>

          {/* ================================================================
              8. LONG-FORM VIDEOS
          ================================================================ */}
          <section id="longform-videos" className="mb-16 scroll-mt-4">
            <SectionHeading id="longform-videos-heading" icon={Film} title="Long-Form Videos" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              In addition to 60-second Shorts, Drevalis Creator Studio supports documentary-style long-form videos
              ranging from 15 minutes to over an hour. Long-form videos use the same pipeline but with
              chapter-aware assembly, per-chapter music, and 16:9 landscape output.
            </p>

            <SubHeading id="longform-overview" title="Overview & Content Format Toggle" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Each series has a <strong className="text-txt-primary">Content Format</strong> setting that controls
              the output type. Switching from <code className="font-mono text-accent text-xs">shorts</code> to{' '}
              <code className="font-mono text-accent text-xs">longform</code> changes several defaults:
            </p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="surface p-4 rounded-lg">
                <p className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Shorts Mode</p>
                <ul className="space-y-1.5 text-xs text-txt-secondary">
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />9:16 portrait (1080×1920)</li>
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Up to 60 seconds</li>
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Single music track</li>
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />6 pipeline steps</li>
                </ul>
              </div>
              <div className="surface p-4 rounded-lg">
                <p className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Long-Form Mode</p>
                <ul className="space-y-1.5 text-xs text-txt-secondary">
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />16:9 landscape (1920×1080)</li>
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />15–60+ minutes</li>
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Per-chapter background music</li>
                  <li className="flex gap-2"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Chapter-aware assembly</li>
                </ul>
              </div>
            </div>

            <SubHeading id="longform-series" title="Creating a Long-Form Series" />
            <div className="space-y-3 text-sm text-txt-secondary leading-relaxed mb-4">
              <p><strong className="text-txt-primary">1.</strong> Go to Series → New Series.</p>
              <p><strong className="text-txt-primary">2.</strong> Set <strong className="text-txt-primary">Content Format</strong> to <code className="font-mono text-accent text-xs">longform</code>.</p>
              <p><strong className="text-txt-primary">3.</strong> Set <strong className="text-txt-primary">Scenes Per Chapter</strong> — how many visual scenes the LLM generates per chapter (typically 4–8). More scenes means more visual variety but longer generation time.</p>
              <p><strong className="text-txt-primary">4.</strong> Write a series bible that describes the documentary style, chapter structure, and narration tone.</p>
              <p><strong className="text-txt-primary">5.</strong> Optionally add a <strong className="text-txt-primary">Visual Consistency Prompt</strong> — a shared style fragment appended to every scene's image prompt to keep the visual aesthetic coherent across all chapters (e.g. "cinematic 16mm film grain, warm color grading, shallow depth of field").</p>
            </div>
            <Tip>
              For long-form videos, use Wan 2.2 video clips (Video Mode) rather than static images. The motion adds production value that justifies longer watch time. Expect 45–90 minutes of total generation time on a mid-range GPU.
            </Tip>

            <SubHeading id="longform-chapters" title="Chapter-Aware Assembly" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Long-form episodes are structured as a list of chapters, each with its own scenes, narration,
              and optional music mood. Assembly is chapter-aware: each chapter is composited independently
              first, then joined in sequence. This means:
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span>Each chapter can have a <strong className="text-txt-primary">different music mood</strong> — e.g. "calm" for the introduction, "epic" for the climax, "ambient" for the conclusion.</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span>Individual chapters can be <strong className="text-txt-primary">regenerated</strong> without re-running the entire episode.</span></li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><span>Chapter titles are embedded as <strong className="text-txt-primary">YouTube chapter markers</strong> in the video description automatically.</span></li>
            </ul>

            <SubHeading id="longform-output" title="16:9 Output & Visual Consistency" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Long-form output is rendered at 1920×1080 (16:9) at 30fps. Caption layout adapts automatically
              to the wider aspect ratio — text is positioned in the lower third rather than centered.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The <strong className="text-txt-primary">Visual Consistency Prompt</strong> (set in series settings)
              is appended to every scene's visual prompt before it is sent to ComfyUI. This keeps the color
              grading, lighting style, and art direction consistent across all scenes regardless of their
              individual content.
            </p>
            <InfoBox>
              Long-form jobs are assigned lower priority than Shorts in the worker queue. Shorts in the same queue will complete first. You can monitor queue position in the Activity Monitor.
            </InfoBox>
          </section>

          {/* ================================================================
              9. MULTI-CHANNEL YOUTUBE
          ================================================================ */}
          <section id="multi-channel" className="mb-16 scroll-mt-4">
            <SectionHeading id="multi-channel-heading" icon={Youtube} title="Multi-Channel YouTube" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              Drevalis Creator Studio supports connecting multiple YouTube channels simultaneously — useful for
              managing separate channels per niche, language, or brand. Each series can be assigned to a
              specific channel for upload.
            </p>

            <SubHeading id="multi-channel-connect" title="Connecting Multiple Channels" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Each YouTube channel goes through its own OAuth flow. To connect a second (or third) channel:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-sm text-txt-secondary ml-3 mb-4">
              <li>Go to Settings → YouTube.</li>
              <li>Click <strong className="text-txt-primary">Connect Another Channel</strong>. You will be redirected to Google's OAuth consent screen.</li>
              <li>Sign in with the Google account that owns the target channel and grant permissions.</li>
              <li>The channel appears in the connected channels list with its channel name, subscriber count, and connection status.</li>
            </ol>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Each channel's OAuth tokens are stored independently and encrypted at rest. Tokens are refreshed
              automatically when they expire. You can disconnect any channel individually without affecting others.
            </p>
            <Warning>
              The YouTube Data API v3 has a daily upload quota (10,000 units per project by default). Each upload consumes approximately 1,600 units. If you are managing many channels under one Google Cloud project, consider requesting a quota increase.
            </Warning>

            <SubHeading id="multi-channel-assign" title="Assigning Channels to Series" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Open any series and go to the <strong className="text-txt-primary">Upload Settings</strong> tab.
              Select a connected YouTube channel from the <strong className="text-txt-primary">Default Channel</strong>
              dropdown. All episodes in this series will upload to the selected channel by default. Individual
              episodes can override this channel selection in their own upload dialog.
            </p>
            <Tip>
              Create one series per YouTube channel/niche to keep content and settings organized. The series bible, voice profile, and visual style will stay consistent across all episodes on that channel.
            </Tip>

            <SubHeading id="multi-channel-schedule" title="Scheduled Publishing" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              When uploading a video, set a <strong className="text-txt-primary">Publish At</strong> datetime to
              schedule the video as a YouTube Premier or to release it at a specific time. The video is uploaded
              immediately but stays private until the scheduled time, at which point YouTube automatically makes
              it public.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Scheduled uploads are shown in the episode's Upload History with their scheduled publish time and
              current YouTube status. The app polls the YouTube API periodically to update status.
            </p>
            <InfoBox>
              Scheduled publishing uses YouTube's native scheduling — the video is uploaded to YouTube servers immediately. You do not need to keep the app running until the scheduled time.
            </InfoBox>
          </section>

          {/* ================================================================
              10. WORKER MANAGEMENT
          ================================================================ */}
          <section id="worker-management" className="mb-16 scroll-mt-4">
            <SectionHeading id="worker-management-heading" icon={Server} title="Worker Management" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              All heavy processing (script generation, TTS, scene generation, assembly) runs as background jobs
              in the arq worker process. The Activity Monitor and Jobs page give you visibility and control over
              the worker queue.
            </p>

            <SubHeading id="worker-health" title="Worker Health & Monitoring" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The <strong className="text-txt-primary">Activity Monitor</strong> (floating panel, bottom-right)
              shows all active and recently completed jobs with real-time step-by-step progress via WebSocket.
              For a deeper view, go to <strong className="text-txt-primary">Jobs</strong> in the sidebar:
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Active Jobs</strong> — currently running pipeline jobs, their step, progress percentage, and elapsed time.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Queue Status</strong> — jobs waiting to start. Shows queue depth and estimated wait time.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Recent History</strong> — completed and failed jobs with per-step duration metrics.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Cleanup Stuck Jobs</strong> — forcibly marks all hung jobs as failed so they can be retried.</li>
            </ul>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Settings → Health shows the current status of all connected services: database, Redis, ComfyUI
              servers, and FFmpeg. A green check on all services means the worker can operate normally.
            </p>

            <SubHeading id="worker-priority" title="Priority Queue" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The arq worker uses a two-tier priority queue:
            </p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="surface p-4 rounded-lg border-l-2 border-accent">
                <p className="text-sm font-semibold text-txt-primary mb-1">High Priority</p>
                <ul className="space-y-1 text-xs text-txt-secondary">
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />YouTube Shorts generation</li>
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Retry jobs (failed steps)</li>
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Single scene regeneration</li>
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-accent shrink-0 mt-0.5" />Reassemble (captions + assembly only)</li>
                </ul>
              </div>
              <div className="surface p-4 rounded-lg border-l-2 border-border">
                <p className="text-sm font-semibold text-txt-primary mb-1">Standard Priority</p>
                <ul className="space-y-1 text-xs text-txt-secondary">
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-txt-tertiary shrink-0 mt-0.5" />Long-form video generation</li>
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-txt-tertiary shrink-0 mt-0.5" />Audiobook generation</li>
                  <li className="flex gap-1.5"><ChevronRight size={11} className="text-txt-tertiary shrink-0 mt-0.5" />Voice preview generation</li>
                </ul>
              </div>
            </div>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              When both a Short and a long-form video are queued, the Short will always start first.
              This prevents a 60-minute documentary job from blocking a 5-minute Shorts job.
            </p>
            <InfoBox>
              The worker runs up to 4 jobs simultaneously (<code className="font-mono text-xs text-accent">MAX_CONCURRENT_GENERATIONS=4</code>). Lower this if your GPU runs out of VRAM when multiple ComfyUI jobs run in parallel.
            </InfoBox>

            <SubHeading id="worker-restart" title="Restarting the Worker" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              If the worker process becomes unresponsive or you need to apply configuration changes:
            </p>
            <div className="space-y-2">
              {[
                { label: 'Docker (recommended)', cmd: 'docker compose restart worker' },
                { label: 'Local dev', cmd: 'Ctrl+C to stop, then re-run: python -m arq src.drevalis.workers.settings.WorkerSettings' },
              ].map(item => (
                <div key={item.label} className="surface p-3 rounded-lg">
                  <p className="text-xs font-semibold text-txt-primary mb-1">{item.label}</p>
                  <code className="text-xs font-mono text-accent">{item.cmd}</code>
                </div>
              ))}
            </div>
            <Warning>
              Restarting the worker will kill any currently running jobs. Those jobs will remain in "generating" state until you run Cleanup Stuck Jobs, after which they can be retried. Completed pipeline steps are preserved — the retry resumes from the failed step.
            </Warning>
          </section>

          {/* ================================================================
              11. LOAD BALANCING
          ================================================================ */}
          <section id="load-balancing" className="mb-16 scroll-mt-4">
            <SectionHeading id="load-balancing-heading" icon={Layers} title="Load Balancing" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-5">
              Drevalis Creator Studio can distribute work across multiple ComfyUI servers and LLM endpoints. This is
              useful when you have several machines with GPUs, or when you want to separate image generation
              from video generation onto different hardware.
            </p>

            <SubHeading id="lb-comfyui" title="Registering Multiple ComfyUI Servers" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Go to Settings → ComfyUI Servers → Add Server. Register as many servers as you have available.
              Each server entry includes:
            </p>
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">URL</strong> — the server address (e.g. <code className="font-mono text-xs text-accent">http://192.168.1.50:8188</code>)</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Max Concurrent Jobs</strong> — how many ComfyUI workflows this server can run simultaneously. Set based on your GPU's VRAM capacity.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Active toggle</strong> — take a server offline temporarily without deleting it (useful for maintenance).</li>
            </ul>
            <Tip>
              For a typical two-GPU setup: register both servers with Max Concurrent Jobs = 1 each. Both will be used in parallel when generating a multi-scene episode — each scene goes to whichever server is free first.
            </Tip>

            <SubHeading id="lb-llm" title="Registering Multiple LLM Configs" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Multiple LLM configs can be registered (Settings → LLM Configs → Add Config). Each config can
              point to a different server or model. Series and episodes select which LLM config to use — you
              can run fast script generation for Shorts on a small local model while long-form documentaries
              use a larger, slower model for higher quality output.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Unlike ComfyUI servers, LLM configs are not pooled automatically — you select the config per
              series. However, multiple arq worker jobs running simultaneously will each make independent
              requests to their assigned LLM endpoint in parallel.
            </p>

            <SubHeading id="lb-distribution" title="How Distribution Works" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              ComfyUI server selection uses a <strong className="text-txt-primary">least-loaded acquisition strategy</strong>:
            </p>
            <div className="surface p-4 rounded-lg mb-4">
              <ol className="list-decimal list-inside space-y-2 text-sm text-txt-secondary ml-1">
                <li>When a scene needs to be generated, the server pool checks all active servers.</li>
                <li>Each server has a semaphore tracking its current job count vs. its <code className="font-mono text-xs text-accent">max_concurrent_jobs</code> limit.</li>
                <li>The server with the most available slots (i.e. fewest active jobs relative to its limit) is selected.</li>
                <li>If all servers are at capacity, the scene request waits until a slot opens.</li>
                <li>The scene job is sent to the selected server via the ComfyUI WebSocket API and polled for completion.</li>
              </ol>
            </div>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              For a typical episode with 6 scenes and 2 ComfyUI servers (each with <code className="font-mono text-xs text-accent">max_concurrent_jobs=1</code>),
              scenes are processed two at a time in parallel, roughly halving total scene generation time.
            </p>
            <InfoBox>
              All registered servers must have the required ComfyUI workflows and model weights installed. A workflow registered for one server will fail on another server that doesn't have the same models. Check Settings → ComfyUI → Test Connection to verify each server individually.
            </InfoBox>
          </section>

          {/* ================================================================
              12. SETTINGS
          ================================================================ */}
          <section id="settings" className="mb-16 scroll-mt-4">
            <SectionHeading id="settings-heading" icon={Settings} title="Settings" />

            <SubHeading id="comfyui-settings" title="ComfyUI Servers" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Drevalis Creator Studio supports multiple ComfyUI servers for parallel scene generation. Add servers in
              Settings → ComfyUI Servers. Each server has:
            </p>
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">URL</strong> — the ComfyUI server address (e.g. http://localhost:8188)</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">API Key</strong> — optional, if your ComfyUI instance is protected</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Max Concurrent Jobs</strong> — how many parallel workflow runs this server can handle</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Active/Inactive toggle</strong> — quickly disable a server without deleting it</li>
            </ul>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Click <strong className="text-txt-primary">Test Connection</strong> to verify the server is reachable
              and the API key is valid. The server pool uses a least-loaded acquisition strategy — scenes are
              routed to whichever server has the fewest active jobs.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              <strong className="text-txt-primary">Workflows</strong> define how images and videos are generated.
              Each workflow is a ComfyUI workflow JSON with input mappings that tell Drevalis Creator Studio which node IDs
              correspond to the prompt, seed, dimensions, and other parameters.
            </p>

            <SubHeading id="llm-settings" title="LLM Configs" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              LLM configs define the AI model used for script generation. Supported providers:
            </p>
            <div className="space-y-2 mb-4">
              {[
                { name: 'LM Studio', desc: 'Local LLM inference. Default URL: http://localhost:1234/v1. Works with any model loaded in LM Studio. The OpenAI-compatible API is used.' },
                { name: 'Ollama', desc: 'Local LLM via Ollama. Point the base URL to your Ollama server (e.g. http://localhost:11434/v1).' },
                { name: 'OpenAI', desc: 'OpenAI API. Enter your API key and select a model (gpt-4o, gpt-4o-mini, etc.).' },
                { name: 'Anthropic (Claude)', desc: 'Set the ANTHROPIC_API_KEY environment variable. Supports Claude 3.5 Sonnet, Claude 3 Haiku, and other Anthropic models.' },
              ].map(item => (
                <div key={item.name} className="flex gap-3 p-3 surface rounded">
                  <span className="text-xs font-mono font-semibold text-accent shrink-0 w-24 mt-0.5">{item.name}</span>
                  <p className="text-sm text-txt-secondary">{item.desc}</p>
                </div>
              ))}
            </div>
            <p className="text-sm text-txt-secondary leading-relaxed">
              Use <strong className="text-txt-primary">Test Connection</strong> to verify the LLM config works —
              it sends a minimal prompt and reports the response time and model name.
            </p>

            <SubHeading id="storage-settings" title="Storage" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Settings → Storage shows current disk usage broken down by category: episodes, audiobooks,
              voice previews, and models. All files are stored in the <code className="font-mono text-accent text-xs">storage/</code>
              directory relative to <code className="font-mono text-accent text-xs">STORAGE_BASE_PATH</code>.
            </p>
            <p className="text-sm text-txt-secondary leading-relaxed">
              Scene images and video clips are the largest storage consumers. A typical 6-scene Short uses
              50–200MB during generation (including temp files) and 10–30MB for the final MP4 output.
            </p>

            <SubHeading id="ffmpeg-settings" title="FFmpeg" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Settings → FFmpeg shows the detected FFmpeg version, path, and supported codecs. If FFmpeg is
              not detected, verify it is installed and available on your system PATH.
            </p>
            <InfoBox>
              Drevalis Creator Studio requires FFmpeg with libx264, libopus, and libmp3lame support. Most standard FFmpeg builds include these. The output codec is H.264 High profile with yuv420p pixel format for maximum browser compatibility.
            </InfoBox>
          </section>

          {/* ================================================================
              13. KEYBOARD SHORTCUTS
          ================================================================ */}
          <section id="keyboard-shortcuts" className="mb-16 scroll-mt-4">
            <SectionHeading id="keyboard-shortcuts-heading" icon={Keyboard} title="Keyboard Shortcuts" />

            <SubHeading id="player-shortcuts" title="Video Player" />
            <div className="surface rounded-lg overflow-hidden mb-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-txt-tertiary uppercase tracking-wider">Action</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-txt-tertiary uppercase tracking-wider">Shortcut</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-txt-tertiary uppercase tracking-wider">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    { action: 'Play / Pause', keys: ['Space', 'K'], notes: 'YouTube-style K shortcut also works' },
                    { action: 'Seek Back 5s', keys: ['←'], notes: 'Hold for continuous seeking' },
                    { action: 'Seek Forward 5s', keys: ['→'], notes: 'Hold for continuous seeking' },
                    { action: 'Seek Back 10s', keys: ['J'], notes: 'Standard media player shortcut' },
                    { action: 'Seek Forward 10s', keys: ['L'], notes: 'Standard media player shortcut' },
                    { action: 'Mute / Unmute', keys: ['M'], notes: '' },
                    { action: 'Volume Up', keys: ['↑'], notes: '+10% volume' },
                    { action: 'Volume Down', keys: ['↓'], notes: '-10% volume' },
                    { action: 'Fullscreen', keys: ['F'], notes: 'Toggle fullscreen mode' },
                    { action: 'Toggle Captions', keys: ['C'], notes: 'Show/hide caption overlay' },
                    { action: 'Speed 0.5x', keys: ['Shift+,'], notes: 'Slow down' },
                    { action: 'Speed 1x', keys: ['Shift+.'], notes: 'Normal speed' },
                    { action: 'Speed 2x', keys: ['Shift+/'], notes: 'Double speed' },
                  ].map(row => (
                    <tr key={row.action} className="hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2.5 text-txt-primary text-sm">{row.action}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 flex-wrap">
                          {row.keys.map(k => <Kbd key={k}>{k}</Kbd>)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-txt-tertiary">{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <SubHeading id="activity-monitor" title="Activity Monitor" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              The Activity Monitor is the floating panel in the bottom-right corner. It shows all running and
              recently completed pipeline jobs. It is visible on every page in the app.
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Drag to reposition</strong> — click and drag the header to move the Activity Monitor anywhere on screen.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Cancel jobs</strong> — click the X button on any running job to cancel it. Cancellation is checked between pipeline steps.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Collapse/expand</strong> — click the header to minimize the monitor without closing it.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Progress detail</strong> — each job shows the current step and a progress percentage in real time via WebSocket.</li>
            </ul>
          </section>

          {/* ================================================================
              LICENSE & TIERS
          ================================================================ */}
          <section id="license-tiers" className="mb-16 scroll-mt-4">
            <SectionHeading id="license-tiers-heading" icon={Star} title="License & Tiers" />

            <p className="text-sm text-txt-secondary leading-relaxed mb-4">
              Every tier includes the full feature set. Tier caps only concurrency, channel count, and cloud-GPU access. Annual billing saves ~2 months.
            </p>

            <SubHeading id="tier-solo" title="Solo - $19/mo (or $190/yr)" />
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4 mb-5">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> 1 activated machine</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> 5 episodes per day</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> 1 connected YouTube channel</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Edge, Piper, Kokoro TTS (local + free cloud)</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Automatic updates</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Email support, best-effort</li>
            </ul>
            <Tip>Best for a single creator on one channel with a local GPU. If you need to test multi-channel or RunPod offload, upgrade to Pro.</Tip>

            <SubHeading id="tier-pro" title="Pro - $39/mo (or $390/yr)" />
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4 mb-5">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> 3 machines</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Unlimited episodes per day</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> 3 connected YouTube channels</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Audiobook Studio</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> ElevenLabs TTS support</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> RunPod cloud-GPU offload</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Long-form video generation</li>
            </ul>

            <SubHeading id="tier-studio" title="Studio - $99/mo (or $990/yr)" />
            <ul className="space-y-1.5 text-sm text-txt-secondary ml-4 mb-5">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> 5 machines</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Unlimited everything</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Unlimited YouTube channels</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> TikTok + Instagram publishing</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Public API access</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /> Priority email support</li>
            </ul>

            <SubHeading id="tier-compare" title="Feature Matrix" />
            <div className="overflow-x-auto mb-5">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border text-txt-secondary text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-4">Capability</th>
                    <th className="text-center py-2 px-3">Solo</th>
                    <th className="text-center py-2 px-3">Pro</th>
                    <th className="text-center py-2 px-3">Studio</th>
                  </tr>
                </thead>
                <tbody className="text-txt-secondary">
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Machines</td><td className="text-center">1</td><td className="text-center">3</td><td className="text-center">5</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Episodes per day</td><td className="text-center">5</td><td className="text-center">Unlimited</td><td className="text-center">Unlimited</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">YouTube channels</td><td className="text-center">1</td><td className="text-center">3</td><td className="text-center">Unlimited</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Audiobook Studio</td><td className="text-center">-</td><td className="text-center">Yes</td><td className="text-center">Yes</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">ElevenLabs TTS</td><td className="text-center">-</td><td className="text-center">Yes</td><td className="text-center">Yes</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">RunPod offload</td><td className="text-center">-</td><td className="text-center">Yes</td><td className="text-center">Yes</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Long-form video</td><td className="text-center">-</td><td className="text-center">Yes</td><td className="text-center">Yes</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">TikTok + Instagram</td><td className="text-center">-</td><td className="text-center">-</td><td className="text-center">Yes</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-4">Public API</td><td className="text-center">-</td><td className="text-center">-</td><td className="text-center">Yes</td></tr>
                </tbody>
              </table>
            </div>

            <SubHeading id="tier-grace" title="Grace Period & Renewal" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">24h online check</strong> - every 24 hours your install heartbeats the license server for a fresh JWT.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">7-day offline grace</strong> - if the heartbeat fails (network out, server down), your install keeps working for a full week without any connection.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Past the grace window</strong> - generation and upload lock until you renew. Existing files on disk stay - nothing is deleted.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Renewal</strong> - visit Settings -&gt; License -&gt; Manage Subscription (opens Stripe's billing portal).</li>
            </ul>
          </section>

          {/* ================================================================
              HARDWARE & PERFORMANCE
          ================================================================ */}
          <section id="hardware-performance" className="mb-16 scroll-mt-4">
            <SectionHeading id="hardware-performance-heading" icon={HardDrive} title="Hardware & Performance" />

            <SubHeading id="hw-matrix" title="Hardware Matrix & Expected Times" />
            <p className="text-sm text-txt-secondary leading-relaxed mb-3">
              Realistic wall-clock times on typical builds. Scene generation dominates - GPU tier moves these numbers most. LLM and TTS steps are fast even on modest CPUs.
            </p>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border text-txt-secondary uppercase tracking-wider">
                    <th className="text-left py-2 pr-3">Build</th>
                    <th className="text-left py-2 pr-3">CPU / RAM</th>
                    <th className="text-left py-2 pr-3">GPU</th>
                    <th className="text-left py-2 pr-3">60s Short</th>
                    <th className="text-left py-2 pr-3">10m long-form</th>
                    <th className="text-left py-2 pr-3">30m audiobook</th>
                  </tr>
                </thead>
                <tbody className="text-txt-secondary">
                  <tr className="border-b border-border/50"><td className="py-2 pr-3"><strong className="text-txt-primary">Entry</strong></td><td className="py-2 pr-3">i5/Ryzen 5 6c, 16 GB</td><td className="py-2 pr-3">RTX 3060 8 GB</td><td className="py-2 pr-3">20-40 min</td><td className="py-2 pr-3">2.5-5 h</td><td className="py-2 pr-3">4-10 min</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-3"><strong className="text-txt-primary">Mid</strong></td><td className="py-2 pr-3">i7/Ryzen 7 8c, 32 GB</td><td className="py-2 pr-3">RTX 4070 12 GB</td><td className="py-2 pr-3">8-15 min</td><td className="py-2 pr-3">45-90 min</td><td className="py-2 pr-3">2-5 min</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-3"><strong className="text-txt-primary">High</strong></td><td className="py-2 pr-3">i9/Ryzen 9 12c+, 64 GB</td><td className="py-2 pr-3">RTX 4090 24 GB</td><td className="py-2 pr-3">3-7 min</td><td className="py-2 pr-3">20-40 min</td><td className="py-2 pr-3">1-3 min</td></tr>
                  <tr className="border-b border-border/50"><td className="py-2 pr-3"><strong className="text-txt-primary">Cloud</strong></td><td className="py-2 pr-3">any quad, 16 GB</td><td className="py-2 pr-3">RunPod A100/H100</td><td className="py-2 pr-3">3-8 min</td><td className="py-2 pr-3">30-60 min</td><td className="py-2 pr-3">2-5 min</td></tr>
                </tbody>
              </table>
            </div>

            <SubHeading id="hw-gpu" title="GPU Recommendations" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">8 GB VRAM minimum</strong> for image-only (Qwen Image) scene workflows at 720p. Below this you will OOM on the first scene.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">16 GB VRAM</strong> is the sweet spot - every workflow runs, long-form video (Wan 2.2) fits, caption generation via faster-whisper has headroom.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">24 GB VRAM (RTX 4090 / 3090)</strong> - runs multiple workflows concurrently; you can have ComfyUI + LM Studio both loaded without swapping.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">AMD ROCm</strong> works for ComfyUI but is slower; budget 2x the quoted times.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">No GPU</strong> - use RunPod on Pro/Studio. Episodes cost $0.10-0.50 each in compute depending on tier.</li>
            </ul>

            <SubHeading id="hw-scaling" title="Scaling: Multiple ComfyUI Servers" />
            <p className="text-sm text-txt-secondary mb-3">
              Drevalis parallelizes scene generation across every registered ComfyUI server. With 2 servers you get ~1.8x throughput; with 4 servers ~3.5x. Each server needs its own GPU.
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Add a server:</strong> Settings -&gt; ComfyUI Servers -&gt; Add. Specify URL, optional API key, and max_concurrent_video_jobs.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Round-robin:</strong> scenes are distributed round-robin. Each server has its own semaphore; a slow server doesn't block a fast one.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Concurrency scales:</strong> base is 4; each extra server adds +2 slots up to max_concurrent_generations.</li>
            </ul>
            <Tip>For long-form video, a second GPU dedicated to Wan 2.2 workflows is the single biggest speed-up. Run it on a secondary machine on your LAN.</Tip>

            <SubHeading id="hw-cloud" title="RunPod Cloud GPU (Pro / Studio)" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">A100 40 GB</strong> - ~$1.50/hr, runs all workflows smoothly. Good for bursty workloads.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">H100 80 GB</strong> - ~$3/hr, fastest option. Use for long-form video bursts only.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Stop when done</strong> - Settings -&gt; Cloud GPU -&gt; Stop. Stopped pods don't charge for compute but do for the persistent volume (~$0.05/GB/month).</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Delete when finished</strong> - stopping preserves state; deleting wipes the volume. Delete when you're done with the project to stop all charges.</li>
            </ul>

            <SubHeading id="hw-network" title="Network & Storage" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Disk:</strong> each 60s Short is ~30-50 MB final output + ~500 MB intermediate assets (cleaned up after success). Long-form 10 min can peak at 5 GB intermediate. Reserve 100+ GB for active use; backups can go off-box.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Upload bandwidth:</strong> YouTube/TikTok uploads hit ~50 Mbps each. Scheduling 5 uploads at once will saturate a 200 Mbps link.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">SSD strongly recommended:</strong> HDDs bottleneck the captions step (faster-whisper opens dozens of model weights).</li>
            </ul>
          </section>

          {/* ================================================================
              BACKUP & RESTORE
          ================================================================ */}
          <section id="backup-restore" className="mb-16 scroll-mt-4">
            <SectionHeading id="backup-restore-heading" icon={HardDrive} title="Backup & Restore" />

            <p className="text-sm text-txt-secondary leading-relaxed mb-4">
              Full-install backups bundle every database row (series, episodes, voice profiles, OAuth tokens, etc.) and your generated media (episodes/, audiobooks/, voice_previews/) into a single <code className="font-mono text-xs text-accent">.tar.gz</code>. Model files are NOT included - they re-download on first use.
            </p>

            <SubHeading id="br-manual" title="Manual Backup" />
            <ol className="space-y-2 text-sm text-txt-secondary ml-4 mb-4 list-decimal list-inside">
              <li>Settings -&gt; Backup.</li>
              <li>Click <strong className="text-txt-primary">Backup now</strong>.</li>
              <li>When done, click the download icon to save the archive to your desktop.</li>
            </ol>

            <SubHeading id="br-auto" title="Auto-Backup Schedule" />
            <p className="text-sm text-txt-secondary mb-3">
              Set <code className="font-mono text-xs">BACKUP_AUTO_ENABLED=true</code> in <code className="font-mono text-xs">.env</code> (via Docker Compose). The worker creates a backup every night at 03:00 UTC, pruning to the most recent <code className="font-mono text-xs">BACKUP_RETENTION</code> (default 7).
            </p>
            <CodeBlock>{`# .env\nBACKUP_AUTO_ENABLED=true\nBACKUP_RETENTION=14\nBACKUP_DIRECTORY=/app/storage/backups`}</CodeBlock>

            <SubHeading id="br-restore" title="Restoring an Archive" />
            <Warning>Restore is destructive. It truncates every user table (series, episodes, audiobooks, tokens) and overwrites storage files.</Warning>
            <ol className="space-y-2 text-sm text-txt-secondary ml-4 mb-4 list-decimal list-inside">
              <li>Settings -&gt; Backup -&gt; Restore from archive.</li>
              <li>Select the <code className="font-mono text-xs">.tar.gz</code> (from another install or a previous backup).</li>
              <li>Type <code className="font-mono text-xs">RESTORE</code> in the confirmation field.</li>
              <li>Click Restore. The app will refresh once the server-side restore completes.</li>
            </ol>

            <SubHeading id="br-smb" title="Off-Box: SMB / NFS Mount" />
            <p className="text-sm text-txt-secondary mb-3">
              To send backups to a NAS or network share, mount the share into the app container at <code className="font-mono text-xs">/app/storage/backups</code>:
            </p>
            <CodeBlock>{`# docker-compose.override.yml\nservices:\n  app:\n    volumes:\n      - type: bind\n        source: /mnt/nas/drevalis-backups\n        target: /app/storage/backups`}</CodeBlock>

            <SubHeading id="br-encryption" title="Encryption Keys & Cross-Install Migration" />
            <p className="text-sm text-txt-secondary mb-3">
              Archive manifests include a hash of the install's ENCRYPTION_KEY. Restoring into a machine with a different key is refused by default (OAuth tokens + API keys would be un-decryptable).
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Migrating a full install</strong> - copy the source install's <code className="font-mono text-xs">.env</code> (or at least <code className="font-mono text-xs">ENCRYPTION_KEY</code>) to the target before running restore.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Partial restore (new install, keep only content)</strong> - tick <strong className="text-txt-primary">Allow different ENCRYPTION_KEY</strong>; you will need to re-enter YouTube OAuth, ElevenLabs API key, etc.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Never lose your ENCRYPTION_KEY</strong> - without it, backups are effectively encrypted-at-rest data you can't read.</li>
            </ul>
          </section>

          {/* ================================================================
              UPDATES
          ================================================================ */}
          <section id="updates" className="mb-16 scroll-mt-4">
            <SectionHeading id="updates-heading" icon={Zap} title="Updates" />

            <SubHeading id="updates-how" title="How Updates Work" />
            <p className="text-sm text-txt-secondary mb-3">
              The license server maintains a manifest of the latest stable version. Your install checks this endpoint on demand (Settings -&gt; Updates) and daily via the license heartbeat.
            </p>
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Requires active license</strong> - the manifest endpoint returns 402 if your subscription has lapsed.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Docker images only</strong> - updates pull pre-built images from GHCR. No source-code compilation on your end.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Zero data loss</strong> - database volume + storage directory are preserved across updates. Alembic migrations run on boot of the new image.</li>
            </ul>

            <SubHeading id="updates-auto" title="In-App Update (Recommended)" />
            <ol className="space-y-2 text-sm text-txt-secondary ml-4 mb-4 list-decimal list-inside">
              <li>Settings -&gt; Updates.</li>
              <li>If a new version is listed, click <strong className="text-txt-primary">Update now</strong>.</li>
              <li>The updater sidecar pulls new images and restarts the stack (~60 seconds).</li>
              <li>The browser reconnects automatically once the health check passes.</li>
            </ol>

            <SubHeading id="updates-manual" title="Manual Update" />
            <CodeBlock>{`cd ~/Drevalis\ndocker compose pull\ndocker compose up -d`}</CodeBlock>

            <SubHeading id="updates-rollback" title="Rolling Back" />
            <p className="text-sm text-txt-secondary mb-3">
              If a new release breaks something, pin the previous version by editing <code className="font-mono text-xs">docker-compose.yml</code>:
            </p>
            <CodeBlock>{`# Change image lines from :stable to a specific tag, e.g. :0.1.7\nimage: ghcr.io/drevaliscs/creator-studio-app:0.1.7`}</CodeBlock>
            <p className="text-sm text-txt-secondary mb-4">
              Then <code className="font-mono text-xs">docker compose pull && docker compose up -d</code>. Report the issue to <a href="mailto:support@drevalis.com" className="text-accent underline">support@drevalis.com</a> with the version + a log snippet so we can fix it.
            </p>
          </section>

          {/* ================================================================
              PRO TIPS
          ================================================================ */}
          <section id="pro-tips" className="mb-16 scroll-mt-4">
            <SectionHeading id="pro-tips-heading" icon={Lightbulb} title="Pro Tips" />

            <SubHeading id="tips-quality" title="Getting Better Output Quality" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Series bible over per-episode tuning</strong> - invest 15 minutes writing a detailed series description + character description once. Every episode inherits it for free. A vague bible produces vague episodes.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Use a base seed</strong> for visual consistency across episodes in the same series. Settings -&gt; Series -&gt; base_seed. Keeps character faces + palettes stable.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Test voices before committing</strong> - Settings -&gt; Voice Profiles -&gt; Test. A voice that sounds fine on a single sentence can be grating over 10 minutes.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Review the script before scenes run</strong> - scene generation is 80% of wall time. Catching a bad script at the script-tab stage saves 20 minutes per episode.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Regenerate individual scenes</strong> instead of the whole episode when one frame looks wrong. The regenerate-scene flow reuses everything else.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Negative prompts are cheap insurance</strong> - add <code className="font-mono text-xs">blurry, extra fingers, text overlay, watermark</code> to the series negative_prompt.</li>
            </ul>

            <SubHeading id="tips-speed" title="Generating Faster" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Parallel episodes, not parallel scenes</strong> - running 3 episodes in parallel on a single GPU is slower than one episode at a time (GPU contention). Running 3 episodes across 3 ComfyUI servers is ~2.8x faster.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Use Edge TTS for drafts</strong> - it's free and runs in 2-5 seconds per minute of audio. Switch to Kokoro/ElevenLabs once the script is locked.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Keep LM Studio + ComfyUI warm</strong> - the first generation after boot is slow because models load into VRAM. Subsequent generations skip that.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Shorts_first priority</strong> - Activity Monitor -&gt; Priority. Queues long-form behind shorts so your daily uploads don't wait on a 2-hour long-form run.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Bulk-generate during off-hours</strong> - queue 10 episodes before bed. The worker processes them sequentially, using the GPU 100% through the night.</li>
            </ul>

            <SubHeading id="tips-workflow" title="Workflow" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">One series per channel</strong> - don't try to reuse a series across channels with different audiences. The tone drifts.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Topic lists in spreadsheets</strong> - paste 50 topics into bulk-generate. The LLM will write 50 scripts in ~20 minutes; you review and kill the duds.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Schedule, don't publish manually</strong> - Calendar -&gt; drag to a date/time. Consistent upload cadence matters more than upload count.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Back up after major milestones</strong> - finished a 10-episode season? Click Backup now. Cheap insurance.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Separate series for experiments</strong> - clone a working series into "<em>series-name</em> experiments" before testing a new voice / visual style. Keeps the prod series unpolluted.</li>
            </ul>

            <SubHeading id="tips-youtube" title="YouTube Growth" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">First 3 seconds decide everything</strong> - write the hook yourself. The LLM is good at filler, mediocre at openers. Edit the hook in the script tab before approving.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Thumbnails matter more than titles</strong> - the SEO endpoint writes a title, but you should manually upload a thumbnail for every video until you have a proven auto-generated style.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Disclose AI-generated content</strong> - YouTube requires it for synthetic media that could be mistaken for real. The checkbox is during the upload dialog on youtube.com. Do it on every upload.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Upload cadence beats variety</strong> - 1 video/day for 30 days beats 3 videos/day for 10 days, every time. Schedule accordingly.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Community tab posts</strong> - not in Drevalis yet. Check the roadmap; in the meantime post polls manually the day before a video drops.</li>
            </ul>

            <SubHeading id="tips-safety" title="Safety & Compliance" />
            <ul className="space-y-2 text-sm text-txt-secondary ml-4 mb-4">
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Don't impersonate real people.</strong> Voice cloning of a public figure without consent invites takedowns and lawsuits. Use fictional characters or voice actors with clearance.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Stock music licenses.</strong> If you upload your own tracks to <code className="font-mono text-xs">storage/music/library/</code>, make sure you have commercial-use rights. YouTube's Content ID is aggressive.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Claim fair use carefully.</strong> Commentary on copyrighted material has a legal basis in the US but not universally. Know your audience's jurisdiction.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Age-gating and sensitive topics.</strong> If you produce content that discusses self-harm, eating disorders, or political topics, tag videos appropriately on YouTube. Algorithmic deprioritization of un-tagged sensitive content is worse than outright removal.</li>
              <li className="flex gap-2"><ChevronRight size={13} className="text-accent shrink-0 mt-0.5" /><strong className="text-txt-primary">Acceptable Use Policy.</strong> Read <a href="https://drevalis.com/acceptable-use" className="text-accent underline" target="_blank" rel="noreferrer">drevalis.com/acceptable-use</a>. Violation can revoke your license without refund.</li>
            </ul>
          </section>

          {/* ================================================================
              14. TROUBLESHOOTING
          ================================================================ */}
          <section id="troubleshooting" className="mb-16 scroll-mt-4">
            <SectionHeading id="troubleshooting-heading" icon={AlertTriangle} title="Troubleshooting" />

            <SubHeading id="stuck-generation" title='Generation Stuck or Hung' />
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-sm font-semibold text-txt-primary mb-2">Symptom</p>
              <p className="text-sm text-txt-secondary mb-3">The Activity Monitor shows a job has been running for a very long time with no progress updates, or the progress bar is frozen.</p>
              <p className="text-sm font-semibold text-txt-primary mb-2">Solution</p>
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-txt-secondary ml-2">
                <li>Check the Activity Monitor for the stuck job — click the X button to cancel it.</li>
                <li>If the cancel button is unresponsive, go to Jobs (in Settings) → click <strong className="text-txt-primary">Cleanup Stuck Jobs</strong>. This forcibly marks all hung jobs as failed.</li>
                <li>After cleanup, use <strong className="text-txt-primary">Retry</strong> on the episode — it will skip completed steps and resume from where it failed.</li>
                <li>If ComfyUI is the source of the hang, restart your ComfyUI instance and retry.</li>
              </ol>
            </div>
            <Tip>
              The arq worker has a 2-hour job timeout. If a job doesn't complete within 2 hours, it is automatically marked as failed and can be retried.
            </Tip>

            <SubHeading id="video-playback" title="Video Won't Play in Browser" />
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-sm font-semibold text-txt-primary mb-2">Symptom</p>
              <p className="text-sm text-txt-secondary mb-3">The generated MP4 plays in the app's video player but shows a blank frame or codec error in some external players or browsers.</p>
              <p className="text-sm font-semibold text-txt-primary mb-2">Cause</p>
              <p className="text-sm text-txt-secondary mb-3">Some ComfyUI video generation workflows output video with pixel formats (yuv444p, yuv420p10le, etc.) that are not universally supported. Drevalis Creator Studio normalizes all video to yuv420p (H.264 High profile) during the Assembly step, but this step may be skipped if the episode is in an intermediate state.</p>
              <p className="text-sm font-semibold text-txt-primary mb-2">Solution</p>
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-txt-secondary ml-2">
                <li>Click <strong className="text-txt-primary">Reassemble</strong> on the episode. This re-runs the Assembly step, which forces yuv420p encoding.</li>
                <li>If the issue persists, check the episode's generation job logs for FFmpeg error output.</li>
                <li>Verify FFmpeg is compiled with libx264 support: run <code className="font-mono text-xs text-accent">ffmpeg -codecs | grep h264</code></li>
              </ol>
            </div>

            <SubHeading id="comfyui-connection" title="No ComfyUI Connection" />
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-sm font-semibold text-txt-primary mb-2">Symptom</p>
              <p className="text-sm text-txt-secondary mb-3">Settings → ComfyUI shows "Connection failed" or scene generation fails with a "ComfyUI unreachable" error.</p>
              <p className="text-sm font-semibold text-txt-primary mb-2">Checklist</p>
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-txt-secondary ml-2">
                <li>Verify ComfyUI is running — open the ComfyUI URL directly in your browser.</li>
                <li>Check the URL format — it should include the protocol: <code className="font-mono text-xs text-accent">http://localhost:8188</code> (not just <code className="font-mono text-xs text-accent">localhost:8188</code>).</li>
                <li>If running ComfyUI in Docker, ensure the port is exposed and the URL uses the correct host (e.g. <code className="font-mono text-xs text-accent">http://host.docker.internal:8188</code> when the backend is also in Docker).</li>
                <li>If ComfyUI requires an API key, ensure it's entered in the server settings.</li>
                <li>Check firewall rules — the backend must be able to reach the ComfyUI port.</li>
              </ol>
            </div>

            <SubHeading id="captions-missing" title="Captions Not Showing in Video" />
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-sm font-semibold text-txt-primary mb-2">Symptom</p>
              <p className="text-sm text-txt-secondary mb-3">The generated video plays without any caption overlay, even though a caption style is configured.</p>
              <p className="text-sm font-semibold text-txt-primary mb-2">Common Causes & Fixes</p>
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-txt-secondary ml-2">
                <li><strong className="text-txt-primary">Caption style changed after generation.</strong> After changing the caption style in episode settings, you must click <strong>Reassemble</strong>. The new style is not applied retroactively.</li>
                <li><strong className="text-txt-primary">Captions step failed silently.</strong> Check the generation job for the Captions step. If failed, retry that step specifically.</li>
                <li><strong className="text-txt-primary">faster-whisper not installed.</strong> The captions step requires faster-whisper. Verify it's installed in the backend environment.</li>
                <li><strong className="text-txt-primary">ASS subtitle file missing.</strong> If the <code className="font-mono text-xs">captions/</code> directory for the episode is empty, the captions file was never generated. Re-run the Captions step.</li>
              </ol>
            </div>

            <SubHeading id="music-missing" title="Music Not Generated" />
            <div className="surface p-4 rounded-lg mb-4">
              <p className="text-sm font-semibold text-txt-primary mb-2">Symptom</p>
              <p className="text-sm text-txt-secondary mb-3">The final video has no background music, or the music generation request fails silently.</p>
              <p className="text-sm font-semibold text-txt-primary mb-2">Checklist</p>
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-txt-secondary ml-2">
                <li><strong className="text-txt-primary">Mood not set.</strong> A mood must be selected on the series or episode before music can be generated. Go to the series settings and set a music mood.</li>
                <li><strong className="text-txt-primary">AceStep not installed.</strong> Open ComfyUI in your browser and check if the AceStep custom node is available. If not, install it via ComfyUI Manager.</li>
                <li><strong className="text-txt-primary">AceStep model weights missing.</strong> AceStep requires model weights separate from the custom node. Check the AceStep documentation for required model files.</li>
                <li><strong className="text-txt-primary">Wrong workflow.</strong> Ensure the AceStep workflow is registered in Settings → ComfyUI Workflows and is selected in the music settings.</li>
                <li><strong className="text-txt-primary">Curated library fallback.</strong> If AceStep is unavailable, Drevalis Creator Studio falls back to the curated music library. Ensure the library has tracks for your chosen mood in <code className="font-mono text-xs text-accent">storage/music/library/{'{mood}'}/</code>.</li>
              </ol>
            </div>

            <SubHeading id="ts-uploads" title="YouTube Upload Fails" />
            <ol className="space-y-2 text-sm text-txt-secondary ml-4 mb-4 list-decimal list-inside">
              <li><strong className="text-txt-primary">401 / token expired</strong> - click Reconnect in Settings -&gt; YouTube. Happens every ~6 months as Google rotates refresh tokens.</li>
              <li><strong className="text-txt-primary">quotaExceeded</strong> - YouTube Data API has a daily quota (10 000 units default). One upload costs 1600. Wait 24 hours or request a quota increase in Google Cloud Console.</li>
              <li><strong className="text-txt-primary">no_channel_selected / 400</strong> - assign a channel to the series (Series detail -&gt; YouTube Channel) or, for scheduled posts, to the post itself.</li>
              <li><strong className="text-txt-primary">Retry mid-upload</strong> - uploads retry 3 times automatically with fresh tokens each time. If all 3 fail, the Jobs tab shows the last error.</li>
            </ol>

            <SubHeading id="ts-license" title="License Gate / 402 Errors" />
            <ol className="space-y-2 text-sm text-txt-secondary ml-4 mb-4 list-decimal list-inside">
              <li><strong className="text-txt-primary">On every request right after install</strong> - wait 5 seconds; the license-state bootstrap runs in lifespan and the first request might race it. Fixed as of v0.2.0.</li>
              <li><strong className="text-txt-primary">After a renewal</strong> - the 24h heartbeat may not have fired yet. Settings -&gt; License -&gt; click <strong className="text-txt-primary">Refresh</strong> to force a heartbeat.</li>
              <li><strong className="text-txt-primary">License server 5xx</strong> - transient server outages are tolerated; your install keeps working with the stored JWT for 7 days offline.</li>
              <li><strong className="text-txt-primary">Still locked after renewal</strong> - email <a href="mailto:support@drevalis.com" className="text-accent underline">support@drevalis.com</a> with your license key (last 8 characters is enough).</li>
            </ol>

            <SubHeading id="ts-worker" title="Worker Stuck / Unhealthy" />
            <ol className="space-y-2 text-sm text-txt-secondary ml-4 mb-4 list-decimal list-inside">
              <li>Activity Monitor -&gt; Worker health should show a green dot.</li>
              <li>If red: click <strong className="text-txt-primary">Restart worker</strong>. Orphaned "generating" episodes are reset to "failed" so you can re-queue them.</li>
              <li>If the button doesn't help: <code className="font-mono text-xs">docker compose restart worker</code>.</li>
              <li>Worker OOM on long-form - check <code className="font-mono text-xs">docker compose logs worker</code> for the killed signal. Reduce <code className="font-mono text-xs">MAX_CONCURRENT_GENERATIONS</code> or add RAM.</li>
            </ol>

            <SubHeading id="ts-logs" title="Reading Logs" />
            <p className="text-sm text-txt-secondary mb-3">
              Logs are structured JSON. Useful fields: <code className="font-mono text-xs">event</code> (what), <code className="font-mono text-xs">episode_id</code>, <code className="font-mono text-xs">error</code>, <code className="font-mono text-xs">level</code>.
            </p>
            <CodeBlock>{`# Tail live logs\ndocker compose logs -f app worker\n\n# Last 100 errors from the worker\ndocker compose logs worker 2>&1 | grep '"level": "error"' | tail -100\n\n# Follow one specific episode across both services\ndocker compose logs -f app worker 2>&1 | grep "<episode-uuid>"`}</CodeBlock>
            <InfoBox>
              Tip: the in-app Logs page streams the same JSON into a searchable table. Use it instead of command-line grep when you can - filters by level, episode, and time range make pattern-spotting much faster.
            </InfoBox>

            <InfoBox>
              Check the backend logs for detailed error messages. When running via Docker, use <code className="font-mono text-xs">docker compose logs -f app</code> and <code className="font-mono text-xs">docker compose logs -f worker</code> to follow real-time output from the API and the arq job worker respectively.
            </InfoBox>
          </section>

        </div>
      </div>
    </div>
  );
}

export default Help;
