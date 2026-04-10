import React, { useState } from 'react';
import { GlassPanel } from './Primitives';
import { Sparklines, SparklinesLine, SparklinesSpots } from 'react-sparklines';
import { AgentData, SidecarData, ProjectData } from '../../types/dashboard';

export const StatCard = ({ label, value, unit, color, subtitle, accentColor = 'cyan' }: any) => {
  const glowMaps: any = {
    cyan: 'shadow-[0_0_15px_rgba(34,211,238,0.05)] bg-cyan-500/10 group-hover:bg-cyan-500/20',
    green: 'shadow-[0_0_15px_rgba(34,197,94,0.05)] bg-green-500/10 group-hover:bg-green-500/20',
    white: 'shadow-[0_0_15px_rgba(255,255,255,0.05)] bg-gray-500/10 group-hover:bg-gray-500/20',
    amber: 'shadow-[0_0_15px_rgba(251,191,36,0.05)] bg-amber-500/10 group-hover:bg-amber-500/20',
    red: 'shadow-[0_0_15px_rgba(239,68,68,0.05)] bg-red-500/10 group-hover:bg-red-500/20',
  };
  const glowStr = glowMaps[accentColor] || glowMaps.cyan;

  const val = typeof value === 'number' ? Math.round(value * 10) / 10 : value;
  return (
  <GlassPanel className="p-3 flex flex-col justify-center h-20 relative overflow-hidden group">
    <div className={`absolute -right-10 -top-10 w-32 h-32 rounded-full blur-2xl transition-all ${glowStr.split(' ').filter((s:any) => s.startsWith('bg-')).join(' ')}`}></div>
    <div className={`text-xs font-mono text-gray-500 tracking-widest uppercase mb-1 z-10 font-bold`}>{label}</div>
    <div className="flex items-baseline space-x-1 z-10 drop-shadow-md">
      <span className={`text-2xl font-mono ${color}`}>{val}</span>
      {unit && <span className={`text-[10px] text-gray-600 font-mono uppercase`}>{unit}</span>}
    </div>
    {subtitle && <div className="absolute top-3 right-3 text-[7px] text-gray-600 uppercase font-mono tracking-widest z-10">{subtitle}</div>}
  </GlassPanel>
)};

