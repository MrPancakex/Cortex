import { useState, useEffect } from 'react';
import { DashboardData, SubAgentData } from '../types/dashboard';
import { isAgentHealthy } from '../hooks/useApi';
import { AgentDetailCard, StatCard } from '../components/CortexUI/Cards';
import { EmptyState, GlassPanel } from '../components/CortexUI/Primitives';
import { BridgeConnectivityPanel, ActivityTable, TaskHistoryTable } from '../components/CortexUI/Feeds';
import { Layers, Activity, Clock, ChevronRight } from 'lucide-react';

const inferRuntimeLane = (subagent: any) => {
  const type = String(subagent?.subagent_type || subagent?.type || '').toLowerCase();
  const provider = String(subagent?.provider || '').toLowerCase();
  const model = String(subagent?.model || '').toLowerCase();

  if (
    type.includes('codex')
    || provider === 'openai'
    || model.startsWith('gpt-')
    || model.startsWith('o1')
    || model.startsWith('o3')
    || model.startsWith('o4')
  ) return 'codex';

  if (
    type === 'general-purpose'
    || type.includes('claude')
    || provider === 'anthropic'
    || model.startsWith('claude')
  ) return 'claude';

  return 'generic';
};

const runtimeBadgeClass = (runtime: string) => {
  if (runtime === 'codex') return 'text-amber-400 bg-amber-900/20 border-amber-500/20';
  if (runtime === 'claude') return 'text-cyan-400 bg-cyan-900/20 border-cyan-500/20';
  return 'text-gray-300 bg-white/5 border-white/10';
};

const runtimeLabel = (runtime: string) => {
  if (runtime === 'codex') return 'CODEX';
  if (runtime === 'claude') return 'CLAUDE';
  return 'GENERIC';
};

