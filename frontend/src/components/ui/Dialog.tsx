import { useEffect, useRef, type ReactNode, useCallback } from 'react';
import { X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}

// ---------------------------------------------------------------------------
// Width map
// ---------------------------------------------------------------------------

const maxWidthClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
} as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className = '',
  maxWidth = 'md',
}: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  // Focus trap: focus the panel when opened
  useEffect(() => {
    if (open && panelRef.current) {
      panelRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-bg-overlay animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={[
          'relative w-full p-6 rounded-xl animate-scale-in',
          'bg-bg-surface/90 backdrop-blur-xl border border-white/[0.08]',
          'shadow-glass',
          maxWidthClasses[maxWidth],
          className,
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-txt-primary">{title}</h2>
            {description && (
              <p className="mt-1 text-sm text-txt-secondary">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded text-txt-tertiary hover:text-txt-primary hover:bg-bg-hover transition-colors duration-fast"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DialogFooter({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`mt-6 flex items-center justify-end gap-2 ${className}`}>
      {children}
    </div>
  );
}

export { Dialog, DialogFooter };
export type { DialogProps };
