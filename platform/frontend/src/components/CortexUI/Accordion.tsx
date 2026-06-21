import { useState, useRef, useEffect } from 'react';
import { Folder, ChevronRight, ChevronDown, CheckSquare, Square, Plus, Check, FileText, X, Layers } from 'lucide-react';
import { TaskData, PhaseData, TaskStatus, DashboardActions } from '../../types/dashboard';

import { CustomSelect } from './Primitives';

/**
 * Prompt the user for a free-text reason. Falls back to a default string
 * when the user dismisses the prompt so the caller always gets a value.
 *
 * NOTE: This is a tactical stand-in. Phase 9 Task 9.8 replaces
 * `window.prompt()` in the bridge reply flow with a real modal;
 * the status dropdown should get the same treatment once the modal
 * primitive has a composable reason-input variant.
 */
const promptReason = (label: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const entered = window.prompt(`${label} — enter reason:`);
  return entered && entered.trim() ? entered.trim() : fallback;
};

// --- README MODAL ---
const ReadmeModal = ({ content, onClose }: { content: string, onClose: () => void }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Task README"
        className="relative bg-[#0d1117] border border-white/10 rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] w-[860px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest flex items-center gap-2">
            <FileText size={12} /> README.md
          </span>
          <button onClick={onClose} aria-label="Close README" className="text-gray-500 hover:text-white transition-colors"><X size={16} /></button>
        </div>
        <pre className="overflow-auto p-6 text-xs text-gray-300 font-mono leading-relaxed whitespace-pre-wrap">
          {content}
        </pre>
      </div>
    </div>
  );
};

// --- STYLING UTILS ---
const getTaskStatusColor = (status: TaskStatus) => {
  switch (status) {
    case 'pending': return 'bg-gray-800 text-gray-400 border-gray-700';
    case 'claimed': return 'bg-blue-900/40 text-blue-400 border-blue-500/30';
    case 'in_progress': return 'bg-cyan-900/40 text-cyan-400 border-cyan-500/30 drop-shadow-[0_0_5px_rgba(34,211,238,0.5)]';
    case 'submitted': return 'bg-amber-900/40 text-amber-400 border-amber-500/30';
    case 'review': return 'bg-purple-900/40 text-purple-400 border-purple-500/30';
    case 'approved': return 'bg-green-900/40 text-green-400 border-green-500/30 shadow-[0_0_8px_rgba(74,222,128,0.2)]';
    case 'rejected': return 'bg-red-900/40 text-red-400 border-red-500/30';
    case 'failed': return 'bg-red-900/50 text-red-500 border-red-500/40';
    case 'cancelled': return 'bg-gray-800/60 text-gray-500 border-white/5';
    // 'orphaned' = reaped by the session reaper; display-only muted gray,
    // no write transition wired (a reaped task cannot be re-activated from
    // the dashboard).
    case 'orphaned': return 'bg-gray-900/60 text-gray-600 border-gray-700/40';
    default: return 'bg-gray-800 text-gray-400 border-gray-700';
  }
};

const formatStatus = (s: TaskStatus) => s.replace('_', ' ').toUpperCase();

