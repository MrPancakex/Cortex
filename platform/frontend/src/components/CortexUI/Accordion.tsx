import React, { useState, useRef, useEffect } from 'react';
import { Folder, ChevronRight, ChevronDown, CheckSquare, Square, AlertTriangle, MessageSquare, Plus, Check } from 'lucide-react';
import { TaskData, PhaseData } from '../../types/dashboard';

// --- STYLING UTILS ---
const getTaskStatusColor = (status: string) => {
  switch(status.toLowerCase()) {
    case 'pending': return 'bg-gray-800 text-gray-400 border-gray-700';
    case 'claimed': return 'bg-blue-900/40 text-blue-400 border-blue-500/30';
    case 'in_progress': return 'bg-cyan-900/40 text-cyan-400 border-cyan-500/30 drop-shadow-[0_0_5px_rgba(34,211,238,0.5)]';
    case 'submitted': return 'bg-amber-900/40 text-amber-400 border-amber-500/30';
    case 'review': return 'bg-purple-900/40 text-purple-400 border-purple-500/30';
    case 'approved': return 'bg-green-900/40 text-green-400 border-green-500/30 shadow-[0_0_8px_rgba(74,222,128,0.2)]';
    case 'rejected': return 'bg-red-900/40 text-red-400 border-red-500/30';
    default: return 'bg-gray-800 text-gray-400 border-gray-700';
  }
};

const formatStatus = (s: string) => s.replace('_', ' ').toUpperCase();