const SubAgentPanel = ({ agentName, subAgents, loading }: { agentName: string, subAgents: SubAgentData[], loading: boolean }) => {
  // Sort sub-agents by ID descending (newest first)
  const sortedSubAgents = [...subAgents].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  
  const activeSubAgents = sortedSubAgents.filter(s => s.status === 'active');
  const allClosed = sortedSubAgents.filter(s => s.status !== 'active');
  const recentClosed = allClosed.slice(0, 5); // Only show last 5 for clarity
  
  const totalDuration = allClosed.reduce((acc, s) => acc + (parseFloat(s.duration) || 0), 0);
  const totalToolCalls = allClosed.reduce((acc, s) => acc + (s.toolCalls || 0), 0);
  const laneCounts = sortedSubAgents.reduce((acc, s) => {
    const runtime = s.runtime || 'generic';
    acc[runtime] = (acc[runtime] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="mt-6 animate-in slide-in-from-top-4 duration-300">
      <div className="flex items-center space-x-2 mb-4">
        <Layers size={16} className="text-cyan-400" />
        <h3 className="text-xs font-mono tracking-[.3em] text-cyan-400 uppercase font-bold">Node Sub-Orchestration: {agentName}</h3>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Active Section */}
        <div className="bg-black/40 border border-white/5 rounded-lg overflow-hidden flex flex-col h-[280px]">
          <div className="p-3 bg-white/5 border-b border-white/5 flex justify-between items-center bg-gradient-to-r from-green-500/10 to-transparent">
            <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest flex items-center">
              <Activity size={12} className="mr-2 text-green-400 animate-pulse" /> Active Operations
            </span>
            <span className="text-[9px] text-green-400 font-mono font-bold tracking-widest">{activeSubAgents.length} EXECUTING</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin">
            {loading && activeSubAgents.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[10px] font-mono text-gray-600 animate-pulse uppercase italic">Synchronizing...</div>
            ) : activeSubAgents.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[10px] font-mono text-gray-700 uppercase italic">No active processes</div>
            ) : activeSubAgents.map(s => (
              <div key={s.id} className="flex items-center justify-between p-3 bg-white/5 rounded border border-white/5 hover:border-green-500/30 transition-all group animate-in slide-in-from-left-2 duration-300">
                <div className="flex items-center space-x-4">
                  <div className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${runtimeBadgeClass(s.runtime)}`}>{runtimeLabel(s.runtime)}</div>
                  <div>
                    <div className="text-xs text-gray-300 font-medium group-hover:text-white transition-colors truncate w-64">{s.description}</div>
                    <div className="text-[8px] text-gray-600 font-mono mt-0.5 uppercase tracking-tighter">
                      {s.type && s.type !== s.runtime ? `${s.type} • ` : ''}REF: {s.taskReference || 'NONE'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-4">
                   <div className="text-right">
                      <div className="text-[10px] font-mono text-gray-400">{(Math.round(parseFloat(s.duration) * 10) / 10).toFixed(1)}s</div>
                   </div>
                   <ChevronRight size={14} className="text-gray-700 group-hover:text-green-500 transition-colors" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Closed Section */}
        <div className="bg-black/40 border border-white/5 rounded-lg overflow-hidden flex flex-col h-[280px]">
          <div className="p-3 bg-white/5 border-b border-white/5 flex justify-between items-center bg-gradient-to-r from-cyan-500/10 to-transparent">
            <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest flex items-center">
              <Clock size={12} className="mr-2 text-cyan-400" /> Recent Completed
            </span>
            <span className="text-[9px] text-cyan-400 font-mono font-bold tracking-widest">LATEST {recentClosed.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin">
            {recentClosed.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[10px] font-mono text-gray-700 uppercase italic">No recently closed items</div>
            ) : recentClosed.map(s => (
              <div key={s.id} className="flex items-center justify-between p-3 bg-white/5 rounded border border-white/5 hover:border-cyan-500/30 transition-all group opacity-80 hover:opacity-100 animate-in slide-in-from-right-2 duration-300">
                <div className="flex items-center space-x-4">
                  <div className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${runtimeBadgeClass(s.runtime)}`}>{runtimeLabel(s.runtime)}</div>
                  <div>
                    <div className="text-[11px] text-gray-400 group-hover:text-gray-200 transition-colors truncate w-64">{s.description}</div>
                    <div className="text-[8px] text-gray-600 font-mono mt-0.5 uppercase tracking-tighter">
                      {s.type && s.type !== s.runtime ? `${s.type} • ` : ''}FIN: {s.duration}S
                    </div>
                  </div>
                </div>
                <div className={`w-1.5 h-1.5 rounded-full ${s.status === 'failed' ? 'bg-red-500 shadow-[0_0_5px_red]' : 'bg-cyan-500/40 shadow-[0_0_5px_rgba(34,211,238,0.2)]'}`}></div>
              </div>
            ))}
          </div>
        </div>

        {/* Closed Summary Bar (Spans full width) */}
        <div className="col-span-2 bg-gradient-to-b from-cyan-900/10 to-transparent border border-cyan-500/20 rounded-lg p-4 flex items-center justify-between shadow-[inset_0_0_20px_rgba(34,211,238,0.05)]">
           <div className="flex items-center space-x-12">
              <div className="flex flex-col">
                <span className="text-[22px] font-mono text-white leading-none font-bold tracking-tighter">{allClosed.length}</span>
                <span className="text-[8px] text-cyan-500 font-mono tracking-[.2em] mt-1.5 font-bold uppercase">Aggregate Cycles</span>
              </div>
              <div className="h-10 w-px bg-cyan-500/20"></div>
              <div className="flex flex-col">
                <span className="text-[22px] font-mono text-white leading-none font-bold tracking-tighter">{(Math.round(totalDuration * 10) / 10).toFixed(1)}<span className="text-xs ml-1 font-normal opacity-50">s</span></span>
                <span className="text-[8px] text-cyan-500 font-mono tracking-[.2em] mt-1.5 font-bold uppercase">Workload Time</span>
              </div>
              <div className="h-10 w-px bg-cyan-500/20"></div>
              <div className="flex flex-col">
                <span className="text-[22px] font-mono text-white leading-none font-bold tracking-tighter">{totalToolCalls}</span>
                <span className="text-[8px] text-cyan-500 font-mono tracking-[.2em] mt-1.5 font-bold uppercase">Tool Calls</span>
              </div>
           </div>
           <div className="flex items-center text-[10px] font-mono text-gray-500 uppercase tracking-widest bg-black/40 px-4 py-2 rounded border border-white/5 shadow-inner">
              <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse mr-3 shadow-[0_0_5px_#22d3ee]"></div>
              Lanes: CODX {laneCounts.codex || 0} • CLAUDE {laneCounts.claude || 0} • OTHER {laneCounts.generic || 0}
           </div>
        </div>
      </div>
    </div>
  );
};