// --- LEVEL 4: TASK DETAIL ---
const TaskDetail = ({ task, actions }: { task: TaskData, actions?: DashboardActions }) => {
  const [reason, setReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(true);
  const [showReadme, setShowReadme] = useState(false);
  const reassignRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${task.id}/readme`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setReadmeContent(d?.content ?? null); })
      .catch(() => { if (!cancelled) setReadmeContent(null); })
      .finally(() => { if (!cancelled) setReadmeLoading(false); });
    return () => { cancelled = true; };
  }, [task.id]);

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

  // Extract the Description section from the README for the summary
  const readmeSummary = (() => {
    if (!readmeContent) return null;
    // Strip frontmatter
    const stripped = readmeContent.replace(/^---[\s\S]*?---\n?/, '').trim();
    // Find ## Description section
    const descMatch = stripped.match(/##\s+Description\n([\s\S]*?)(?=\n##\s|\n#\s|$)/);
    if (descMatch) {
      const text = descMatch[1].trim();
      // Return first ~300 chars, cut at sentence boundary if possible
      if (text.length <= 300) return text;
      const cut = text.slice(0, 300);
      const lastDot = cut.lastIndexOf('.');
      return (lastDot > 150 ? cut.slice(0, lastDot + 1) : cut) + '…';
    }
    return null;
  })();

  const isApproved = task.lifecycleStatus === 'approved';
  const isRejected = task.lifecycleStatus === 'rejected';
  const inReview = task.lifecycleStatus === 'review';
  const isPending = task.lifecycleStatus === 'pending';
  const isClaimed = task.lifecycleStatus === 'claimed';

  const formatDate = (ts: string) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d.getTime()) ? ts : d.toLocaleString();
  };

  return (
    <div className="pl-8 py-4 pr-4 bg-black/40 border-t border-white/5 space-y-4 font-sans animate-in slide-in-from-top-2 duration-200">

      {showReadme && readmeContent && (
        <ReadmeModal content={readmeContent} onClose={() => setShowReadme(false)} />
      )}

      {/* Description from README */}
      <div className="bg-white/[0.03] border border-white/5 rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-gray-600 uppercase tracking-widest">Description</span>
          {readmeContent && (
            <button
              onClick={() => setShowReadme(true)}
              className="flex items-center gap-1 text-[9px] font-mono text-cyan-500 hover:text-cyan-300 uppercase tracking-widest transition-colors"
            >
              <FileText size={10} /> View README
            </button>
          )}
        </div>
        {readmeLoading ? (
          <div className="text-xs text-gray-600 italic animate-pulse">Loading…</div>
        ) : readmeSummary ? (
          <p className="text-sm text-gray-300 leading-relaxed font-light">{readmeSummary}</p>
        ) : (
          <p className="text-xs text-gray-600 italic">{task.description || 'No description available.'}</p>
        )}
      </div>

      {/* Meta Grid */}
      <div className="grid grid-cols-5 gap-3">
        <div className="bg-black/40 border border-white/5 rounded p-2 flex flex-col space-y-1">
          <span className="text-[9px] text-gray-600 font-mono uppercase tracking-widest">Section</span>
          {actions?.updateTask ? (
             <input
                type="text"
                defaultValue={task.section || ''}
                placeholder="General"
                onBlur={(e) => {
                   const val = e.target.value.trim();
                   if (val !== (task.section || '')) {
                      actions.updateTask!(task.id, { section: val || null });
                   }
                }}
                onKeyDown={(e) => {
                   if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="bg-transparent border-none text-[10px] text-purple-400 font-mono focus:outline-none focus:ring-1 focus:ring-purple-500/50 rounded px-1 -ml-1 w-full"
             />
          ) : (
             <span className="text-[10px] text-purple-400 font-mono truncate">{task.section || 'General'}</span>
          )}
        </div>
        <div className="bg-black/40 border border-white/5 rounded p-2 flex flex-col space-y-1">
          <span className="text-[9px] text-gray-600 font-mono uppercase tracking-widest">Task ID</span>
          <span className="text-[10px] text-gray-400 font-mono truncate">#{task.id}</span>
        </div>
        <div className="bg-black/40 border border-white/5 rounded p-2 flex flex-col space-y-1">
          <span className="text-[9px] text-gray-600 font-mono uppercase tracking-widest">Assigned</span>
          <span className="text-[10px] text-cyan-400 font-mono">{task.assignedAgent || '—'}</span>
        </div>
        <div className="bg-black/40 border border-white/5 rounded p-2 flex flex-col space-y-1">
          <span className="text-[9px] text-gray-600 font-mono uppercase tracking-widest">Tokens</span>
          <span className="text-[10px] text-gray-300 font-mono">{task.tokens ? task.tokens.toLocaleString() : '—'}</span>
        </div>
        <div className="bg-black/40 border border-white/5 rounded p-2 flex flex-col space-y-1">
          <span className="text-[9px] text-gray-600 font-mono uppercase tracking-widest">Cost</span>
          <span className="text-[10px] text-amber-400 font-mono">{task.cost ? `$${task.cost.toFixed(4)}` : '—'}</span>
        </div>
      </div>

      <div className="text-[9px] text-gray-600 font-mono tracking-widest">
        LAST UPDATED: {formatDate(task.updatedTime)}
      </div>

      {/* Review Section */}
      {(inReview || isApproved || isRejected) && (
        <div className={`p-3 rounded border text-xs flex flex-col space-y-2 ${isApproved ? 'bg-green-900/10 border-green-500/20' : isRejected ? 'bg-red-900/10 border-red-500/20' : 'bg-purple-900/10 border-purple-500/20'}`}>
           <div className="flex justify-between items-center">
             <span className="font-mono text-gray-400 uppercase tracking-widest text-[9px]">REVIEWER: {task.reviewer || 'HUMAN'}</span>
             <span className={`font-mono text-[9px] px-2 py-0.5 rounded tracking-widest uppercase ${isApproved ? 'text-green-400 bg-green-900/40' : isRejected ? 'text-red-400 bg-red-900/40' : 'text-purple-400 bg-purple-900/40'}`}>
                {isApproved ? 'VERDICT: PASS' : isRejected ? 'VERDICT: REJECT' : 'AWAITING REVIEW'}
             </span>
           </div>
        </div>
      )}

      {/* Action Buttons — hidden for locked (read-only) projects */}
      {actions && (
        <div className="flex items-center space-x-2 pt-4 justify-start">
          {isPending && <button onClick={() => actions.claimTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase bg-blue-900/30 border border-blue-500/30 text-blue-400 hover:bg-blue-900/50 hover:border-blue-400/50 hover:shadow-[0_0_10px_rgba(59,130,246,0.3)] px-4 py-1.5 rounded transition-all shadow-inner">Claim Task</button>}
          {inReview && (
             <>
               <button onClick={() => actions.approveTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase bg-green-900/30 border border-green-500/30 text-green-400 hover:bg-green-900/50 hover:border-green-400/50 hover:shadow-[0_0_10px_rgba(34,197,94,0.3)] px-4 py-1.5 rounded transition-all shadow-inner flex items-center"><Check size={12} className="mr-1"/> Approve</button>
               <div className="flex space-x-1 items-center bg-black/60 border border-white/10 rounded px-2 shadow-inner">
                  <input type="text" value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason..." className="bg-transparent border-none text-[10px] font-mono w-32 focus:outline-none text-gray-300 placeholder-gray-600" />
                  <button onClick={() => actions.rejectTask(task.id, reason)} className="text-[10px] font-mono tracking-widest uppercase text-red-500 hover:text-red-400 hover:drop-shadow-[0_0_5px_#ef4444] px-3 py-1.5 transition-all">Reject</button>
               </div>
             </>
          )}
          {(isApproved || isRejected) && <button onClick={() => actions.reopenTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase border border-white/10 text-gray-400 bg-gray-900/30 hover:bg-gray-800/60 hover:text-white px-4 py-1.5 rounded transition-all">Reopen</button>}
          {isClaimed && !inReview && <button onClick={() => actions.submitTask(task.id)} className="text-[10px] font-mono tracking-widest uppercase bg-amber-900/30 border border-amber-500/30 text-amber-400 hover:bg-amber-900/50 hover:border-amber-400/50 hover:shadow-[0_0_10px_rgba(245,158,11,0.3)] px-4 py-1.5 rounded transition-all shadow-inner">Submit Release</button>}

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
                 {[
                   { id: 'nova', label: 'Nova' },
                   { id: 'orion', label: 'Orion' },
                   { id: 'scout', label: 'Scout' },
                   { id: 'pioneer', label: 'Pioneer' },
                 ].map(agent => (
                   <button
                      key={agent.id}
                      onClick={() => {
                         // Gateway identifies agents by lowercase slug; the
                         // button label stays title-cased for the user.
                         actions?.reassignTask(task.id, agent.id);
                         setShowReassign(false);
                      }}
                      className="text-[9px] font-mono tracking-widest uppercase text-left px-3 py-1.5 hover:bg-white/5 hover:text-cyan-400 rounded transition-colors"
                   >
                      {agent.label}
                   </button>
                 ))}
              </div>
            )}
          </div>

          <div className="flex-1"></div>

          <button
             onClick={() => {
                if (confirmDelete) {
                   actions.deleteTask(task.id);
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
      )}
    </div>
  );
};

// --- LEVEL 3: TASK ROW ---
const TaskRow = ({ task, actions }: { task: TaskData, actions?: DashboardActions }) => {
  const [expanded, setExpanded] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const isFinished = task.lifecycleStatus === 'approved';

  const statusOptions: { value: TaskStatus; label: string }[] = [
    { value: 'pending', label: 'Pending' },
    { value: 'claimed', label: 'Claimed' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'submitted', label: 'Submitted' },
    { value: 'review', label: 'Review' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'failed', label: 'Failed' },
    // 'orphaned' is display-only — a task reaped by the session reaper.
    // It appears in the dropdown so users can see it, but handleStatusChange
    // below returns early with no action (no write transition exists).
    { value: 'orphaned', label: 'ORPHANED' },
  ];

  /**
   * Map the full lifecycle enum to the action that advances a task into
   * each state. Every user-driven transition has a dedicated handler
   * (no silent no-ops), and the reviewer/failure reasons are collected
   * via `promptReason` so audit trails always have a string.
   */
  const handleStatusChange = (nextStatus: string) => {
    if (!actions) return;
    const next = nextStatus as TaskStatus;
    switch (next) {
      case 'pending':
        actions.reopenTask(task.id, 'Reopened from dashboard status dropdown');
        return;
      case 'claimed':
        actions.claimTask(task.id);
        return;
      case 'in_progress':
        // F9 — /resume now fans out by current task status; works for
        // pending, claimed, and rejected tasks alike.
        actions.resumeTask(task.id);
        return;
      case 'submitted':
        actions.submitTask(task.id);
        return;
      case 'review': {
        // F8 — reviewer is required at the backend; prompt via the same
        // helper the other status branches use so SSR and empty-input
        // handling stay in one place. An empty reviewer cancels the action.
        const reviewer = promptReason('Assign reviewer (e.g., nova)', '');
        if (!reviewer) return;
        actions.requestVerification(task.id, reviewer);
        return;
      }
      case 'approved':
        actions.approveTask(task.id);
        return;
      case 'rejected':
        actions.rejectTask(task.id, promptReason('Reject task', 'Rejected from dashboard'));
        return;
      case 'cancelled':
        actions.cancelTask(task.id, promptReason('Cancel task', 'Cancelled from dashboard'));
        return;
      case 'failed':
        actions.failTask(task.id, promptReason('Fail task', 'Failed from dashboard'));
        return;
      case 'orphaned':
        // Display-only state set by the session reaper. No user-driven
        // transition exists; ignore the selection silently.
        return;
      default: {
        // Exhaustiveness guard — if a new TaskStatus is added the compiler
        // will flag this assignment.
        const _exhaustive: never = next;
        void _exhaustive;
        console.warn('unsupported status transition', nextStatus);
      }
    }
  };

  const statusColor = getTaskStatusColor(task.lifecycleStatus);

  return (
    <div className={`border-t border-white/5 flex flex-col group transition-colors hover:bg-white/[0.02] relative ${dropdownOpen ? 'z-50' : 'z-auto'}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} task ${task.title}`}
        className="flex items-center p-3 cursor-pointer select-none focus:outline-none focus-visible:bg-white/5"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <div className="w-5 flex justify-center text-gray-500 group-hover:text-cyan-400 transition-colors">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        {actions ? (
          <button
            className="w-6 flex justify-center text-gray-500 hover:text-cyan-400 transition-colors"
            onClick={(e) => {
               e.stopPropagation();
               if (isFinished) actions.reopenTask(task.id);
               else actions.approveTask(task.id);
            }}
          >
             {isFinished ? <CheckSquare size={14} className="text-green-500" fill="rgba(34, 197, 94, 0.2)" /> : <Square size={14} opacity={0.5} />}
          </button>
        ) : (
          <div className="w-6 flex justify-center">
            {isFinished ? <CheckSquare size={14} className="text-green-500" fill="rgba(34, 197, 94, 0.2)" /> : <Square size={14} opacity={0.5} />}
          </div>
        )}
        
        <div className={`flex-1 text-sm transition-all ${isFinished ? 'text-gray-600 line-through decoration-white/20' : 'text-gray-300'}`}>
          {task.title}
        </div>

        <div className="flex items-center space-x-3">
          <div className="relative group/status" onClick={e => e.stopPropagation()}>
            {actions ? (
              <CustomSelect
                value={task.lifecycleStatus}
                onChange={handleStatusChange}
                options={statusOptions}
                accentColor="cyan"
                onOpenChange={setDropdownOpen}
                className={`w-36 ${statusColor} rounded border border-white/10 hover:border-white/30 transition-all duration-200 h-7 flex items-center shadow-sm`}
              />
            ) : (
              <span className={`w-36 inline-flex items-center px-2 h-7 rounded border border-white/10 text-[10px] font-mono tracking-widest uppercase ${statusColor}`}>
                {formatStatus(task.lifecycleStatus)}
              </span>
            )}
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

// --- LEVEL 2.5: SECTION ROW ---
const SectionRow = ({ sectionName, tasks, actions }: { sectionName: string, tasks: TaskData[], actions?: DashboardActions }) => {
  const [expanded, setExpanded] = useState(true);
  const finishedTasks = tasks.filter(t => t.lifecycleStatus === 'approved').length;
  const totalTasks = tasks.length;
  const isComplete = finishedTasks === totalTasks && totalTasks > 0;

  return (
    <div className="flex flex-col border-b border-white/5 last:border-b-0 bg-black/10">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} section ${sectionName}`}
        className="flex items-center p-2.5 bg-gray-900/20 cursor-pointer select-none hover:bg-gray-800/40 transition-colors border-l-2 border-transparent hover:border-l-purple-500/50 focus:outline-none focus-visible:border-l-purple-400 pl-6"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <div className="w-5 flex justify-center text-gray-500">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
        <div className="w-5 flex justify-center text-gray-500 mr-1">
           <Layers size={12} />
        </div>
        <h5 className={`text-[11px] font-bold tracking-wide uppercase flex-1 ${isComplete ? 'text-gray-600 line-through decoration-white/20' : 'text-gray-300 drop-shadow-sm'}`}>
          {sectionName}
        </h5>
        <div className="ml-4 text-[9px] text-gray-500 font-mono">{finishedTasks}/{totalTasks}</div>
        <div className="flex-1"></div>
      </div>
      
      {expanded && (
        <div className="flex flex-col bg-[#07090c]/40 pl-2">
          {tasks.map(t => <TaskRow key={t.id} task={t} actions={actions} />)}
        </div>
      )}
    </div>
  );
};