// --- LEVEL 4: TASK DETAIL ---
const TaskDetail = ({ task, actions }: { task: TaskData, actions?: any }) => {
  const [reason, setReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const reassignRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (reassignRef.current && !reassignRef.current.contains(event.target as Node)) {
        setShowReassign(false);
      }
    };
    if (showReassign) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showReassign]);
  const isApproved = task.lifecycleStatus.toLowerCase() === 'approved';
  const isRejected = task.lifecycleStatus.toLowerCase() === 'rejected';
  const inReview = task.lifecycleStatus.toLowerCase() === 'review';
  const isPending = task.lifecycleStatus.toLowerCase() === 'pending';
  const isClaimed = task.lifecycleStatus.toLowerCase() === 'claimed';

  return (
    <div className="pl-8 py-4 pr-4 bg-black/40 border-t border-white/5 space-y-4 font-sans animate-in slide-in-from-top-2 duration-200">
      <div className="text-sm text-gray-400 leading-relaxed font-light">
        Task implementation guidelines and component scaffolding targeting `{task.title}`. Must adhere to dark luxe specifications.
      </div>
      
      {/* Progress Timeline */}
      <div className="space-y-3 relative pl-2 border-l border-white/10 ml-2">
        <div className="relative">
          <div className="absolute -left-[13px] top-1.5 w-2 h-2 rounded-full bg-cyan-500 shadow-[0_0_5px_#06b6d4]"></div>
          <p className="text-[10px] text-gray-600 font-mono tracking-widest">{task.updatedTime}</p>
          <p className="text-xs text-gray-300 mt-0.5">Component logic pushed to staging buffer.</p>
          <p className="text-[10px] text-gray-500 font-mono mt-1 bg-white/5 inline-block px-2 py-0.5 rounded border border-white/5">src/components/Cards.tsx, src/hooks/useProxy.ts</p>
        </div>
        {!isApproved && (
           <div className="relative">
             <div className="absolute -left-[13px] top-1.5 w-2 h-2 rounded-full bg-orange-500 shadow-[0_0_5px_#f97316]"></div>
             <p className="text-[10px] text-gray-600 font-mono tracking-widest">SYSTEM ALERT</p>
             <p className="text-xs text-orange-400 mt-0.5 flex items-center"><AlertTriangle size={12} className="mr-1" /> Stub definitions detected in output.</p>
           </div>
        )}
      </div>

      {/* Review Section */}
      {(inReview || isApproved || isRejected) && (
        <div className={`mt-4 p-3 rounded border text-xs flex flex-col space-y-2 ${isApproved ? 'bg-green-900/10 border-green-500/20' : isRejected ? 'bg-red-900/10 border-red-500/20' : 'bg-purple-900/10 border-purple-500/20'}`}>
           <div className="flex justify-between items-center">
             <span className="font-mono text-gray-400 uppercase tracking-widest text-[9px]">REVIEWER: {task.reviewer || 'HUMAN'}</span>
             <span className={`font-mono text-[9px] px-2 py-0.5 rounded tracking-widest uppercase ${isApproved ? 'text-green-400 bg-green-900/40' : isRejected ? 'text-red-400 bg-red-900/40' : 'text-purple-400 bg-purple-900/40'}`}>
                {isApproved ? 'VERDICT: PASS' : isRejected ? 'VERDICT: REJECT' : 'PENDING'}
             </span>
           </div>
           <p className="text-gray-300 leading-relaxed"><MessageSquare size={12} className="inline mr-2 opacity-50"/> Code looks solid, but please ensure stub fallbacks log to the gateway stream.</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center space-x-2 pt-4 justify-start">
        {isPending && <button onClick={() => actions?.claimTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase bg-blue-900/30 border border-blue-500/30 text-blue-400 hover:bg-blue-900/50 hover:border-blue-400/50 hover:shadow-[0_0_10px_rgba(59,130,246,0.3)] px-4 py-1.5 rounded transition-all shadow-inner">Claim Task</button>}
        {inReview && (
           <>
             <button onClick={() => actions?.approveTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase bg-green-900/30 border border-green-500/30 text-green-400 hover:bg-green-900/50 hover:border-green-400/50 hover:shadow-[0_0_10px_rgba(34,197,94,0.3)] px-4 py-1.5 rounded transition-all shadow-inner flex items-center"><Check size={12} className="mr-1"/> Approve</button>
             <div className="flex space-x-1 items-center bg-black/60 border border-white/10 rounded px-2 shadow-inner">
                <input type="text" value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason..." className="bg-transparent border-none text-[10px] font-mono w-32 focus:outline-none text-gray-300 placeholder-gray-600" />
                <button onClick={() => actions?.rejectTask(task.id, reason)} className="text-[10px] font-mono tracking-widest uppercase text-red-500 hover:text-red-400 hover:drop-shadow-[0_0_5px_#ef4444] px-3 py-1.5 transition-all">Reject</button>
             </div>
           </>
        )}
        {(isApproved || isRejected) && <button onClick={() => actions?.reopenTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase border border-white/10 text-gray-400 bg-gray-900/30 hover:bg-gray-800/60 hover:text-white px-4 py-1.5 rounded transition-all">Reopen</button>}
        {isClaimed && !inReview && <button onClick={() => actions?.releaseTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase bg-amber-900/30 border border-amber-500/30 text-amber-400 hover:bg-amber-900/50 hover:border-amber-400/50 hover:shadow-[0_0_10px_rgba(245,158,11,0.3)] px-4 py-1.5 rounded transition-all shadow-inner">Submit Release</button>}
        
        <div className="relative" ref={reassignRef}>
          <button 
             onClick={() => setShowReassign(!showReassign)} 
             className={`text-[10px] font-mono tracking-widest uppercase border border-white/5 px-4 py-1.5 rounded transition-colors ${showReassign ? 'bg-cyan-900/40 text-cyan-400 border-cyan-500/30' : 'text-gray-500 hover:border-white/20 hover:text-white'}`}
          >
             Reassign Agent {showReassign ? '▴' : '▸'}
          </button>
          
          {showReassign && (
            <div className="absolute bottom-full left-0 mb-2 bg-[#0d1117] border border-cyan-500/30 rounded shadow-[0_8px_32px_rgba(0,0,0,0.8)] z-[100] p-2 flex flex-col space-y-1 min-w-[140px] animate-in fade-in slide-in-from-bottom-2 duration-200">
               <div className="text-[8px] font-mono text-cyan-500/60 uppercase tracking-widest mb-1 px-3 border-b border-white/5 pb-1">Select Node</div>
               {['Atlas', 'Zeus', 'Gerald', 'Faust'].map(agent => (
                 <button 
                    key={agent}
                    onClick={() => {
                       actions?.reassignTask(task.id, agent);
                       setShowReassign(false);
                    }}
                    className="text-[9px] font-mono tracking-widest uppercase text-left px-3 py-1.5 hover:bg-white/5 hover:text-cyan-400 rounded transition-colors"
                 >
                    {agent}
                 </button>
               ))}
            </div>
          )}
        </div>

        <div className="flex-1"></div>
        
        <button 
           onClick={() => {
              if (confirmDelete) {
                 actions?.deleteTask(task.id);
                 setConfirmDelete(false);
              } else {
                 setConfirmDelete(true);
                 setTimeout(() => setConfirmDelete(false), 3000);
              }
           }} 
           className={`text-[10px] font-mono tracking-widest uppercase transition-all flex items-center px-4 py-1.5 rounded border ${confirmDelete ? 'bg-red-500 text-white border-white' : 'text-red-500/60 hover:text-red-400 border-transparent'}`}
        >
           {confirmDelete ? 'CONFIRM DELETE?' : 'Delete'}
        </button>
      </div>
    </div>
  );
};

// --- LEVEL 3: TASK ROW ---
const TaskRow = ({ task, actions }: { task: TaskData, actions?: any }) => {
  const [expanded, setExpanded] = useState(false);
  const isFinished = task.lifecycleStatus.toLowerCase() === 'approved';
  // Mocking stub detection based on tokens/cost ratio for UI demonstration
  const hasStubs = (task.tokens || 0) < 5000 && !isFinished;

  return (
    <div className="border-t border-white/5 flex flex-col group transition-colors hover:bg-white/[0.02]">
      <div 
        className="flex items-center p-3 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-5 flex justify-center text-gray-500 group-hover:text-cyan-400 transition-colors">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <button 
          className="w-6 flex justify-center text-gray-500 hover:text-cyan-400 transition-colors"
          onClick={(e) => {
             e.stopPropagation();
             if (isFinished) actions?.reopenTask(task.id);
             else actions?.approveTask(task.id);
          }}
        >
           {isFinished ? <CheckSquare size={14} className="text-green-500" fill="rgba(34, 197, 94, 0.2)" /> : <Square size={14} opacity={0.5} />}
        </button>
        
        <div className={`flex-1 text-sm transition-all ${isFinished ? 'text-gray-600 line-through decoration-white/20' : 'text-gray-300'}`}>
          {task.title}
        </div>

        <div className="flex items-center space-x-3">
          {hasStubs && <AlertTriangle size={14} className="text-orange-500 drop-shadow-[0_0_3px_#f97316]" />}
          <div className={`text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border ${getTaskStatusColor(task.lifecycleStatus)}`}>
            {formatStatus(task.lifecycleStatus)}
          </div>
          <div className="text-[10px] w-20 text-right font-mono tracking-wider text-gray-400 truncate">
            {task.assignedAgent}
          </div>
        </div>
      </div>
      
      {expanded && <TaskDetail task={task} actions={actions} />}
    </div>
  );
};

// --- LEVEL 2: PHASE STRIP ---
const PhaseRow = ({ projectId, phaseName, phaseIndex, tasks, actions, onCreateTask }: { projectId: string, phaseName: string, phaseIndex: number, tasks: TaskData[], actions?: any, onCreateTask?: (num: number) => void }) => {
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const finishedTasks = tasks.filter(t => t.lifecycleStatus.toLowerCase() === 'approved').length;
  const totalTasks = tasks.length;
  const isPhaseComplete = finishedTasks === totalTasks && totalTasks > 0;

  return (
    <div className="flex flex-col border-b border-white/5 last:border-b-0 bg-black/20">
      <div 
        className="flex items-center p-3 bg-gray-900/40 cursor-pointer select-none hover:bg-gray-800/60 transition-colors border-l-2 border-transparent hover:border-l-cyan-500/50"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-6 flex justify-center text-gray-400">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className="w-6 flex justify-center text-gray-500">
           {isPhaseComplete ? <CheckSquare size={15} className="text-green-500" fill="rgba(34, 197, 94, 0.2)" /> : <Square size={15} opacity={0.5} />}
        </div>
        <h4 className={`text-sm font-bold tracking-wide uppercase flex-1 ${isPhaseComplete ? 'text-gray-600 line-through decoration-white/20' : 'text-gray-200 drop-shadow-sm'}`}>
          {phaseName}
        </h4>
        <div className="ml-4 text-[10px] text-gray-500 font-mono">{finishedTasks}/{totalTasks} COMPLETE</div>
        <div className="flex-1"></div>
        
        <button 
           onClick={(e) => {
              e.stopPropagation();
              if (confirmDelete) {
                 actions?.deletePhase(projectId, phaseIndex);
                 setConfirmDelete(false);
              } else {
                 setConfirmDelete(true);
                 setTimeout(() => setConfirmDelete(false), 3000);
              }
           }} 
           className={`mr-4 h-5 px-2 rounded-full border transition-all text-[8px] font-mono font-bold uppercase tracking-widest flex items-center justify-center ${confirmDelete ? 'bg-red-500 text-white border-white w-20' : 'bg-red-900/30 border-red-500/30 text-red-500 hover:bg-red-500 hover:text-white w-6'}`}
        >
           {confirmDelete ? 'CONFIRM?' : <>&times;</>}
        </button>
      </div>
      
      {expanded && (
        <div className="flex flex-col bg-[#07090c]/40">
          {tasks.map(t => <TaskRow key={t.id} task={t} actions={actions} />)}
          <div className="p-3 border-t border-white/5 flex justify-center">
            <button 
              onClick={() => onCreateTask?.(phaseIndex)}
              className="text-[10px] font-mono tracking-widest uppercase text-cyan-400 hover:text-cyan-300 flex items-center hover:drop-shadow-[0_0_5px_#22d3ee] transition-all"
            >
              <Plus size={12} className="mr-1" /> Create Task
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// --- LEVEL 1: MASTER BREAKDOWN ACCORDION ---
export const ProjectDetailAccordion = ({ projectId, tasks, phases, actions, onCreateTask }: { projectId: string, tasks: TaskData[], phases: PhaseData[], actions?: any, onCreateTask?: (num: number) => void }) => {
  const [expanded, setExpanded] = useState(true);

  // Group tasks by Phase using the explicit phases array
  const phaseList = phases.length > 0 
    ? phases 
    : Array.from(new Set(tasks.map(t => Number(t.phase)))).sort((a,b)=>a-b).map(p => ({ phase_number: p, task_count: 0, approved_count: 0 }));

  const tasksByPhase: Record<number, TaskData[]> = {};
  tasks.forEach(t => {
    const pNum = Number(t.phase);
    if (!tasksByPhase[pNum]) tasksByPhase[pNum] = [];
    tasksByPhase[pNum].push(t);
  });

  const totalFinished = tasks.filter(t => t.lifecycleStatus.toLowerCase() === 'approved').length;

  return (
    <div className="border border-white/10 rounded-lg bg-gray-900/30 backdrop-blur-md shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)] relative">
       {/* Level 1 Folder Row */}
       <div 
         className="flex items-center justify-between p-4 bg-black/60 cursor-pointer select-none hover:bg-black/80 transition-colors"
         onClick={() => setExpanded(!expanded)}
       >
         <div className="flex items-center space-x-3">
            <div className="text-cyan-500 drop-shadow-[0_0_8px_rgba(6,182,212,0.6)]">
               <Folder size={18} fill="currentColor" />
            </div>
            <h3 className="font-mono text-sm tracking-widest font-bold text-gray-200 uppercase drop-shadow-sm">TASK BREAKDOWN</h3>
         </div>
         <div className="flex items-center space-x-4">
            <span className="bg-cyan-900/30 border border-cyan-500/30 text-cyan-400 px-3 py-1 rounded text-[10px] font-mono tracking-widest shadow-inner uppercase">
               {totalFinished} / {tasks.length} FINISHED
            </span>
            <div className="text-gray-500">
               {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </div>
         </div>
       </div>

       {/* Map Phases */}
       {expanded && (
         <div className="flex flex-col">
            {phaseList.map((ph) => {
              const phaseTasks = tasksByPhase[ph.phase_number] || [];
              return (
                <PhaseRow 
                   key={ph.phase_number} 
                   projectId={projectId}
                   phaseName={`Phase ${ph.phase_number}`} 
                   phaseIndex={ph.phase_number} 
                   tasks={phaseTasks} 
                   actions={actions} 
                   onCreateTask={onCreateTask} 
                />
              );
            })}
         </div>
       )}
    </div>
  );
};
