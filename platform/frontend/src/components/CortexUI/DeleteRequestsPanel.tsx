import { useState } from 'react';
import { Trash2, Check, X, AlertOctagon } from 'lucide-react';
import { DeleteRequestData } from '../../types/dashboard';
import { GlassPanel, EmptyState } from './Primitives';

interface DeleteRequestsPanelProps {
  requests: DeleteRequestData[];
  actions: any;
}

export const DeleteRequestsPanel = ({ requests, actions }: DeleteRequestsPanelProps) => {
  const [confirmApproveAll, setConfirmApproveAll] = useState(false);
  const [confirmDenyAll, setConfirmDenyAll] = useState(false);

  if (!requests || requests.length === 0) {
    return (
      <EmptyState 
        title="No Delete Requests" 
        subtitle="Operational tasks are within normal parameters."
        icon={<Trash2 size={24} className="opacity-20" />}
      />
    );
  }

  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-400">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-red-900/20 border border-red-500/30 rounded shadow-[0_0_15px_rgba(239,68,68,0.2)]">
            <AlertOctagon size={16} className="text-red-500" />
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-[0.2em] text-white uppercase">Gated Deletion Requests</h3>
            <p className="text-[10px] text-gray-500 font-mono mt-1 uppercase tracking-widest">{requests.length} PENDING APPROVAL</p>
          </div>
        </div>

        <div className="flex space-x-2">
          {/* Deny All */}
          <button 
            onClick={() => {
              if (confirmDenyAll) {
                actions?.denyAllDelete();
                setConfirmDenyAll(false);
              } else {
                setConfirmDenyAll(true);
                setTimeout(() => setConfirmDenyAll(false), 3000);
              }
            }}
            className={`px-4 py-1.5 rounded font-mono text-[9px] font-bold tracking-[0.2em] uppercase transition-all flex items-center border ${
              confirmDenyAll 
                ? 'bg-gray-700 text-white border-white animate-pulse' 
                : 'bg-black/40 text-gray-400 border-white/10 hover:border-white/20 hover:text-white'
            }`}
          >
            {confirmDenyAll ? 'CONFIRM DENY ALL?' : 'Deny All'}
          </button>

          {/* Approve All */}
          <button 
            onClick={() => {
              if (confirmApproveAll) {
                actions?.approveAllDelete();
                setConfirmApproveAll(false);
              } else {
                setConfirmApproveAll(true);
                setTimeout(() => setConfirmApproveAll(false), 3000);
              }
            }}
            className={`px-4 py-1.5 rounded font-mono text-[9px] font-bold tracking-[0.2em] uppercase transition-all flex items-center border ${
              confirmApproveAll 
                ? 'bg-red-500 text-white border-white shadow-[0_0_15px_rgba(239,68,68,0.5)]' 
                : 'bg-red-900/30 text-red-500 border-red-500/30 hover:bg-red-500 hover:text-white'
            }`}
          >
            {confirmApproveAll ? 'CONFIRM APPROVE ALL?' : 'Approve All'}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {requests.map((req) => (
          <GlassPanel key={req.id} className="p-4 flex items-center justify-between group hover:bg-white/5 transition-all">
            <div className="flex items-center space-x-6">
              <div className="flex flex-col">
                <span className="text-xs font-bold text-gray-300 group-hover:text-white transition-colors uppercase tracking-wider">{req.title}</span>
                <span className="text-[9px] text-gray-500 font-mono mt-1 uppercase tracking-widest">
                  {req.project_name || 'Global Project'} • {req.id}
                </span>
              </div>
              <div className="h-8 w-px bg-white/5"></div>
              <div className="flex flex-col">
                <span className="text-[10px] text-cyan-400 font-mono font-bold tracking-widest uppercase">{req.delete_requested_by}</span>
                <span className="text-[8px] text-gray-600 uppercase font-mono tracking-widest mt-1">REQUESTED BY</span>
              </div>
              <div className="h-8 w-px bg-white/5"></div>
              <div className="flex flex-col">
                <span className="text-[10px] text-gray-400 font-mono">{formatTime(req.delete_requested_at)}</span>
                <span className="text-[8px] text-gray-600 uppercase font-mono tracking-widest mt-1">TIMESTAMP</span>
              </div>
            </div>

            <div className="flex space-x-2">
              <button 
                onClick={() => actions?.denyDelete(req.id)}
                className="p-2 bg-gray-900/40 border border-white/5 text-gray-500 hover:text-white hover:border-white/20 rounded transition-all flex items-center justify-center group/btn"
                title="Deny Request"
              >
                <X size={14} className="group-hover/btn:scale-110 transition-transform" />
              </button>
              <button 
                onClick={() => actions?.approveDelete(req.id)}
                className="p-2 bg-green-900/20 border border-green-500/30 text-green-500 hover:bg-green-500 hover:text-white rounded shadow-inner transition-all flex items-center justify-center group/btn"
                title="Approve Deletion"
              >
                <Check size={14} className="group-hover/btn:scale-110 transition-transform" />
              </button>
            </div>
          </GlassPanel>
        ))}
      </div>
    </div>
  );
};
