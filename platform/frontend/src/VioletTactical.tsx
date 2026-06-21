import { useState } from 'react';
import { LayoutDashboard, FolderKanban, Cpu, Settings } from 'lucide-react';
import Overview from './pages/Overview';
import Projects from './pages/Projects';
import Agents from './pages/Agents';
import SettingsPage from './pages/Settings';
import { DashboardData } from './types/dashboard';

export default function VioletTactical(props: DashboardData) {
  const [activeTab, setActiveTab] = useState('OVERVIEW');

  const renderContent = () => {
    switch (activeTab) {
      case 'OVERVIEW': return <Overview {...props} onNavigate={setActiveTab} />;
      case 'PROJECTS': return <Projects {...props} onNavigate={setActiveTab} />;
      case 'AGENTS': return <Agents {...props} onNavigate={setActiveTab} />;
      case 'SETTINGS': return <SettingsPage {...props} onNavigate={setActiveTab} />;
      default: return null;
    }
  };

  const tabs = [
    { id: 'OVERVIEW', icon: LayoutDashboard },
    { id: 'PROJECTS', icon: FolderKanban },
    { id: 'AGENTS', icon: Cpu },
    { id: 'SETTINGS', icon: Settings }
  ];

  return (
    <div className="min-h-screen bg-[#07090c] text-gray-300 font-sans font-light selection:bg-cyan-900/50 relative overflow-hidden flex flex-col items-center">
      {/* Ambient background glow and rich hex pattern */}
      <div className="fixed inset-0 z-0 pointer-events-none">
         <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PHBhdGggZD0iTTIwIDBMMzcuMzIgMTBWMzBMMjAgNDBMMi42OCAzMFYxMEwyMCAweiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Uvd2lkdGg9IjEuNSIvPjwvc3ZnPg==')] bg-[length:36px_36px] bg-center opacity-[0.15]"></div>
         <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-cyan-900/10 via-transparent to-[#07090c]/80 backdrop-blur-[1px]"></div>
      </div>
      
      {/* Header Bar */}
      <div className="w-[1500px] flex-none relative z-20 bg-black/60 backdrop-blur-xl border-b border-white/10 rounded-b-xl shadow-[0_4px_30px_-4px_rgba(0,0,0,0.8)]">
        <div className="px-6 h-14 flex items-center justify-between">
          {/* Left */}
          <div className="flex items-end space-x-3 pb-2 w-64 pt-2">
             <div className="flex items-center space-x-2">
                <div className="w-1.5 h-1.5 bg-cyan-400 shadow-[0_0_8px_#22d3ee] rounded-full animate-pulse"></div>
                <h1 className="text-[14px] font-bold tracking-[0.2em] text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.2)]">CORTEX OPS</h1>
             </div>
             <p className="text-[8px] font-mono text-gray-500 tracking-widest mb-0.5 uppercase">v0.1 / {props.settingsSummary?.gatewayStatus || 'ONLINE'}</p>
          </div>
          
          {/* Center: Tabs */}
          <div className="flex space-x-8 items-center h-full pt-2 flex-1 justify-center">
             {tabs.map((tab) => {
               const Icon = tab.icon;
               const isActive = activeTab === tab.id;
               const hasRequests = tab.id === 'SETTINGS' && (props.deleteRequests?.length || 0) > 0;
               return (
                 <button 
                   key={tab.id} 
                   onClick={() => setActiveTab(tab.id)}
                   className={`h-full flex items-center space-x-2 text-[11px] tracking-[0.15em] transition-colors relative px-2 ${isActive ? 'text-cyan-400 font-medium drop-shadow-[0_0_10px_#22d3ee]' : 'text-gray-500 hover:text-gray-300'}`}
                 >
                   <Icon size={14} className={isActive ? 'text-cyan-400' : 'text-gray-500'} />
                   {hasRequests && (
                     <div className="absolute -top-1.5 -right-3 min-w-[14px] h-3.5 bg-red-500 rounded-full border border-[#07090c] flex items-center justify-center px-1 animate-pulse shadow-[0_0_12px_#ef4444]">
                        <span className="text-[8px] font-mono font-bold text-white leading-none">{props.deleteRequests?.length}</span>
                     </div>
                   )}
                   <span>{tab.id}</span>
                   {isActive && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-cyan-400 shadow-[0_0_8px_#22d3ee]"></div>}
                 </button>
               );
             })}
          </div>
          
          {/* Right */}
          <div className="text-right flex space-x-6 items-center justify-end w-64 pb-1">
             <div>
               <div className="text-[8px] uppercase tracking-widest text-gray-500 font-mono mb-1">TOKEN SPENDING</div>
               <div className="text-sm font-mono text-amber-400 font-bold drop-shadow-[0_0_5px_#fbbf24]">${props.overview?.totalCost?.toFixed(2) || '0.00'}</div>
             </div>
          </div>
        </div>
        <div className="w-full h-[1px] bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent"></div>
      </div>

      {/* Main Content Area */}
      <main className="w-full flex-1 overflow-y-auto relative z-10 p-6 custom-scrollbar flex flex-col items-center">
        {renderContent()}
      </main>
      
      {/* Footer Bar */}
      <footer className="w-full flex-none bg-black/80 backdrop-blur-md border-t border-white/5 h-8 flex items-center justify-between px-8 z-20 text-[9px] font-mono tracking-widest uppercase text-gray-500 shadow-[0_-4px_30px_rgba(0,0,0,0.5)]">
        <div className="flex items-center space-x-2">
           <div className="flex space-x-1">
             <div className="w-1.5 h-1.5 bg-green-500/80 rounded-full animate-pulse shadow-[0_0_5px_#22c55e]"></div>
             <div className="w-1.5 h-1.5 bg-green-500/40 rounded-full"></div>
             <div className="w-1.5 h-1.5 bg-green-500/40 rounded-full"></div>
           </div>
           <span className="text-green-500/70 pb-0.5 font-medium">ALL SYSTEMS NOMINAL</span>
        </div>
        <div className="flex space-x-6 pb-0.5">
           <span className="text-gray-600">Local Proxy: <span className="text-gray-400">127.0.0.1:4840</span></span>
           <span className="text-gray-600">Shell: <span className="text-gray-400">v1.0.4</span></span>
           <span className="text-gray-600">Data Source: <span className="text-cyan-600">{window.location.search.includes('sim=1') ? 'SIMULATION' : 'LIVE API'}</span></span>
        </div>
      </footer>
    </div>
  );
}
