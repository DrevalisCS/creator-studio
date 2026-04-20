import { type ReactNode, useEffect, useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DrawerProps {
  /** Whether the drawer is visible */
  open: boolean;
  /** Called when the user dismisses the drawer */
  onClose: () => void;
  /** Drawer title (optional) */
  title?: string;
  children: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component — Bottom sheet for mobile
// ---------------------------------------------------------------------------

function Drawer({ open, onClose, title, children, className = '' }: DrawerProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Trap focus on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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

  if (!open) return null;

  return (
    <>
      {/* Scrim overlay */}
      <div
        className="fixed inset-0 z-[80] bg-bg-overlay animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel — slides up from bottom */}
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Drawer'}
        className={[
          'fixed bottom-0 left-0 right-0 z-[81]',
          'bg-bg-surface border-t border-border',
          'rounded-t-2xl',
          'max-h-[85vh] overflow-y-auto',
          'animate-slide-up',
          'motion-reduce:animate-none',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-border-strong" />
        </div>

        {/* Header */}
        {title && (
          <div className="px-4 pb-3 border-b border-border">
            <h2 className="text-lg font-semibold text-txt-primary">{title}</h2>
          </div>
        )}

        {/* Content */}
        <div className="p-4">{children}</div>
      </div>
    </>
  );
}

export { Drawer };
export type { DrawerProps };
