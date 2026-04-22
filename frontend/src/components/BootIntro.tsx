import { useEffect, useState } from 'react';

/**
 * Three-second retro boot sequence. Renders a CRT-styled terminal
 * that types a few "self-check" lines, fades out, and reveals the
 * app. Session-scoped via sessionStorage so refreshes during the
 * same tab session don't re-run it.
 *
 * Tweak the duration via the ``BOOT_DURATION_MS`` constant — keep
 * it under 4s so it never feels like a loading screen.
 */
const BOOT_DURATION_MS = 2800;
const FADE_MS = 400;
const SESSION_KEY = 'drevalis_boot_seen';

const LINES: Array<{ text: string; at: number }> = [
  { text: 'DREVALIS CREATOR STUDIO   v0.19', at: 0 },
  { text: 'Copyright (c) 2026 Drevalis.  All rights reserved.', at: 120 },
  { text: '', at: 240 },
  { text: 'Self-check: pipeline .............. OK', at: 420 },
  { text: 'Self-check: storage ............... OK', at: 680 },
  { text: 'Self-check: llm pool .............. OK', at: 940 },
  { text: 'Self-check: comfyui nodes ......... OK', at: 1200 },
  { text: 'Self-check: ffmpeg binary ......... OK', at: 1460 },
  { text: 'Self-check: license ............... OK', at: 1720 },
  { text: '', at: 1820 },
  { text: 'Loading studio…', at: 1980 },
];

export function BootIntro({ onDone }: { onDone: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(SESSION_KEY)) {
      onDone();
      return;
    }

    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      setElapsed(now - start);
      if (now - start < BOOT_DURATION_MS) {
        raf = requestAnimationFrame(tick);
      } else {
        setFading(true);
        setTimeout(() => {
          sessionStorage.setItem(SESSION_KEY, '1');
          onDone();
        }, FADE_MS);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onDone]);

  const visible = LINES.filter((l) => l.at <= elapsed);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black transition-opacity"
      style={{
        opacity: fading ? 0 : 1,
        transitionDuration: `${FADE_MS}ms`,
      }}
    >
      <div className="crt-overlay" />
      <div className="w-full max-w-2xl px-6 py-10 font-mono text-[#7cff8a] text-sm leading-relaxed">
        {visible.map((l, i) => (
          <div key={i} className="boot-line">
            {l.text === '' ? '\u00A0' : <>&gt; {l.text}</>}
          </div>
        ))}
        {elapsed > 2100 && elapsed < BOOT_DURATION_MS && (
          <div className="boot-line">
            &gt; <span className="inline-block w-2 h-4 bg-[#7cff8a] align-middle boot-cursor" />
          </div>
        )}
      </div>
      <style>{`
        .crt-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            repeating-linear-gradient(
              0deg,
              rgba(0,0,0,0) 0,
              rgba(0,0,0,0) 2px,
              rgba(0,0,0,0.18) 2px,
              rgba(0,0,0,0.18) 4px
            );
        }
        .boot-line { animation: boot-fade 180ms ease-out both; }
        @keyframes boot-fade {
          from { opacity: 0; transform: translateY(-2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .boot-cursor { animation: boot-blink 700ms steps(2) infinite; }
        @keyframes boot-blink { to { opacity: 0; } }
      `}</style>
    </div>
  );
}