const AgentDetailView = ({ selectedAgentName, props, subAgents, loadingSubAgents }: { selectedAgentName: string, props: DashboardData, subAgents: SubAgentData[], loadingSubAgents: boolean }) => {
  const agent = props.agents.find(a => a.name === selectedAgentName);
  if (!agent) return null;

  const sel = selectedAgentName.toLowerCase();
  
  // Filter activities (waterfall)
  const filteredLogs = props.activities?.filter(row => 
    row.source?.toLowerCase() === sel || row.message?.toLowerCase().includes(sel)
  ) || [];

  // Filter bridge messages
  const filteredBridge = props.bridgeMessages?.filter(m =>
    m.from.toLowerCase() === sel || m.to.toLowerCase() === sel
  ) || [];

  // Filter task history
  const allTasks = props.projects.flatMap(p => (p.tasks || []).map(t => ({ ...t, project_name: p.name })));
  const filteredTasks = allTasks.filter(t => t.assignedAgent?.toLowerCase() === sel);

  const agentColors = props.agents?.reduce((acc: any, a) => {
     acc[a.name] = a.accentColor || 'purple';
     return acc;
  }, {}) || {};

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Agent Stats Strip */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Live Status" value={agent.status} color={isAgentHealthy(agent.status) ? 'text-green-400' : 'text-gray-500'} accentColor={isAgentHealthy(agent.status) ? 'green' : 'white'} />
        <StatCard label="Total Cost" value={agent.cost} unit="USD" color="text-amber-400" accentColor="amber" />
        <StatCard label="Throughput" value={agent.requestCount} unit="REQ" color="text-cyan-400" accentColor="cyan" />
        <StatCard label="Avg Latency" value={agent.latency} unit="MS" color="text-purple-400" accentColor="purple" />
      </div>

      {/* Existing Sub-Agents Panel */}
      <SubAgentPanel agentName={selectedAgentName} subAgents={subAgents} loading={loadingSubAgents} />

      <div className="flex space-x-6 h-[600px]">
        {/* Left column: Bridge messages */}
        <div className="w-1/3 flex flex-col h-full">
           <div className="flex items-center space-x-2 mb-3 px-2">
              <Activity size={14} className="text-purple-400" />
              <h3 className="text-[10px] font-mono tracking-[0.2em] text-purple-400 uppercase font-bold">Encrypted Bridge Traffic</h3>
           </div>
           <div className="flex-1 overflow-hidden">
              <BridgeConnectivityPanel messages={filteredBridge} agentColors={agentColors} hideTitle={true} actions={props.actions} />
           </div>
        </div>

        {/* Right column: Task History and Activity */}
        <div className="w-2/3 flex flex-col space-y-6">
           {/* Task History */}
           <GlassPanel className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="p-3 border-b border-white/10 flex justify-between items-center bg-black/40">
                 <h3 className="text-[10px] font-mono tracking-widest text-cyan-400 uppercase font-bold">Assigned Task Ledger</h3>
                 <span className="text-[8px] text-gray-500 font-mono uppercase bg-black/60 px-2 py-0.5 rounded border border-white/10">{filteredTasks.length} NODES</span>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                 {filteredTasks.length === 0 ? (
                   <div className="p-10 text-center text-gray-600 font-mono text-[9px] uppercase tracking-widest italic">No historical task record</div>
                 ) : (
                   <TaskHistoryTable tasks={filteredTasks} />
                 )}
              </div>
           </GlassPanel>

           {/* Activity Waterfall */}
           <GlassPanel className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="p-3 border-b border-white/10 flex justify-between items-center bg-black/40">
                 <h3 className="text-[10px] font-mono tracking-widest text-gray-300 uppercase font-bold">Node Waterfall Logs</h3>
                 <span className="text-[8px] text-gray-500 font-mono uppercase bg-black/60 px-2 py-0.5 rounded border border-white/10">{filteredLogs.length} EVENTS</span>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                 {filteredLogs.length === 0 ? (
                    <div className="p-10 text-center text-gray-600 font-mono text-[9px] uppercase tracking-widest italic">No runtime telemetry detected</div>
                 ) : (
                    <ActivityTable rows={filteredLogs} />
                 )}
              </div>
           </GlassPanel>
        </div>
      </div>
    </div>
  );
};

