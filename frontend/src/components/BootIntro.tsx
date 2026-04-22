import { useEffect, useRef, useState } from 'react';

/**
 * Cyberpunk CRT boot sequence — plays on initial app load and on hard
 * refresh, skipped when the user navigates between pages within the
 * same tab session (we use sessionStorage to remember).
 *
 * ``prefers-reduced-motion: reduce`` skips it entirely.
 * Press Escape / Enter / Space (or click the button) to skip.
 */
const BOOT_DURATION_MS = 3400;
const FADE_MS = 500;
const SESSION_KEY = 'drevalis_boot_seen';

type Tone = 'title' | 'info' | 'ok' | 'warn' | 'accent' | 'dim';

const LINES: Array<{ text: string; at: number; tone: Tone }> = [
  { text: 'DREVALIS // CREATOR STUDIO  v0.19', at: 0, tone: 'title' },
  { text: '//  est. 2026 · Made in Switzerland · Self-hosted AI pipeline', at: 140, tone: 'dim' },
  { text: '', at: 260, tone: 'dim' },
  { text: '[BOOT] Initializing runtime ...............', at: 380, tone: 'info' },
  { text: '[NET ] Local stack · Redis · Postgres ..... OK', at: 620, tone: 'ok' },
  { text: '[GPU ] ComfyUI node pool .................. OK', at: 860, tone: 'ok' },
  { text: '[LLM ] Anthropic · OpenAI · local ......... OK', at: 1100, tone: 'ok' },
  { text: '[TTS ] ElevenLabs · Edge · Piper · Kokoro . OK', at: 1340, tone: 'ok' },
  { text: '[CV  ] FFmpeg · faster-whisper ............ OK', at: 1580, tone: 'ok' },
  { text: '[SEC ] Fernet keystore · OAuth vault ...... OK', at: 1820, tone: 'ok' },
  { text: '[LIC ] License active ..................... OK', at: 2060, tone: 'ok' },
  { text: '', at: 2180, tone: 'dim' },
  { text: '> All systems nominal. Jacking in.', at: 2320, tone: 'accent' },
  { text: '> Loading studio ...', at: 2620, tone: 'info' },
];

function shouldPlay(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  } catch {
    /* ignore */
  }
  let isReload = false;
  try {
    const nav = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (nav[0]?.type === 'reload') isReload = true;
  } catch {
    /* ignore */
  }
  let seen = false;
  try {
    seen = sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    /* ignore */
  }
  return isReload || !seen;
}

