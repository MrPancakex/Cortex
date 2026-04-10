import React from 'react';

export const C = {
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
