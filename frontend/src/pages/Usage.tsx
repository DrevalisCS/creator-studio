import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, Activity } from 'lucide-react';

interface UsageDaily {
  day: string;
  episodes: number;
  pipeline_runs: number;
  pipeline_seconds: number;
  failures: number;
}

interface UsagePayload {
  window_days: number;
  start_date: string;
  end_date: string;
  totals: {
    episodes_generated: number;
    pipeline_runs: number;
    pipeline_seconds: number;
    failures: number;
    failure_rate: number;
    per_step_seconds: Record<string, number>;
    tokens_prompt: number;
    tokens_completion: number;
    tokens_total: number;
  };
  daily: UsageDaily[];
  instrumentation_notes: string[];
}

const STEP_LABEL: Record<string, string> = {
  script: 'Script',
  voice: 'Voice',
  scenes: 'Scenes',
  captions: 'Captions',
  assembly: 'Assembly',
  thumbnail: 'Thumbnail',
};

function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

function fmtNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export default function UsagePage() {
  const [days, setDays] = useState<30 | 90>(30);
  const [data, setData] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/v1/metrics/usage?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((payload: UsagePayload) => {
        if (!cancelled) setData(payload);
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message || 'Failed to load usage');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const maxSeconds = data ? Math.max(1, ...data.daily.map((d) => d.pipeline_seconds)) : 1;
  const maxStepSeconds = data
    ? Math.max(1, ...Object.values(data.totals.per_step_seconds))
    : 1;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Usage &amp; compute</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            Pipeline runtime + episode counts derived from the generation-jobs table. Token
            counts and GPU minutes aren't instrumented yet — see notes below.
          </p>
        </div>
        <div className="flex gap-1">
          {([30, 90] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-2.5 py-1 rounded border ${
                days === d
                  ? 'border-accent/40 text-accent bg-accent/10'
                  : 'border-border text-txt-secondary hover:text-txt-primary'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-txt-muted">
          <RefreshCw size={14} className="animate-spin" /> Loading usage…
        </div>
      )}
      {err && (
        <div className="rounded-md border border-error/30 bg-error/5 p-3 text-sm text-error flex items-center gap-2">
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      {data && !loading && (
        <>
          <p className="text-xs text-txt-tertiary">
            {data.start_date} → {data.end_date}
          </p>

          {/* Totals */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <KPI label="Episodes generated" value={fmtNumber(data.totals.episodes_generated)} />
            <KPI label="Pipeline runs" value={fmtNumber(data.totals.pipeline_runs)} />
            <KPI label="Compute time" value={fmtSeconds(data.totals.pipeline_seconds)} />
            <KPI
              label="LLM tokens"
              value={fmtNumber(data.totals.tokens_total)}
              sub={`${fmtNumber(data.totals.tokens_prompt)} in · ${fmtNumber(data.totals.tokens_completion)} out`}
            />
            <KPI
              label="Failure rate"
              value={`${(data.totals.failure_rate * 100).toFixed(1)}%`}
              sub={`${data.totals.failures} failed / ${data.totals.pipeline_runs} runs`}
            />
          </div>

          {/* Daily bar chart */}
          <section className="rounded-lg border border-border bg-bg-elevated p-4">
            <h2 className="text-sm font-semibold text-txt-primary mb-3 flex items-center gap-2">
              <Activity size={14} /> Daily compute time
            </h2>
            {data.daily.length === 0 ? (
              <p className="text-sm text-txt-muted">No pipeline activity in this window.</p>
            ) : (
              <div className="flex items-end gap-1 h-40">
                {data.daily.map((d) => (
                  <div
                    key={d.day}
                    className="flex-1 flex flex-col items-center justify-end gap-1 group relative"
                  >
                    <div
                      className="w-full rounded-t bg-accent/30 hover:bg-accent/50 transition-colors"
                      style={{
                        height: `${Math.max(3, (d.pipeline_seconds / maxSeconds) * 100)}%`,
                      }}
                      title={`${d.day}: ${fmtSeconds(d.pipeline_seconds)} · ${d.episodes} episodes`}
                    />
                    <div className="absolute bottom-full mb-1 hidden group-hover:block bg-bg-base border border-border rounded px-2 py-1 text-[10px] whitespace-nowrap z-10">
                      <div className="text-txt-primary font-semibold">{d.day}</div>
                      <div className="text-txt-secondary">
                        {fmtSeconds(d.pipeline_seconds)} · {d.episodes} ep.
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-between text-[10px] text-txt-tertiary mt-1">
              <span>{data.daily[0]?.day ?? ''}</span>
              <span>{data.daily[data.daily.length - 1]?.day ?? ''}</span>
            </div>
          </section>

          {/* Per-step breakdown */}
          <section className="rounded-lg border border-border bg-bg-elevated p-4">
            <h2 className="text-sm font-semibold text-txt-primary mb-3">
              Compute time by pipeline step
            </h2>
            <div className="space-y-2">
              {Object.entries(data.totals.per_step_seconds)
                .sort((a, b) => b[1] - a[1])
                .map(([step, seconds]) => (
                  <div key={step} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 text-txt-secondary">
                      {STEP_LABEL[step] ?? step}
                    </span>
                    <div className="flex-1 h-2 bg-bg-base rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-accent to-accent/60"
                        style={{
                          width: `${Math.max(2, (seconds / maxStepSeconds) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="w-16 text-right tabular-nums text-txt-secondary">
                      {fmtSeconds(seconds)}
                    </span>
                  </div>
                ))}
              {Object.keys(data.totals.per_step_seconds).length === 0 && (
                <p className="text-sm text-txt-muted">No steps completed in this window.</p>
              )}
            </div>
          </section>

          {/* Instrumentation notes — honest about what we don't yet measure */}
          <section className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-4">
            <h2 className="text-xs font-semibold text-amber-200 mb-2 uppercase tracking-wider">
              What's not tracked (yet)
            </h2>
            <ul className="space-y-1.5 text-xs text-txt-secondary">
              {data.instrumentation_notes.map((n, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-amber-400 shrink-0">—</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function KPI({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <p className="text-[11px] text-txt-tertiary uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-txt-primary mt-1 font-display">{value}</p>
      {sub && <p className="text-[11px] text-txt-muted mt-1">{sub}</p>}
    </div>
  );
}