export function BootIntro({ onDone }: { onDone: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [fading, setFading] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFading(true);
    try {
      sessionStorage.setItem(SESSION_KEY, '1');
    } catch {
      /* ignore */
    }
    setTimeout(() => onDone(), FADE_MS);
  };

  useEffect(() => {
    if (!shouldPlay()) {
      onDone();
      return;
    }

    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const e = now - start;
      setElapsed(e);
      if (e < BOOT_DURATION_MS) {
        raf = requestAnimationFrame(tick);
      } else {
        finish();
      }
    };
    raf = requestAnimationFrame(tick);

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        finish();
      }
    };
    document.addEventListener('keydown', onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = LINES.filter((l) => l.at <= elapsed);
  const pct = Math.min(100, Math.round((elapsed / BOOT_DURATION_MS) * 100));
  const lastAt = LINES.reduce((acc, l) => Math.max(acc, l.at), 0);
  const showCursor = elapsed >= lastAt + 200;

  return (
    <div
      className="drev-boot fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        background: 'radial-gradient(ellipse at 50% 40%, #0a0612 0%, #000 70%)',
        color: '#e6fbff',
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        opacity: fading ? 0 : 1,
        filter: fading ? 'blur(6px)' : 'none',
        transition: `opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`,
      }}
    >
      <div className="drev-grid" />
      <div className="drev-horizon" />
      <div className="drev-noise" />

      <div className="relative z-[2] w-[92%] max-w-[760px] px-7 pt-9 pb-7 drev-panel">
        <span className="drev-chip">
          <span className="drev-dot" />
          System boot
        </span>
        <div className="drev-title" data-text="DREVALIS // CREATOR STUDIO">
          DREVALIS // CREATOR STUDIO
        </div>
        <div className="drev-sub">
          v0.19 · Neural-assisted content pipeline · secure-by-default
        </div>

        <div className="drev-out" style={{ minHeight: 260 }}>
          {visible.map((l, i) => {
            const okTail = l.tone === 'ok' && / OK$/.test(l.text);
            return (
              <div key={i} className={`drev-line drev-tone-${l.tone}`}>
                {l.text === '' ? (
                  '\u00A0'
                ) : okTail ? (
                  <>
                    {l.text.slice(0, -2)}
                    <span className="drev-ok">OK</span>
                  </>
                ) : (
                  l.text
                )}
              </div>
            );
          })}
          {showCursor && (
            <div className="drev-line drev-tone-info">
              {'> '}
              <span className="drev-cur" />
            </div>
          )}
        </div>

        <div className="drev-bar" style={{ ['--p' as unknown as string]: `${pct}%` } as React.CSSProperties} />
        <div className="drev-meta">
          <span>0x00 — checksum verified</span>
          <span>{pct}%</span>
        </div>
      </div>

      <div className="drev-scan" />
      <div className="drev-vignette" />

      <button type="button" className="drev-skip" onClick={finish} aria-label="Skip intro">
        skip [esc]
      </button>

      <style>{`
        .drev-boot{animation:drev-crt-flicker 4.2s infinite}
        @keyframes drev-crt-flicker{
          0%,97%,100%{filter:brightness(1)}
          7%{filter:brightness(1.08) contrast(1.05)}
          45%{filter:brightness(0.94) contrast(1.03)}
          62%{filter:brightness(1.05)}
          98%{filter:brightness(0.72)}
        }
        .drev-grid{position:absolute;inset:0;pointer-events:none;
          background-image:linear-gradient(rgba(255,43,214,0.08) 1px,transparent 1px),
            linear-gradient(90deg,rgba(0,230,255,0.08) 1px,transparent 1px);
          background-size:44px 44px;
          mask-image:radial-gradient(ellipse at 50% 100%,#000 0%,rgba(0,0,0,0.2) 70%);
          -webkit-mask-image:radial-gradient(ellipse at 50% 100%,#000 0%,rgba(0,0,0,0.2) 70%);
          transform:perspective(700px) rotateX(58deg) translateY(28%);opacity:0.55;}
        .drev-horizon{position:absolute;left:0;right:0;bottom:44%;height:1px;
          background:linear-gradient(90deg,transparent,#ff2bd6,#00e6ff,transparent);
          box-shadow:0 0 18px rgba(255,43,214,0.6),0 0 42px rgba(0,230,255,0.35);}
        .drev-scan{position:absolute;inset:0;pointer-events:none;
          background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,0.22) 2px,rgba(0,0,0,0.22) 3px);}
        .drev-vignette{position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(ellipse at center,rgba(0,0,0,0) 50%,rgba(0,0,0,0.85) 100%);}
        .drev-noise{position:absolute;inset:-10%;pointer-events:none;opacity:0.06;mix-blend-mode:overlay;
          background-image:url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%22120%22><filter id=%22n%22><feTurbulence baseFrequency=%220.9%22 numOctaves=%222%22 stitchTiles=%22stitch%22/></filter><rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22 opacity=%220.7%22/></svg>");}
        .drev-panel{
          border:1px solid rgba(0,230,255,0.25);border-radius:10px;
          background:linear-gradient(180deg,rgba(10,6,18,0.78),rgba(0,0,0,0.82));
          box-shadow:0 0 0 1px rgba(255,43,214,0.18) inset,
            0 0 40px rgba(0,230,255,0.12),0 0 80px rgba(255,43,214,0.10);}
        .drev-chip{display:inline-flex;align-items:center;gap:8px;padding:3px 10px;border-radius:999px;
          border:1px solid rgba(0,230,255,0.35);font-size:10px;letter-spacing:0.14em;text-transform:uppercase;
          color:#00e6ff;background:rgba(0,230,255,0.06);margin-bottom:14px;}
        .drev-dot{width:7px;height:7px;border-radius:50%;background:#7cff8a;
          box-shadow:0 0 8px #7cff8a;animation:drev-pulse 1.2s ease-in-out infinite;}
        @keyframes drev-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.45;transform:scale(0.85)}}
        .drev-title{position:relative;font:700 22px/1.1 "JetBrains Mono",ui-monospace,monospace;
          letter-spacing:0.06em;color:#fff;text-shadow:0 0 12px rgba(255,255,255,0.35);margin-bottom:4px;
          min-height:1.1em;white-space:pre;}
        .drev-title::before,.drev-title::after{
          content:attr(data-text);position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;}
        .drev-title::before{color:#ff2bd6;transform:translate(-2px,0);text-shadow:0 0 10px rgba(255,43,214,0.7);
          animation:drev-shift-a 3s steps(24) infinite;}
        .drev-title::after{color:#00e6ff;transform:translate(2px,0);text-shadow:0 0 10px rgba(0,230,255,0.7);
          animation:drev-shift-b 3s steps(24) infinite;}
        @keyframes drev-shift-a{0%,92%,100%{transform:translate(-2px,0)}94%{transform:translate(-5px,1px)}96%{transform:translate(1px,-1px)}98%{transform:translate(-3px,0)}}
        @keyframes drev-shift-b{0%,92%,100%{transform:translate(2px,0)}94%{transform:translate(5px,-1px)}96%{transform:translate(-1px,1px)}98%{transform:translate(3px,0)}}
        .drev-sub{font-size:11px;color:rgba(230,251,255,0.55);letter-spacing:0.14em;text-transform:uppercase;margin-bottom:18px;}
        .drev-line{animation:drev-in 220ms ease-out both;min-height:1.55em;white-space:pre;font-variant-numeric:tabular-nums;font-size:13.5px;line-height:1.55;}
        @keyframes drev-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
        .drev-tone-title{color:#fff;font-weight:600;}
        .drev-tone-info{color:#00e6ff;text-shadow:0 0 8px rgba(0,230,255,0.45);}
        .drev-tone-ok{color:#7cff8a;text-shadow:0 0 8px rgba(124,255,138,0.35);}
        .drev-tone-warn{color:#ffd166;text-shadow:0 0 8px rgba(255,209,102,0.35);}
        .drev-tone-accent{color:#ff2bd6;text-shadow:0 0 10px rgba(255,43,214,0.6);letter-spacing:0.04em;}
        .drev-tone-dim{color:rgba(230,251,255,0.38);}
        .drev-ok{color:#7cff8a;text-shadow:0 0 8px #7cff8a;}
        .drev-cur{display:inline-block;width:9px;height:1em;background:#00e6ff;vertical-align:-3px;margin-left:4px;
          box-shadow:0 0 8px #00e6ff,0 0 18px rgba(0,230,255,0.6);animation:drev-blink 780ms steps(2) infinite;}
        @keyframes drev-blink{to{opacity:0}}
        .drev-bar{height:4px;margin-top:22px;border-radius:2px;background:rgba(0,230,255,0.12);position:relative;overflow:hidden;}
        .drev-bar::before{content:"";position:absolute;inset:0;width:var(--p,0%);border-radius:2px;
          background:linear-gradient(90deg,#00e6ff,#ff2bd6);box-shadow:0 0 14px rgba(255,43,214,0.55);
          transition:width 120ms linear;}
        .drev-bar::after{content:"";position:absolute;top:0;bottom:0;width:20%;
          background:linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent);
          animation:drev-sweep 1.4s linear infinite;}
        @keyframes drev-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(520%)}}
        .drev-meta{display:flex;justify-content:space-between;font-size:11px;
          color:rgba(230,251,255,0.45);letter-spacing:0.08em;margin-top:8px;}
        .drev-skip{position:fixed;bottom:18px;right:18px;z-index:3;background:transparent;
          border:1px solid rgba(0,230,255,0.3);color:rgba(230,251,255,0.7);
          font:500 11px/1 "JetBrains Mono",monospace;letter-spacing:0.14em;text-transform:uppercase;
          padding:8px 12px;border-radius:6px;cursor:pointer;
          transition:color 120ms,border-color 120ms,background 120ms;}
        .drev-skip:hover{color:#fff;border-color:#ff2bd6;background:rgba(255,43,214,0.08);}
        @media (max-width:520px){.drev-panel{padding:24px 18px !important}.drev-title{font-size:17px !important}}
      `}</style>
    </div>
  );
}
