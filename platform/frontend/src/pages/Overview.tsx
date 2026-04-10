import { AgentDetailCard, SidecarRowCard, StatCard, BudgetVelocityCard } from '../components/CortexUI/Cards';
import { ActivityTable, BridgeConnectivityPanel } from '../components/CortexUI/Feeds';
import { GlassPanel } from '../components/CortexUI/Primitives';
import { DashboardData } from '../types/dashboard';

export default function Overview(props: DashboardData) {
  const agentColors = props.agents?.reduce((acc: any, a) => {
     acc[a.name] = a.accentColor || 'purple';
     return acc;
  }, {}) || {};

  return (
    <div className="flex flex-col space-y-6 w-[1500px] animate-in fade-in duration-500 h-full pb-10 mx-auto">
      <div className="flex space-x-6">
        {/* Center Content */}
        <div className="flex-1 flex flex-col space-y-6">
        
        {(props.deleteRequests?.length || 0) > 0 && (
          <div className="w-full bg-red-900/20 border border-red-500/30 rounded-lg p-4 flex items-center justify-between animate-in slide-in-from-top-4 duration-500 shadow-[0_0_20px_rgba(239,68,68,0.1)]">
             <div className="flex items-center space-x-4">
                <div className="p-2 bg-red-500/20 rounded shadow-[0_0_10px_#ef4444]">
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12" y2="17.01"></line></svg>
                </div>
                <div>
                   <h4 className="text-sm font-bold text-red-500 tracking-widest uppercase mb-1">Administrative Action Required</h4>
                   <p className="text-[11px] text-gray-400 font-mono uppercase tracking-widest leading-none">
                     <span className="text-red-400 font-bold">{props.deleteRequests?.length}</span> Task deletion requests are pending operator review.
                   </p>
                </div>
             </div>
             <button 
                onClick={() => props.onNavigate && props.onNavigate('SETTINGS')}
                className="px-6 py-2 bg-red-900/40 border border-red-500/30 text-red-500 hover:bg-red-500 hover:text-white rounded text-[10px] font-mono font-bold uppercase tracking-widest shadow-inner transition-all drop-shadow-[0_0_8px_rgba(239,68,68,0.3)]"
             >
                View Requests
             </button>
          </div>
        )}
        
        <div className="grid grid-cols-5 gap-3">
          <StatCard label="THROUGHPUT" value={`${(Math.round((props.overview?.totalRequests || 0) * 10) / 10).toFixed(1)}`} unit="REQS" subtitle="0 ACTIVE" color="text-cyan-400 drop-shadow-[0_0_10px_#22d3ee]" />
          <StatCard label="DATA VOLUME" value={(Math.round((props.overview?.totalTokens || 0) / 1000 * 10) / 10).toFixed(1)} unit="k TKNS" color="text-purple-400 drop-shadow-[0_0_10px_#c084fc]" accentColor="purple" />
          <StatCard label="NET COST" value={`$${(Math.round((props.overview?.totalCost || 0) * 10) / 10).toFixed(1)}`} color="text-amber-400 drop-shadow-[0_0_10px_#fbbf24]" subtitle="Trend +2.4%" accentColor="amber" />
          <StatCard label="LATENCY" value={(Math.round((props.overview?.avgLatency || 0) * 10) / 10).toFixed(1)} unit="MS" color="text-gray-200" accentColor="white" />
          <StatCard label="ERROR RATE" value={`${(Math.round((props.overview?.errorRate || 0) * 100 * 10) / 10).toFixed(1)}%`} subtitle="LIVE" color={props.overview?.errorRate > 0 ? "text-red-400" : "text-green-400 drop-shadow-[0_0_5px_#4ade80]"} accentColor="green" />
        </div>
        <BudgetVelocityCard totalCost={props.overview?.totalCost || 0} limit={10000} />

        {/* Agents Row */}
        <div>
          <div className="flex justify-between items-end mb-3 border-b border-white/10 pb-2 drop-shadow-sm">
            <span className="text-gray-400 font-mono tracking-widest text-[10px] uppercase font-bold drop-shadow-md">ACTIVE MODEL NODES</span>
            <div className="flex space-x-2 text-[8px] font-mono tracking-widest uppercase">
              <button className="bg-cyan-900/30 px-2 py-0.5 rounded text-cyan-400 border border-cyan-500/30 shadow-[0_0_10px_rgba(34,211,238,0.2)] font-bold">PRODUCTION</button>
              <button className="bg-gray-900/30 px-2 py-0.5 rounded text-gray-500 border border-white/5 hover:text-gray-300 transition-colors">WARN</button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {(!props.agents || props.agents.length === 0) ? (
              <GlassPanel className="col-span-4 border-dashed p-6 text-center shadow-inner">
                <h3 className="text-gray-400 font-mono tracking-widest text-xs uppercase drop-shadow-md">No Agents Registered</h3>
              </GlassPanel>
            ) : (
              props.agents.slice(0, 4).map((agent, i) => {
                const colors = ['purple', 'cyan', 'amber', 'green'];
                return <AgentDetailCard key={agent.name} accentColor={colors[i%colors.length]} {...agent} />;
              })
            )}
          </div>
        </div>

        {/* Lower Section: Waterfall & Bridge */}
        <div className="grid grid-cols-2 gap-4 flex-1">
           <GlassPanel className="flex flex-col p-0 overflow-hidden h-[400px]">
              <div className="p-3 border-b border-white/10 flex justify-between items-center bg-black/20">
                 <div className="flex items-center space-x-2">
                    <div className="p-1 px-1.5 border border-white/10 bg-white/5 rounded text-gray-300 shadow-inner"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg></div>
                    <h3 className="text-[10px] font-mono tracking-widest text-gray-300 uppercase font-bold drop-shadow-sm">GATEWAY WATERFALL</h3>
                 </div>
                 <div className="text-[8px] text-gray-500 font-mono tracking-widest uppercase bg-black/40 px-2 py-0.5 rounded border border-white/5 border-dashed">REAL-TIME STAGE | 10:11</div>
              </div>
              <div className="flex-1 overflow-y-auto p-1 scrollbar-thin">
                 <ActivityTable rows={props.activities || []} compact={true} />
              </div>
           </GlassPanel>

           <GlassPanel 
               className="flex flex-col p-0 overflow-hidden h-[400px] cursor-pointer group hover:border-purple-500/50 transition-colors"
               onClick={() => props.onNavigate && props.onNavigate('AGENTS')}
           >
              <div className="p-3 border-b border-white/10 bg-black/20 flex justify-between items-center group-hover:bg-purple-900/20 transition-colors">
                 <div className="flex items-center space-x-2">
                    <div className="p-1 px-1.5 border border-purple-500/30 bg-purple-900/20 text-purple-400 rounded drop-shadow-[0_0_10px_#a855f7] shadow-inner"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path><path d="M2 12h20"></path></svg></div>
                    <h3 className="text-[10px] font-mono tracking-widest text-gray-300 uppercase font-bold drop-shadow-sm group-hover:text-purple-300 transition-colors">BRIDGE CONNECTIVITY</h3>
                    <div className="ml-2 w-4 h-4 bg-purple-500 text-white rounded-full flex items-center justify-center text-[9px] font-bold shadow-[0_0_8px_#c084fc] animate-bounce">{(props.bridgeMessages?.length || 0)}</div>
                 </div>
                 <div className="flex items-center space-x-1.5 bg-green-900/20 border border-green-500/20 px-2 py-0.5 rounded shadow-[0_0_5px_rgba(34,197,94,0.15)] group-hover:border-green-500/50 transition-colors">
                    <div className="w-1.5 h-1.5 bg-green-400 shadow-[0_0_8px_#4ade80] rounded-full animate-pulse"></div>
                    <div className="text-[8px] text-green-400 font-mono tracking-widest uppercase font-bold">BRIDGE ACTIVE</div>
                 </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 scrollbar-thin relative">
                 <div className="absolute inset-0 bg-gradient-to-t from-purple-900/10 to-transparent blur-3xl pointer-events-none group-hover:from-purple-900/20 transition-all z-0"></div>
                 <div className="relative z-10 h-full"><BridgeConnectivityPanel messages={props.bridgeMessages || []} agentColors={agentColors} hideTitle={true} compact={true} onNavigate={props.onNavigate} /></div>
              </div>
           </GlassPanel>
      </div>
      </div>
      </div>

      {/* Bottom Horizontal Sidecars */}
      <GlassPanel className="flex flex-col p-4 shadow-lg w-fit min-w-[50%] mb-8 mx-auto self-start">
         <h3 className="text-[10px] font-mono tracking-widest text-gray-400 mb-3 pb-2 border-b border-white/10 uppercase font-bold drop-shadow-sm">SIDECAR REGISTRY</h3>
         <div className="grid grid-cols-4 gap-4">
            {(!props.sidecars || props.sidecars.length === 0) ? (
               <div className="text-[10px] text-gray-500 font-mono py-4 text-center border border-dashed border-white/10 rounded col-span-full">No sidecars detected</div>
            ) : props.sidecars.map(s => <SidecarRowCard key={s.name} {...s} />)}
         </div>
      </GlassPanel>
    </div>
  );
}
