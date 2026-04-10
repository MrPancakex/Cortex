import React, { useState } from 'react';
import { GlassPanel, C } from './Primitives';
import { BridgeMessageData, SystemLogData } from '../../types/dashboard';

const TypeBadge = ({ type }: { type: string }) => {
  const cMap: any = {
    'REQ': 'text-purple-400 border-purple-500/30',
    'SYS': 'text-gray-400 border-gray-500/30',
    'MCP': 'text-cyan-400 border-cyan-500/30',
    'BRIDGE': 'text-amber-400 border-amber-500/30',
    'LLM_REQUEST': 'text-purple-400 border-purple-500/30',
    'PROXY_ROUTE': 'text-cyan-400 border-cyan-500/30',
    'CORTEX': 'text-green-400 border-green-500/30'
  };
  const cl = cMap[type] || 'text-green-400 border-green-500/30';
  return <span className={`px-1.5 rounded text-[8px] uppercase tracking-widest font-mono ${cl}`}>{type}</span>;
}

export const BridgeConnectivityPanel = ({ messages, agentColors = {}, hideTitle = false, compact = false, onNavigate, actions }: { messages: BridgeMessageData[], agentColors?: Record<string, string>, hideTitle?: boolean, compact?: boolean, onNavigate?: (route: string) => void, actions?: any }) => {
  const [composeBody, setComposeBody] = useState('');
  const displayMsgs = compact ? messages.slice(-3) : messages;

  const badgeMap: any = {
    purple: 'bg-purple-900/20 text-purple-400 border border-purple-500/20',
    cyan: 'bg-cyan-900/20 text-cyan-400 border border-cyan-500/20',
    amber: 'bg-amber-900/20 text-amber-400 border border-amber-500/20',
    green: 'bg-green-900/20 text-green-400 border border-green-500/20',
    red: 'bg-red-900/20 text-red-500 border border-red-500/20',
    default: 'bg-gray-800 text-gray-400 border border-gray-600'
  };

  return (
  <div className={`flex flex-col h-full bg-black/40 rounded-lg p-2 ${!compact ? 'border border-purple-500/10' : ''}`}>
    {!hideTitle && <h3 className="text-[10px] font-mono tracking-widest text-purple-400 mb-3 ml-2 flex justify-between items-center pr-2"><div className="flex space-x-2 items-center"><div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse shadow-[0_0_8px_#c084fc]"></div><span>Bridge Link</span></div> {compact && <span className="text-[8px] bg-purple-900/30 border border-purple-500/30 px-1.5 py-0.5 rounded text-purple-400 transition-colors uppercase font-bold tracking-widest cursor-pointer hover:bg-purple-900/60" onClick={() => onNavigate && onNavigate('AGENTS')}>VIEW ALL</span>}</h3>}
    <div className={`flex-1 overflow-y-auto scrollbar-thin space-y-1 ${compact ? 'pointer-events-none' : ''}`}>
      {!messages || messages.length === 0 ? (
        <div className="text-[10px] text-gray-600 font-mono p-4 text-center border-dashed border border-white/5 mx-2 rounded">No active bridge messages</div>
      ) : (
        displayMsgs.map((m: BridgeMessageData) => (
          <div key={m.id} className="text-xs flex flex-col py-2 border-b border-white/5 last:border-0 hover:bg-white/5 px-2 rounded transition-colors relative group/msg">
            <div className="flex items-center space-x-2 text-[8px] font-mono mb-1.5 uppercase font-medium">
              <span className={`px-1.5 py-0.5 rounded ${badgeMap[agentColors[m.from]] || badgeMap.default}`}>{m.from}</span>
              <span className="text-gray-600">→</span>
              <span className={`px-1.5 py-0.5 rounded ${badgeMap[agentColors[m.to]] || badgeMap.default}`}>{m.to}</span>
              <span className="flex-1 text-right text-gray-600 tracking-widest">{m.sentTime}</span>
            </div>
            <div className="text-[11px] text-gray-400 font-mono tracking-tight leading-relaxed">{m.body}</div>
            {!compact && <button onClick={(e) => { e.stopPropagation(); const msg = window.prompt('Reply:'); if(msg) actions?.replyMessage(m.id, msg); }} className="absolute right-2 bottom-2 hidden group-hover/msg:block text-[8px] font-mono tracking-widest text-purple-400 uppercase bg-purple-900/40 px-2 py-0.5 rounded border border-purple-500/40 hover:bg-purple-900/80 transition-all font-bold shadow-[0_0_10px_rgba(168,85,247,0.3)]">REPLY</button>}
          </div>
        ))
      )}
    </div>
    
    {!compact && (
      <div className="flex-none border-t border-purple-500/20 pt-2 flex space-x-2 mt-2 sticky bottom-0">
         <input type="text" value={composeBody} onChange={(e) => setComposeBody(e.target.value)} className="flex-1 bg-black/60 border border-purple-500/30 rounded px-3 py-1.5 text-[10px] font-mono tracking-widest text-purple-300 placeholder-purple-900/60 outline-none focus:border-purple-500/80 transition-colors h-8" placeholder="COMPOSE DIRECTIVE..." />
         <button onClick={() => { actions?.sendMessage('ALL', 'DIRECTIVE', composeBody, 'GLOBAL_TASK'); setComposeBody(''); }} className="h-8 px-4 bg-purple-900/30 text-purple-400 border border-purple-500/40 hover:bg-purple-900/80 hover:text-white rounded text-[10px] font-mono font-bold uppercase tracking-widest shadow-[0_0_10px_rgba(168,85,247,0.2)] transition-all">SEND</button>
      </div>
    )}
  </div>
  );
};

export const ActivityTable = ({ rows, compact = false }: { rows: SystemLogData[], compact?: boolean }) => (
  <div className="w-full text-left text-sm text-gray-400 font-mono pt-1">
    {rows?.map((row: SystemLogData) => {
      // Map API eventTypes to screenshot badges
      let bType = 'SYS';
      if (row.eventType.includes('LLM')) bType = 'REQ';
      if (row.eventType.includes('PROXY')) bType = 'MCP';
      if (row.message.includes('Bridge')) bType = 'BRIDGE';
      if (row.message.includes('Cortex')) bType = 'CORTEX';

      return (
      <div key={row.id} className="flex items-start space-x-2 px-2 py-1.5 hover:bg-white/5 transition-colors border-l-2 border-transparent hover:border-l-white/20 rounded-r">
        <div className="text-[9px] text-gray-600 w-12 flex-none pt-0.5 tracking-wider">{row.timestamp.split(' ').pop()}</div>
        <div className="flex-none pt-0.5 w-12"><TypeBadge type={bType} /></div>
        <div className="text-[11px] text-gray-300 flex-1 leading-relaxed truncate">{row.message}</div>
      </div>
      );
    })}
  </div>
);
export const TaskHistoryTable = ({ tasks }: { tasks: any[] }) => (
  <div className="w-full text-left text-sm text-gray-400 font-mono pt-1">
    <div className="flex items-center px-4 py-2 border-b border-white/5 text-[9px] text-gray-500 uppercase tracking-widest bg-white/5">
      <div className="w-12 flex-none">PID</div>
      <div className="flex-1">Directive Title</div>
      <div className="w-24 flex-none text-right">Status</div>
      <div className="w-20 flex-none text-right">Outcome</div>
    </div>
    {tasks?.map((task) => (
      <div key={task.id} className="flex items-center space-x-2 px-4 py-2 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 group">
        <div className="text-[10px] text-cyan-500/60 w-12 flex-none font-bold">#{task.id.slice(-4)}</div>
        <div className="flex-1 flex flex-col">
          <div className="text-[11px] text-gray-200 group-hover:text-cyan-400 transition-colors truncate">{task.title}</div>
          <div className="text-[8px] text-gray-600 uppercase tracking-tighter">PHASE {task.phase || 1} • {task.updatedTime}</div>
        </div>
        <div className="w-24 flex-none text-right">
           <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-current/20 bg-current/5 ${
             task.lifecycleStatus === 'completed' ? 'text-green-400' : 
             task.lifecycleStatus === 'claimed' ? 'text-purple-400' :
             task.lifecycleStatus === 'review' ? 'text-blue-400' : 'text-gray-500'
           }`}>
             {task.lifecycleStatus}
           </span>
        </div>
        <div className="w-20 flex-none text-right text-[10px] text-amber-500 font-bold">${(task.cost || 0).toFixed(2)}</div>
      </div>
    ))}
  </div>
);