export const AgentDetailCard = ({ name, model, platform, provider, status, requestCount, latency, cost, accentColor = 'purple', onClick, isSelected, hasSelection }: any) => {
  const cMap: any = {
    purple: 'border-t-purple-500 text-purple-400 bg-purple-500 bg-purple-900/20',
    cyan: 'border-t-cyan-500 text-cyan-400 bg-cyan-500 bg-cyan-900/20',
    amber: 'border-t-amber-500 text-amber-500 bg-amber-500 bg-amber-900/20',
    green: 'border-t-green-500 text-green-400 bg-green-500 bg-green-900/20',
    red: 'border-t-red-500 text-red-500 bg-red-500 bg-red-900/20',
  };
  const colorData = cMap[accentColor] || cMap.purple;
  const tColor = colorData.split(' ')[1];
  const bColor = colorData.split(' ')[0];
  const glowColor = colorData.split(' ')[3];

  const cValue = cost ? Math.min(100, Math.round(cost * 3)) : 0; 
  const isDim = hasSelection && !isSelected;
  const activeStyles = isSelected ? `shadow-[0_0_15px_${glowColor.replace('bg-', '').split('/')[0]}] border-t-[3px] scale-[1.02] bg-gray-900/60 z-20` : 'group shadow-[0_0_10px_rgba(0,0,0,0.5)] border-t-2';

  return (
  <GlassPanel 
    onClick={onClick}
    className={`p-4 flex flex-col justify-between ${bColor} relative overflow-hidden transition-all duration-300 ${onClick ? 'cursor-pointer' : ''} ${isDim ? 'opacity-40 grayscale-[60%] border-transparent shadow-none' : activeStyles}`}
  >
    {!isDim && <div className={`absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl -z-0 transition-colors pointer-events-none ${glowColor}`}></div>}
    <div className="flex justify-between items-start mb-2 z-10">
      <div>
        <div className="flex items-center space-x-2">
          <h3 className={`text-lg font-bold ${tColor} tracking-widest uppercase drop-shadow-[0_0_10px_currentcolor]`}>{name}</h3>
          <div className="w-1.5 h-1.5 rounded-full bg-white/40 drop-shadow-md"></div>
        </div>
        <p className="text-sm text-gray-400 font-mono mt-1 uppercase tracking-widest leading-relaxed">{model} • <span className="text-gray-300">{platform} • {provider}</span></p>
      </div>
      <div className="text-right flex space-x-2 items-center">
         <div className="flex flex-col items-end drop-shadow-sm">
          <span className="text-sm font-mono text-white leading-none font-bold">{(Math.round(cValue * 10) / 10).toFixed(1)}%</span>
          <span className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">BUDGET</span>
         </div>
         <div className={`w-6 h-6 border-[3px] border-gray-800 rounded-full relative shadow-inner flex items-center justify-center`}>
           <div className={`absolute top-0 right-0 w-3 h-3 border-t-[3px] border-r-[3px] ${tColor.replace('text-', 'border-')} rounded-tr-full drop-shadow-[0_0_5px_currentcolor]`}></div>
         </div>
      </div>
    </div>
    
    <div className="grid grid-cols-2 gap-4 mt-3 z-10 bg-black/20 p-2 rounded border border-white/5 backdrop-blur-sm">
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-widest drop-shadow-sm">Throughput</div>
        <div className="text-lg font-mono text-white drop-shadow-md font-medium tracking-wide">{(Math.round((requestCount || 0) * 10) / 10).toFixed(1)}</div>
      </div>
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-widest drop-shadow-sm">Latency</div>
        <div className="text-lg font-mono text-white drop-shadow-md font-medium tracking-wide">{(Math.round((latency || 0) * 10) / 10).toFixed(1)} <span className="text-[10px] opacity-50">ms</span></div>
      </div>
    </div>

    <div className="h-8 w-full mt-3 mb-2 opacity-80 z-10">
      {isDim ? (
        <div className="w-full h-full border-b border-gray-700/50"></div>
      ) : (
        <Sparklines data={[5, 10, 5, 20, 15, 30, 25, 40, 35, 45, 40]} limit={20} margin={2} height={30} width={100}>
          <SparklinesLine color={tColor.replace('text-', '')} style={{ fill: "none", strokeWidth: 2 }} />
        </Sparklines>
      )}
    </div>

    <div className="flex space-x-1 mt-2 z-10 opacity-80">
      <div className={`flex-1 h-1.5 ${isDim ? 'bg-gray-800' : 'bg-purple-900/50'} rounded-l-full shadow-inner`}></div>
      <div className={`w-8 h-1.5 ${isDim ? 'bg-gray-800' : 'bg-cyan-900/50 shadow-[0_0_8px_#06b6d4]'} rounded shadow-inner`}></div>
      <div className={`w-4 h-1.5 ${isDim ? 'bg-gray-800' : 'bg-green-500/50 shadow-[0_0_8px_#22c55e]'} rounded-r-full shadow-inner`}></div>
    </div>
  </GlassPanel>
  );
};

export const SidecarRowCard = ({ name, role, status, serviceName, processedCount, throughput, avgProcessTime }: SidecarData) => (
  <GlassPanel className="p-3 flex flex-col hover:bg-white/5 transition-colors shadow-sm group">
    <div className="flex items-center space-x-2 mb-2 pb-2 border-b border-white/5">
      <div className={`w-1.5 h-1.5 rounded-full ${status === 'ONLINE' ? 'bg-green-500 shadow-[0_0_5px_#22c55e]' : 'bg-amber-500 drop-shadow-[0_0_5px_#f59e0b]'}`}></div>
      <div>
        <h4 className="text-gray-300 font-medium text-[10px] tracking-wider uppercase drop-shadow-md group-hover:text-cyan-400 transition-colors">{name}</h4>
        <p className="text-[7px] text-gray-500 font-mono uppercase tracking-widest">{role}</p>
      </div>
    </div>
    <div className="flex justify-between items-end mt-1 px-1">
      <div className="text-[10px] font-mono text-gray-300 drop-shadow-sm font-bold">{processedCount === 0 ? '0.0' : (Math.round(processedCount * 10) / 10).toFixed(1)}</div>
      <div className="text-[10px] font-mono text-cyan-400 drop-shadow-md font-bold">{throughput === 0 ? '0.0' : (Math.round(throughput * 10) / 10).toFixed(1)}</div>
      <div className="text-[10px] font-mono text-cyan-400 drop-shadow-md font-bold">{avgProcessTime === 0 ? '0.0' : (Math.round(avgProcessTime * 10) / 10).toFixed(1)}</div>
    </div>
  </GlassPanel>
);

