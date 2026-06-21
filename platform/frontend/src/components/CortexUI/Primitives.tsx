import React, { useState, useEffect, useRef, useId } from 'react';
import { ChevronDown, X } from 'lucide-react';

export const C = {
// ... existing C object ...
  bg: 'bg-black/80 backdrop-blur-xl',
  border: 'border border-cyan-900/30',
  text: 'text-gray-300',
  accent: 'text-cyan-400',
  accentHover: 'hover:text-cyan-300',
  heading: 'text-xs tracking-[0.2em] font-bold uppercase text-gray-400',
  mono: 'font-mono text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.3)]',
  success: 'text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.3)]',
  error: 'text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.3)]',
  warning: 'text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.3)]',
  agent: 'text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.3)]'
};

export const STATUS_COLORS: Record<string, string> = {
  pending: 'text-gray-400',
  claimed: 'text-purple-400',
  in_progress: 'text-cyan-400',
  submitted: 'text-amber-400',
  review: 'text-blue-400',
  approved: 'text-green-400',
  rejected: 'text-red-400',
  failed: 'text-red-500',
  cancelled: 'text-gray-500'
};

export const GlassPanel = ({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div 
    className={`bg-gray-900/40 backdrop-blur-md rounded-lg border border-white/10 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)] transition-all hover:bg-gray-900/60 hover:border-white/20 ${className}`}
    {...props}
  >
    {children}
  </div>
);

export const SectionDivider = ({ label }: { label: string }) => (
  <div className="flex items-center space-x-4 my-6">
    <div className="h-px bg-gradient-to-r from-transparent to-cyan-900/50 flex-1"></div>
    <span className={C.heading}>{label}</span>
    <div className="h-px bg-gradient-to-l from-transparent to-cyan-900/50 flex-1"></div>
  </div>
);

export const StatusBadge = ({ status }: { status: string }) => (
  <span className={`text-[10px] uppercase tracking-wider font-mono border px-2 py-0.5 rounded-sm ${STATUS_COLORS[status] || 'text-gray-400'} border-current/30 bg-current/10`}>
    {status}
  </span>
);

export const EmptyState = ({ title, subtitle, icon }: { title: string, subtitle?: string, icon?: React.ReactNode }) => (
  <div className="flex flex-col items-center justify-center p-12 text-center border border-dashed border-gray-800 rounded-lg">
    {icon && <div className="text-gray-600 mb-4">{icon}</div>}
    <h3 className="text-gray-400 font-medium tracking-wide">{title}</h3>
    {subtitle && <p className="text-gray-600 text-sm mt-2">{subtitle}</p>}
  </div>
);

export const CustomSelect = ({ value, onChange, options, placeholder, accentColor = 'cyan', className = '', onOpenChange }: any) => {
  const [isOpen, setIsOpen] = useState(false);

  const toggleOpen = () => {
    const next = !isOpen;
    setIsOpen(next);
    onOpenChange?.(next);
  };

  const close = () => {
    if (isOpen) {
      setIsOpen(false);
      onOpenChange?.(false);
    }
  };

  const selectedOption = options.find((o: any) => o.value === value);
  
  const accentHex = accentColor === 'purple' ? 'border-purple-500/40 text-purple-400 bg-purple-900/20 shadow-[0_0_10px_rgba(168,85,247,0.2)]' : 'border-cyan-500/40 text-cyan-400 bg-cyan-900/20 shadow-[0_0_10px_rgba(34,211,238,0.2)]';
  const accentText = accentColor === 'purple' ? 'text-purple-400' : 'text-cyan-400';
  const accentActive = accentColor === 'purple' ? 'bg-purple-900/30 text-purple-200' : 'bg-cyan-900/30 text-cyan-200';

  return (
    <div className={`relative ${className}`}>
      <button 
        type="button"
        onClick={toggleOpen}
        className={`w-full bg-black/40 backdrop-blur-md border border-white/5 rounded px-3 py-1.5 text-[10px] font-mono tracking-widest uppercase text-white flex justify-between items-center outline-none transition-all duration-300 ${isOpen ? (accentHex + ' border-opacity-60') : 'hover:border-white/20 hover:bg-black/60'}`}
      >
        <span className={selectedOption ? 'text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]' : 'text-gray-600'}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown size={12} className={`shrink-0 ml-2 text-gray-500 transition-transform duration-300 ${isOpen ? 'rotate-180 ' + accentText : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={close}></div>
          <div className="absolute top-full left-0 right-0 mt-2 z-50 bg-[#07090c]/80 backdrop-blur-2xl border border-white/10 rounded shadow-[0_20px_60px_rgba(0,0,0,0.9)] max-h-56 overflow-y-auto custom-scrollbar animate-in fade-in zoom-in-95 fill-mode-both slide-in-from-top-2 duration-300 ring-1 ring-white/5">
            <div className="py-1">
              {options.map((option: any) => (
                <button
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    close();
                  }}
                  className={`w-full text-left px-4 py-2 text-[9px] font-mono tracking-[0.2em] uppercase transition-all duration-200 outline-none ${value === option.value ? accentActive : 'text-gray-500 hover:text-gray-200 hover:bg-white/5'}`}
                >
                  <div className="flex items-center justify-between">
                     <span>{option.label}</span>
                     {value === option.value && <div className={`w-1 h-1 rounded-full ${accentText} bg-current shadow-[0_0_5px_currentColor]`}></div>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/** Query selector matching the elements we want inside the focus trap. */
const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Accessible modal dialog.
 *
 * Features (Phase 9 Task 9.9):
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` title id
 * - Escape closes
 * - Backdrop click closes (content click does not)
 * - Minimal focus trap that cycles Tab / Shift-Tab within the dialog
 * - Returns focus to the previously-focused element on close
 */
export const Modal = ({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Capture the element that had focus when the modal opened so we can
  // restore it on close; focus the first actionable element inside.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement) || null;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    const first = focusables && focusables.length > 0 ? focusables[0] : dialogRef.current;
    first?.focus();
    return () => {
      returnFocusRef.current?.focus?.();
    };
  }, [open]);

  // Escape-to-close and Tab focus trap.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
      ).filter(el => !el.hasAttribute('disabled'));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Only close on clicks that originated on the backdrop itself, not
        // clicks that started inside the dialog and released on the backdrop.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className="outline-none"
      >
        <GlassPanel className="w-full max-w-lg p-6 border-white/10 shadow-2xl relative bg-gray-900 border-t-2 border-t-cyan-500">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-cyan-900/10 via-transparent to-transparent pointer-events-none"></div>
          <div className="flex justify-between items-center mb-6 relative z-10 border-b border-white/10 pb-4">
            <h2 id={titleId} className="text-sm tracking-widest text-white uppercase font-light drop-shadow-md">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="text-gray-500 hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
          </div>
          <div className="relative z-10">
            {children}
          </div>
        </GlassPanel>
      </div>
    </div>
  );
};
