import { useState, useEffect } from 'react';
import { DashboardData, SubAgentData } from '../types/dashboard';
import { AgentDetailCard, StatCard } from '../components/CortexUI/Cards';
import { EmptyState, GlassPanel } from '../components/CortexUI/Primitives';
import { BridgeConnectivityPanel, ActivityTable, TaskHistoryTable } from '../components/CortexUI/Feeds';
import { Layers, Activity, Clock, ChevronRight } from 'lucide-react';

const SubAgentPanel = ({ agentName, subAgents, loading }: { agentName: string, subAgents: SubAgentData[], loading: boolean }) => {
  const activeSubAgents = subAgents.filter(s => s.status === 'active');
  const closedSubAgents = subAgents.filter(s => s.status !== 'active');
  
  const totalDuration = closedSubAgents.reduce((acc, s) => acc + (parseFloat(s.duration) || 0), 0);
  const totalToolCalls = closedSubAgents.reduce((acc, s) => acc + (s.toolCalls || 0), 0);

  return (
    <div className="mt-6 animate-in slide-in-from-top-4 duration-300">
      <div className="flex items-center space-x-2 mb-4">
        <Layers size={16} className="text-cyan-400" />
        <h3 className="text-xs font-mono tracking-[.3em] text-cyan-400 uppercase font-bold">Node Sub-Orchestration: {agentName}</h3>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {/* Active Section */}
        <div className="bg-black/40 border border-white/5 rounded-lg overflow-hidden flex flex-col h-[200px]">
          <div className="p-3 bg-white/5 border-b border-white/5 flex justify-between items-center">
            <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest flex items-center">
              <Activity size={12} className="mr-2 text-green-400 animate-pulse" /> Active Sub-Agents
            </span>
            <span className="text-[9px] text-gray-600 font-mono italic">{activeSubAgents.length} EXECUTING</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin">
            {loading ? (
              <div className="h-full flex items-center justify-center text-[10px] font-mono text-gray-600 animate-pulse uppercase">Retrieving subtree...</div>
            ) : activeSubAgents.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[10px] font-mono text-gray-700 uppercase italic">No active sub-processes</div>
            ) : activeSubAgents.map(s => (
              <div key={s.id} className="flex items-center justify-between p-3 bg-white/5 rounded border border-white/5 hover:border-cyan-500/30 transition-all group">
                <div className="flex items-center space-x-4">
                  <div className="text-[10px] font-mono text-cyan-400 font-bold bg-cyan-900/20 px-2 py-0.5 rounded border border-cyan-500/20">{s.type}</div>
                  <div>
                    <div className="text-xs text-gray-300 font-medium group-hover:text-white transition-colors">{s.description}</div>
                    <div className="text-[9px] text-gray-600 font-mono mt-0.5 uppercase tracking-tighter">REF: {s.taskReference}</div>
                  </div>
                </div>
                <div className="flex items-center space-x-6">
                   <div className="text-right">
                      <div className="text-[10px] font-mono text-gray-400">{(Math.round(parseFloat(s.duration) * 10) / 10).toFixed(1)}s</div>
                      <div className="text-[8px] text-gray-600 uppercase font-mono tracking-widest">DURATION</div>
                   </div>
                   <ChevronRight size={14} className="text-gray-700 group-hover:text-cyan-500 transition-colors" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Closed Summary Bar */}
        <div className="bg-cyan-900/10 border border-cyan-500/20 rounded-lg p-3 flex items-center justify-between shadow-[inset_0_0_20px_rgba(34,211,238,0.05)]">
           <div className="flex items-center space-x-8">
              <div className="flex flex-col">
                <span className="text-[18px] font-mono text-white leading-none font-bold">{closedSubAgents.length}</span>
                <span className="text-[8px] text-cyan-500/60 uppercase font-mono tracking-[.2em] mt-1">Closed Cycles</span>
              </div>
              <div className="h-8 w-px bg-white/5"></div>
              <div className="flex flex-col">
                <span className="text-[18px] font-mono text-white leading-none font-bold">{(Math.round(totalDuration * 10) / 10).toFixed(1)}s</span>
                <span className="text-[8px] text-cyan-500/60 uppercase font-mono tracking-[.2em] mt-1">Total Duration</span>
              </div>
              <div className="h-8 w-px bg-white/5"></div>
              <div className="flex flex-col">
                <span className="text-[18px] font-mono text-white leading-none font-bold">{totalToolCalls}</span>
                <span className="text-[8px] text-cyan-500/60 uppercase font-mono tracking-[.2em] mt-1">Tool Execs</span>
              </div>
           </div>
           <div className="flex items-center text-[9px] font-mono text-gray-500 uppercase tracking-widest bg-black/40 px-3 py-1.5 rounded border border-white/5">
              <Clock size={12} className="mr-2 opacity-50" />
              Aggregate Data Terminal
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
        <StatCard label="Live Status" value={agent.status} color={agent.status === 'ONLINE' ? 'text-green-400' : 'text-gray-500'} accentColor={agent.status === 'ONLINE' ? 'green' : 'white'} />
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
    if (selectedAgentName) {
      setLoadingSubAgents(true);
      fetch(`/api/subagents?parent=${selectedAgentName.toLowerCase()}`)
        .then(res => res.json())
        .then(data => {
            const list = Array.isArray(data?.subagents) ? data.subagents : [];
            setSubAgents(list.map((s: any) => ({
              id: s.id,
              parentAgent: s.parent_agent,
              type: s.subagent_type || 'general',
              description: s.description || '',
              status: s.status === 'running' ? 'active' : s.status || 'completed',
              taskReference: s.task_title || s.task_id || '',
              duration: s.duration_ms ? String(s.duration_ms / 1000) : '0',
              toolCalls: s.tool_calls || 0,
            })));
            setLoadingSubAgents(false);
        })
        .catch((err) => {
            console.error('Failed to fetch sub-agents', err);
            setLoadingSubAgents(false);
        });
    } else {
      setSubAgents([]);
    }
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