// --- LEVEL 2: PHASE STRIP ---
const PhaseRow = ({ projectId, phaseName, phaseIndex, tasks, actions, onCreateTask, onCreateSection }: { projectId: string, phaseName: string, phaseIndex: number, tasks: TaskData[], actions?: DashboardActions, onCreateTask?: (num: number) => void, onCreateSection?: (num: number) => void }) => {
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const finishedTasks = tasks.filter(t => t.lifecycleStatus === 'approved').length;
  const totalTasks = tasks.length;
  const isPhaseComplete = finishedTasks === totalTasks && totalTasks > 0;

  // Group tasks by section
  const sections: Record<string, TaskData[]> = {};
  tasks.forEach(t => {
    const sec = t.section || 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(t);
  });
  const sectionList = Object.keys(sections).sort();

  return (
    <div className="flex flex-col border-b border-white/5 last:border-b-0 bg-black/20">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${phaseName}`}
        className="flex items-center p-3 bg-gray-900/40 cursor-pointer select-none hover:bg-gray-800/60 transition-colors border-l-2 border-transparent hover:border-l-cyan-500/50 focus:outline-none focus-visible:border-l-cyan-400"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
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
        
        {onCreateSection && (
          <button
             onClick={(e) => {
                e.stopPropagation();
                onCreateSection(phaseIndex);
             }}
             className="mr-3 text-[9px] font-mono tracking-widest uppercase text-purple-400 border border-purple-500/30 bg-purple-900/30 hover:bg-purple-900/60 hover:text-purple-300 px-3 py-1 rounded transition-all shadow-inner"
          >
             + Section
          </button>
        )}
        
        {actions && (
          <button
             onClick={(e) => {
                e.stopPropagation();
                if (confirmDelete) {
                   actions.deletePhase(projectId, phaseIndex);
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
        )}
      </div>
      
      {expanded && (
        <div className="flex flex-col bg-[#07090c]/40">
          {sectionList.map(secName => (
             <SectionRow key={secName} sectionName={secName} tasks={sections[secName]} actions={actions} />
          ))}
          {onCreateTask && (
            <div className="p-3 border-t border-white/5 flex justify-center">
              <button
                onClick={() => onCreateTask(phaseIndex)}
                className="text-[10px] font-mono tracking-widest uppercase text-cyan-400 hover:text-cyan-300 flex items-center hover:drop-shadow-[0_0_5px_#22d3ee] transition-all"
              >
                <Plus size={12} className="mr-1" /> Create Task
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// --- LEVEL 1: ROOT ACCORDION ---
export const ProjectDetailAccordion = ({ projectId, tasks, phases, actions, onCreateTask, onCreateSection }: { projectId: string, tasks: TaskData[], phases: PhaseData[], actions?: DashboardActions, onCreateTask?: (num: number) => void, onCreateSection?: (num: number) => void }) => {
  const [expanded, setExpanded] = useState(true);

  // If no phases are formally defined, group all tasks into a single implicit Phase 1
  if (phases.length === 0 && tasks.length > 0) {
      return (
        <div className="border border-white/10 rounded-lg bg-gray-900/30 backdrop-blur-md shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)] relative">
          <PhaseRow
            projectId={projectId}
            phaseName="Phase 1"
            phaseIndex={1}
            tasks={tasks}
            actions={actions}
            onCreateTask={onCreateTask}
            onCreateSection={onCreateSection}
          />
        </div>
      );
  }

  const phaseList = phases.length > 0 
    ? phases 
    : Array.from(new Set(tasks.map(t => Number(t.phase)))).sort((a,b)=>a-b).map(p => ({ phase_number: p, task_count: 0, approved_count: 0 }));

  const tasksByPhase: Record<number, TaskData[]> = {};
  tasks.forEach(t => {
    const pNum = Number(t.phase);
    if (!tasksByPhase[pNum]) tasksByPhase[pNum] = [];
    tasksByPhase[pNum].push(t);
  });

  const totalFinished = tasks.filter(t => t.lifecycleStatus === 'approved').length;

  return (
    <div className="border border-white/10 rounded-lg bg-gray-900/30 backdrop-blur-md shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)] relative">
       {/* Level 1 Folder Row */}
       <div
         role="button"
         tabIndex={0}
         aria-expanded={expanded}
         aria-label={`${expanded ? 'Collapse' : 'Expand'} task breakdown`}
         className="flex items-center justify-between p-4 bg-black/60 cursor-pointer select-none hover:bg-black/80 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
         onClick={() => setExpanded(!expanded)}
         onKeyDown={(e) => {
           if (e.key === 'Enter' || e.key === ' ') {
             e.preventDefault();
             setExpanded(!expanded);
           }
         }}
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
                   onCreateSection={onCreateSection}
                />
              );
            })}
         </div>
       )}
    </div>
  );
};