export default function Agents(props: DashboardData) {
  const [selectedAgentName, setSelectedAgentName] = useState<string|null>(null);
  const [subAgents, setSubAgents] = useState<SubAgentData[]>([]);
  const [loadingSubAgents, setLoadingSubAgents] = useState(false);

  useEffect(() => {
    if (!selectedAgentName) {
      setSubAgents([]);
      return;
    }

    // Abort any in-flight polling request when the selected agent changes
    // or the component unmounts, so a slow response can't clobber fresh
    // state (or leak a setState after unmount).
    const controller = new AbortController();
    let cancelled = false;

    const fetchSubAgents = async () => {
      try {
        const res = await fetch(
          `/api/subagents?parent=${selectedAgentName.toLowerCase()}`,
          { signal: controller.signal },
        );
        if (cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const list = Array.isArray(data?.subagents) ? data.subagents : [];
        setSubAgents(list.map((s: any) => ({
          id: s.id,
          parentAgent: s.parent_agent,
          type: s.subagent_type || 'general',
          runtime: s.runtime || inferRuntimeLane(s),
          description: s.description || '',
          status: s.status === 'running' ? 'active' : s.status || 'completed',
          taskReference: s.task_title || s.task_id || '',
          duration: s.duration_ms ? String(s.duration_ms / 1000) : '0',
          toolCalls: s.tool_calls || 0,
          model: s.model || undefined,
          provider: s.provider || undefined,
        })));
        setLoadingSubAgents(false);
      } catch (err: any) {
        if (err?.name === 'AbortError' || cancelled) return;
        console.error('Failed to fetch sub-agents', err);
        setLoadingSubAgents(false);
      }
    };

    setLoadingSubAgents(true);
    fetchSubAgents();
    const interval = setInterval(fetchSubAgents, 3000);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [selectedAgentName]);

  const toggleSelection = (name: string) => {
    setSelectedAgentName(prev => {
      const newVal = prev === name ? null : name;
      return newVal;
    });
  };

  return (
    <div className="flex flex-col space-y-6 w-[1500px] animate-in fade-in duration-500 h-full pb-10 mx-auto">
      {/* Top Header */}
      <div className="flex justify-between items-center mb-2 border-b border-white/10 pb-4">
        <h2 className="text-xl tracking-widest text-gray-300 font-light drop-shadow-md uppercase">Operational Agents</h2>
        {selectedAgentName && (
           <div className="flex space-x-2 items-center bg-cyan-900/30 px-3 py-1.5 rounded border border-cyan-500/30 animate-in zoom-in-95 duration-200">
              <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]"></div>
              <span className="text-[10px] font-mono tracking-widest text-cyan-400 uppercase font-bold">Drill-Down: {selectedAgentName}</span>
              <button 
                 onClick={() => setSelectedAgentName(null)}
                 className="ml-4 text-[10px] font-mono text-gray-400 hover:text-white transition-colors"
              >
                 [ EXIT_DETAIL ]
              </button>
           </div>
        )}
      </div>

      {/* Agent Filter Grid */}
      <div className={`grid grid-cols-4 gap-4 transition-all duration-500 ${selectedAgentName ? 'pb-4 opacity-100' : ''}`}>
        {(!props.agents || props.agents.length === 0) ? (
          <div className="col-span-full">
            <EmptyState title="Registry Empty" subtitle="Gateway is not authorizing or registering agents." />
          </div>
        ) : (
          props.agents.map((agent, i) => {
            const defaultColors = ['purple', 'cyan', 'amber', 'green'];
            const accent = agent.accentColor || defaultColors[i % defaultColors.length];
            return (
              <AgentDetailCard 
                key={agent.name} 
                accentColor={accent} 
                onClick={() => toggleSelection(agent.name)}
                isSelected={selectedAgentName === agent.name}
                hasSelection={selectedAgentName !== null}
                {...agent} 
              />
            );
          })
        )}
      </div>

      {/* Dynamic Detail View */}
      {selectedAgentName ? (
        <AgentDetailView 
          selectedAgentName={selectedAgentName} 
          props={props} 
          subAgents={subAgents} 
          loadingSubAgents={loadingSubAgents} 
        />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-20 opacity-40 grayscale group hover:opacity-100 hover:grayscale-0 transition-all duration-700">
           <div className="w-16 h-16 border-2 border-dashed border-cyan-500/40 rounded-full flex items-center justify-center mb-6 group-hover:border-cyan-500 animate-[spin_10s_linear_infinite]">
              <Activity size={24} className="text-cyan-400/50 group-hover:text-cyan-400 mt-0.5" />
           </div>
           <h3 className="text-xs font-mono tracking-[0.4em] text-gray-500 uppercase font-bold text-center">Select an active node to initialize<br/>deep-packet inspection</h3>
        </div>
      )}
    </div>
  );
}
