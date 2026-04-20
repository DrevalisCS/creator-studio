import { Card } from '@/components/ui/Card';
import {
  Clapperboard,
  Code2,
  FileText,
  Cpu,
  Mic,
  Video,
  Image,
  Subtitles,
  Music,
  Upload,
  Sparkles,
  Layers,
  Palette,
  Zap,
  Globe,
  Shield,
  Terminal,
  Database,
  Box,
  Heart,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const STATS: { label: string; value: string }[] = [
  { label: 'Files',           value: '130+' },
  { label: 'Lines of Code',   value: '40k+' },
  { label: 'AI Integrations', value: '8'    },
  { label: 'Voices',          value: '21'   },
  { label: 'Caption Styles',  value: '5'    },
  { label: 'Music Moods',     value: '12'   },
];

const PIPELINE_STEPS: {
  label: string;
  colorClass: string;
  bgClass: string;
  icon: typeof FileText;
}[] = [
  { label: 'Script',    colorClass: 'text-step-script',    bgClass: 'bg-step-muted-script',    icon: FileText  },
  { label: 'Voice',     colorClass: 'text-step-voice',     bgClass: 'bg-step-muted-voice',     icon: Mic       },
  { label: 'Scenes',    colorClass: 'text-step-scenes',    bgClass: 'bg-step-muted-scenes',    icon: Image     },
  { label: 'Captions',  colorClass: 'text-step-captions',  bgClass: 'bg-step-muted-captions',  icon: Subtitles },
  { label: 'Assembly',  colorClass: 'text-step-assembly',  bgClass: 'bg-step-muted-assembly',  icon: Video     },
  { label: 'Thumbnail', colorClass: 'text-step-thumbnail', bgClass: 'bg-step-muted-thumbnail', icon: Palette   },
];

const FEATURES: {
  icon: typeof Clapperboard;
  title: string;
  description: string;
}[] = [
  {
    icon: Sparkles,
    title: 'AI Script Generation',
    description: 'LLM-powered episodic scripts from a series bible with structured scene breakdowns and narration.',
  },
  {
    icon: Mic,
    title: 'Multi-Voice TTS',
    description: 'Four TTS providers (Piper, Kokoro, Edge, ElevenLabs) with 21+ voices, speed/pitch controls.',
  },
  {
    icon: Image,
    title: 'AI Scene Generation',
    description: 'ComfyUI integration with workflow management, server pools, and concurrent image/video generation.',
  },
  {
    icon: Subtitles,
    title: 'Animated Captions',
    description: 'Word-level captions via faster-whisper with 5 style presets, custom fonts, and burn-in rendering.',
  },
  {
    icon: Video,
    title: 'Video Assembly',
    description: 'FFmpeg compositing with Ken Burns effects, 9:16 portrait format, and automatic thumbnail extraction.',
  },
  {
    icon: Music,
    title: 'Music & Audio',
    description: 'Curated music library with 12 moods, optional AI generation via MusicGen, sidechain ducking.',
  },
  {
    icon: Upload,
    title: 'YouTube Upload',
    description: 'Direct OAuth upload to YouTube with playlist management, privacy controls, and upload tracking.',
  },
  {
    icon: Layers,
    title: 'Content Studio',
    description: 'Full audiobook pipeline: chapter detection, multi-voice casting, background music, multiple formats.',
  },
  {
    icon: Shield,
    title: 'Security First',
    description: 'Fernet encryption with key versioning, SSRF prevention, path-traversal protection, optional API auth.',
  },
  {
    icon: Video,
    title: 'Long-Form Videos',
    description: '15–60 min documentary-style videos with chapter-aware assembly, per-chapter background music, and Wan 2.2 video clips. 16:9 landscape output.',
  },
  {
    icon: Globe,
    title: 'Multi-Channel YouTube',
    description: 'Manage 10+ YouTube channels simultaneously. Assign channels per series, schedule publishing, and track upload history across all accounts.',
  },
  {
    icon: Zap,
    title: 'Load Balancing',
    description: 'Register multiple ComfyUI and LLM servers. Round-robin distribution with per-server concurrency limits.',
  },
  {
    icon: Layers,
    title: 'Pipeline Reliability',
    description: 'Scene-level resumability, TTS response caching, automatic retry with exponential back-off, and a priority queue that runs Shorts before long-form jobs.',
  },
];

const TECH_STACK: { category: string; icon: typeof Terminal; items: string[] }[] = [
  {
    category: 'Backend',
    icon: Terminal,
    items: ['Python 3.12', 'FastAPI', 'SQLAlchemy 2.x', 'Alembic', 'arq', 'Pydantic v2', 'structlog'],
  },
  {
    category: 'Frontend',
    icon: Palette,
    items: ['React 18', 'TypeScript', 'Tailwind CSS', 'Vite', 'React Router', 'Lucide Icons'],
  },
  {
    category: 'AI / ML',
    icon: Cpu,
    items: ['LM Studio', 'Claude API', 'ComfyUI', 'Piper TTS', 'Kokoro TTS', 'faster-whisper', 'AceStep', 'Wan 2.2'],
  },
  {
    category: 'Infrastructure',
    icon: Database,
    items: ['PostgreSQL 16', 'Redis', 'Docker Compose', 'FFmpeg', 'asyncpg', 'httpx'],
  },
  {
    category: 'Cloud Services',
    icon: Globe,
    items: ['ElevenLabs', 'Edge TTS', 'YouTube Data API v3', 'Google OAuth 2.0'],
  },
];

const ARCHITECTURE: { icon: typeof Layers; title: string; description: string }[] = [
  {
    icon: Layers,
    title: 'Layered Design',
    description: 'Strict Router → Service → Repository separation. Protocol-based provider abstractions for TTS and LLM. Clean dependency injection throughout.',
  },
  {
    icon: Zap,
    title: 'Pipeline Engine',
    description: '6-step state machine with automatic retry, cancellation via Redis, real-time WebSocket progress, priority queue (Shorts before long-form), and in-process metrics collection.',
  },
  {
    icon: Box,
    title: 'Local First',
    description: 'All heavy processing runs on your machine. LLM inference, TTS, image generation — no cloud required. Optional fallbacks for Claude, ElevenLabs, Edge TTS.',
  },
  {
    icon: Code2,
    title: 'Developer Experience',
    description: 'Docker Compose for one-command startup, Alembic migrations, ruff + mypy + bandit, pytest with async auto-detection and factory fixtures.',
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function About() {
  return (
    <div className="min-h-screen bg-bg-base pb-20">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="py-16 px-6 text-center" aria-labelledby="about-heading">
        <div className="max-w-2xl mx-auto">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-subtle border border-accent/20 mb-6"
            aria-hidden="true"
          >
            <Clapperboard size={32} className="text-accent" />
          </div>

          <h1
            id="about-heading"
            className="text-4xl font-bold text-txt-primary mb-3 font-display tracking-tight"
          >
            Drevalis Creator Studio
          </h1>

          <p className="text-base text-txt-secondary mb-2">
            AI-Powered Video Creation Studio &amp; Text-to-Voice Platform
          </p>

          <p className="text-sm text-txt-tertiary mb-6">
            Created by <span className="font-semibold text-accent">Drevalis</span>
          </p>

          <p className="text-sm text-txt-secondary leading-relaxed max-w-xl mx-auto">
            Automates the full pipeline from script generation through TTS voicing, scene
            generation, word-level captions, and video assembly — for Shorts and long-form alike.
            Everything runs locally.
          </p>
        </div>
      </section>

      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <section
        className="max-w-4xl mx-auto px-6"
        aria-label="Project statistics"
      >
        <Card padding="none" className="overflow-hidden">
          <dl className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 divide-x divide-border">
            {STATS.map((stat) => (
              <div key={stat.label} className="flex flex-col items-center justify-center p-4 gap-1">
                <dt className="text-xs text-txt-tertiary order-2">{stat.label}</dt>
                <dd className="text-2xl font-bold text-txt-primary tabular-nums order-1">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      {/* ── Pipeline stepper ──────────────────────────────────────────────── */}
      <section
        className="max-w-4xl mx-auto px-6 mt-16"
        aria-labelledby="pipeline-heading"
      >
        <h2
          id="pipeline-heading"
          className="text-xl font-semibold text-txt-primary text-center mb-1"
        >
          Generation Pipeline
        </h2>
        <p className="text-sm text-txt-secondary text-center mb-8">
          Six automated steps from idea to published video
        </p>

        {/* Desktop stepper — two-row layout: circles on top, labels below */}
        <Card padding="lg" className="hidden md:block">
          {/* Circle row with connectors */}
          <div className="flex items-center" role="presentation">
            {PIPELINE_STEPS.map((step, idx) => {
              const Icon = step.icon;
              const isLast = idx === PIPELINE_STEPS.length - 1;

              return (
                <div key={step.label} className="flex items-center flex-1">
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${step.bgClass} border border-border`}
                    aria-hidden="true"
                  >
                    <Icon size={18} className={step.colorClass} />
                  </div>
                  {!isLast && (
                    <div className="flex-1 h-px bg-border" aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Label row — aligned under each circle */}
          <ol
            className="flex mt-2"
            aria-label="Pipeline steps"
          >
            {PIPELINE_STEPS.map((step) => (
              <li key={step.label} className="flex flex-col items-center flex-1">
                <span className={`text-xs font-medium text-center ${step.colorClass}`}>
                  {step.label}
                </span>
              </li>
            ))}
          </ol>
        </Card>

        {/* Mobile stepper — vertical */}
        <Card padding="md" className="md:hidden">
          <ol className="flex flex-col gap-3" aria-label="Pipeline steps">
            {PIPELINE_STEPS.map((step, idx) => {
              const Icon = step.icon;
              const isLast = idx === PIPELINE_STEPS.length - 1;

              return (
                <li key={step.label}>
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${step.bgClass} border border-border`}
                      aria-hidden="true"
                    >
                      <Icon size={16} className={step.colorClass} />
                    </div>
                    <span className={`text-sm font-medium ${step.colorClass}`}>
                      {step.label}
                    </span>
                  </div>
                  {!isLast && (
                    <div className="w-px h-3 bg-border ml-4 mt-1" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      </section>

      {/* ── Features grid ─────────────────────────────────────────────────── */}
      <section
        className="max-w-4xl mx-auto px-6 mt-16"
        aria-labelledby="features-heading"
      >
        <h2
          id="features-heading"
          className="text-xl font-semibold text-txt-primary text-center mb-8"
        >
          Features
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <Card key={feature.title} padding="md">
                <div className="flex items-start gap-3">
                  <div
                    className="flex-shrink-0 p-2 rounded-lg bg-accent-subtle"
                    aria-hidden="true"
                  >
                    <Icon size={16} className="text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-txt-primary mb-1">
                      {feature.title}
                    </h3>
                    <p className="text-xs text-txt-secondary leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ── Tech stack ────────────────────────────────────────────────────── */}
      <section
        className="max-w-4xl mx-auto px-6 mt-16"
        aria-labelledby="tech-stack-heading"
      >
        <h2
          id="tech-stack-heading"
          className="text-xl font-semibold text-txt-primary text-center mb-8"
        >
          Tech Stack
        </h2>
        <Card padding="lg">
          <div className="space-y-6">
            {TECH_STACK.map((group) => {
              const CategoryIcon = group.icon;
              return (
                <div key={group.category}>
                  <div className="flex items-center gap-2 mb-3">
                    <CategoryIcon size={14} className="text-accent" aria-hidden="true" />
                    <span className="text-sm font-semibold text-txt-primary">
                      {group.category}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2" role="list" aria-label={`${group.category} technologies`}>
                    {group.items.map((item) => (
                      <span
                        key={item}
                        role="listitem"
                        className="px-2.5 py-1 text-xs font-medium rounded-full border border-border bg-bg-elevated text-txt-secondary"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </section>

      {/* ── Architecture ──────────────────────────────────────────────────── */}
      <section
        className="max-w-4xl mx-auto px-6 mt-16"
        aria-labelledby="architecture-heading"
      >
        <h2
          id="architecture-heading"
          className="text-xl font-semibold text-txt-primary text-center mb-8"
        >
          Architecture
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ARCHITECTURE.map((card) => {
            const Icon = card.icon;
            return (
              <Card key={card.title} padding="md">
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 rounded-lg bg-accent-subtle" aria-hidden="true">
                    <Icon size={14} className="text-accent" />
                  </div>
                  <span className="text-sm font-semibold text-txt-primary">{card.title}</span>
                </div>
                <p className="text-xs text-txt-secondary leading-relaxed">{card.description}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="mt-20 text-center" role="contentinfo">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-bg-surface">
          <span className="text-xs text-txt-tertiary">Made by</span>
          <span className="text-xs font-semibold text-accent">Drevalis</span>
          <Heart
            size={12}
            aria-label="with love"
            className="text-error fill-error"
          />
          <span className="text-xs text-txt-tertiary">2026</span>
        </div>
      </footer>

    </div>
  );
}