export const BudgetVelocityCard = ({ totalCost, limit }: { totalCost: number, limit: number }) => {
  const percent = Math.min(100, Math.max(0, (totalCost / limit) * 100));
  return (
    <GlassPanel className="flex flex-row items-center p-3 h-14 relative overflow-hidden group border border-white/5 shadow-lg w-full">
       <div className="absolute -left-16 -top-16 w-32 h-32 bg-green-900/10 rounded-full blur-3xl pointer-events-none transition-all duration-700 ease-in-out group-hover:bg-cyan-900/20"></div>
       
       <div className="flex items-center space-x-6 min-w-max z-10 w-full">
         <div className="flex flex-col border-r border-white/10 pr-6">
           <h3 className="text-[9px] font-mono tracking-widest text-gray-500 uppercase drop-shadow-md pb-0.5">BUDGET VELOCITY</h3>
           <div className="flex items-baseline space-x-2">
             <div className="text-xl font-mono text-white tracking-tight drop-shadow-md font-medium leading-none">${totalCost.toFixed(2)}</div>
             <div className="text-[9px] text-gray-600 font-mono tracking-widest uppercase mb-0.5">/ ${limit}</div>
           </div>
         </div>

         <div className="flex-1 px-4">
           <div className="w-full h-1.5 bg-black/60 rounded-full overflow-hidden border border-white/5 shadow-inner">
              <div className="h-full bg-gradient-to-r from-purple-500 via-cyan-400 to-green-400 shadow-[0_0_10px_#4ade80]" style={{ width: `${percent}%` }}></div>
           </div>
         </div>

         <div className="text-[8px] text-gray-400 font-mono tracking-wider leading-relaxed flex items-center space-x-2 pl-4 border-l border-white/10">
           <div className="w-1.5 h-1.5 rounded-full bg-amber-500/50 shadow-[0_0_5px_#f59e0b]"></div>
           <div className="drop-shadow-sm whitespace-nowrap"><span className="text-gray-300 uppercase font-medium tracking-widest">Projected Overage: </span> 144 hours.</div>
         </div>
       </div>
    </GlassPanel>
  );
};

export const ProjectCard = ({ project, onClick, onDelete }: { project: ProjectData, onClick: () => void, onDelete?: (id: string) => void }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <GlassPanel 
       onClick={onClick} 
       className="p-6 group cursor-pointer hover:border-cyan-500/40 transition-all shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)] relative"
    >
      <button 
         onClick={(e) => { 
            e.stopPropagation(); 
            if (confirmDelete) {
               onDelete && onDelete(project.id);
               setConfirmDelete(false);
            } else {
               setConfirmDelete(true);
               setTimeout(() => setConfirmDelete(false), 3000);
            }
         }}
         className={`absolute top-4 right-4 z-30 h-6 px-2 rounded-full border transition-all shadow-md font-bold text-[8px] uppercase tracking-widest flex items-center justify-center ${confirmDelete ? 'bg-red-500 border-white text-white w-20' : 'bg-red-900/50 border-red-500/50 text-red-500 opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white w-6'}`}
      >
         {confirmDelete ? 'CONFIRM?' : <>&times;</>}
      </button>
      
      <div className="flex justify-between items-start mb-4 relative z-20 pr-8">
        <div>
          <h3 className="text-2xl font-bold text-gray-200 tracking-wide drop-shadow-sm">{project.name}</h3>
          <p className="text-gray-500 text-[10px] uppercase font-mono tracking-widest mt-2">{project.status.replace('_', ' ')}</p>
        </div>
        <div className={`px-3 py-1 rounded text-[10px] tracking-widest font-mono shadow-inner uppercase border ${project.progress === 100 ? 'bg-green-900/30 text-green-400 border-green-500/30' : 'bg-cyan-900/30 text-cyan-400 border-cyan-500/30'}`}>
          {project.progress === 100 ? 'FINISHED' : 'ACTIVE'}
        </div>
      </div>
      
      <div className="grid grid-cols-3 gap-4 border-t border-white/5 pt-5 mb-5 relative z-20">
        <div>
          <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-1 font-mono">Cost</div>
          <div className="text-xl font-mono text-amber-400 drop-shadow-[0_0_5px_#fbbf24]">${(Math.round((project.totalCost || 0) * 10) / 10).toFixed(1)}</div>
        </div>
        <div>
          <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-1 font-mono">Progress</div>
          <div className="text-xl font-mono text-gray-300 drop-shadow-sm">{(Math.round(project.progress * 10) / 10).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-1 font-mono">Tasks</div>
          <div className="text-xl font-mono text-gray-300 drop-shadow-sm">{project.completedCount || 0} / {project.taskCount || 0}</div>
        </div>
      </div>

      <div className="w-full bg-black/50 h-1.5 rounded-full overflow-hidden border border-white/10 relative z-20">
        <div 
          className={`h-full ${project.progress === 100 ? 'bg-green-500 drop-shadow-[0_0_5px_#22c55e]' : 'bg-cyan-500 drop-shadow-[0_0_5px_#06b6d4]'} transition-all`} 
          style={{ width: `${project.progress}%` }}
        ></div>
      </div>
    </GlassPanel>
  );
};
