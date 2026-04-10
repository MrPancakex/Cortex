import { DashboardData } from '../types/dashboard';
import { GlassPanel, SectionDivider } from '../components/CortexUI/Primitives';
import { DeleteRequestsPanel } from '../components/CortexUI/DeleteRequestsPanel';

export default function Settings({ settingsSummary, deleteRequests, actions }: DashboardData) {

  return (
    <div className="space-y-6 max-w-3xl animate-in fade-in duration-500">
      <h2 className="text-xl tracking-widest text-white font-light">SYSTEM CONFIGURATION</h2>

      <GlassPanel className="p-6 space-y-6">
        <div>
          <h3 className="text-sm tracking-widest text-gray-400 uppercase mb-4 font-bold border-b border-white/10 pb-2">Platform Details</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="text-gray-500 uppercase flex items-center">Gateway Status</div>
            <div className={`font-mono font-bold ${settingsSummary?.gatewayStatus === 'ONLINE' ? 'text-green-400' : 'text-red-400'}`}>
              {settingsSummary?.gatewayStatus || 'UNKNOWN'}
            </div>

            <div className="text-gray-500 uppercase flex items-center">Registered Agents</div>
            <div className="text-cyan-400 font-mono">{settingsSummary?.registeredAgents || 0}</div>

            <div className="text-gray-500 uppercase flex items-center">Provider Count</div>
            <div className="text-gray-300 font-mono">{settingsSummary?.providerCount || 0}</div>

            {settingsSummary?.degradedReason && (
              <>
                <div className="text-gray-500 uppercase flex items-center">Degraded Reason</div>
                <div className="text-amber-400 font-mono">{settingsSummary.degradedReason}</div>
              </>
            )}
          </div>
        </div>

        <div className="pt-4 border-t border-white/10">
           <h3 className="text-sm tracking-widest text-gray-400 uppercase mb-4 font-bold pb-2">System Actions</h3>
           <div className="flex items-center justify-between p-4 bg-red-900/10 border border-red-500/20 rounded-lg">
              <h4 className="text-xs font-bold text-red-500 uppercase tracking-widest">Gateway Restart</h4>
              <button
                 onClick={() => { navigator.clipboard.writeText('cortex gateway restart'); }}
                 className="px-6 py-2 rounded font-mono text-[10px] text-red-400 bg-red-900/30 border border-red-500/30 hover:bg-red-500 hover:text-white transition-all cursor-pointer shadow-inner"
              >
                 Restart
              </button>
           </div>
        </div>
      </GlassPanel>

      {(deleteRequests?.length || 0) > 0 && (
        <div className="animate-in slide-in-from-top-4 duration-500">
          <SectionDivider label="Administrative Gating" />
          <DeleteRequestsPanel requests={deleteRequests || []} actions={actions} />
        </div>
      )}
    </div>
  );
}
