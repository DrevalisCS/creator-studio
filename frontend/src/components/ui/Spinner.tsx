// ---------------------------------------------------------------------------
// Loading Spinner
// ---------------------------------------------------------------------------

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8',
} as const;

function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  return (
    <svg
      className={`animate-spin ${sizeClasses[size]} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-[0.08]"
      />
      <path
        d="M12 2a10 10 0 019.95 9"
        stroke="url(#spinner-gradient)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient id="spinner-gradient" x1="12" y1="2" x2="22" y2="12">
          <stop stopColor="#00D4AA" />
          <stop offset="1" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function FullPageSpinner() {
  return (
    <div className="flex items-center justify-center h-full min-h-[200px]">
      <Spinner size="lg" className="text-accent" />
    </div>
  );
}

export { Spinner, FullPageSpinner };
export type { SpinnerProps };
