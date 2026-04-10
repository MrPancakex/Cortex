import React, { useState } from 'react';
import { DashboardData, ProjectData } from '../types/dashboard';
import { EmptyState, GlassPanel } from '../components/CortexUI/Primitives';
import { ProjectCard } from '../components/CortexUI/Cards';
import { ProjectDetailAccordion } from '../components/CortexUI/Accordion';
import { CreateProjectModal, CreateTaskModal } from '../components/CortexUI/Modals';
import { ArrowLeft, PenTool, PlusCircle, CheckCircle2 } from 'lucide-react';

const AddPhaseButton = ({ projectId, onAddPhase }: { projectId: string, onAddPhase?: (id: string) => void }) => {
  const [added, setAdded] = useState(false);
  
  const handleAdd = () => {
    onAddPhase?.(projectId);
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  };

  return (
    <button 
        onClick={handleAdd}
        disabled={added}
        className={`flex items-center text-[10px] font-mono uppercase tracking-widest border px-6 py-2 rounded transition-all shadow-inner w-max ${added ? 'bg-green-900/30 text-green-400 border-green-500/30' : 'text-cyan-400 border-cyan-500/30 hover:bg-cyan-900/30'}`}
    >
       {added ? <CheckCircle2 size={12} className="mr-2 animate-in zoom-in duration-300" /> : <PlusCircle size={12} className="mr-2" />}
       {added ? 'Phase Added' : 'Add Phase'}
    </button>
  );
};

export default function Projects(props: DashboardData) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isProjectModalOpen, setProjectModalOpen] = useState(false);
  const [isTaskModalOpen, setTaskModalOpen] = useState(false);
  const [activePhase, setActivePhase] = useState<number | null>(null);

  // If a project is selected, render the Detail View
  if (selectedProjectId) {
    const project = props.projects.find(p => p.id === selectedProjectId);
    if (!project) return <EmptyState title="Not Found" subtitle="Project data unavailable" />;

    return (
      <div className="w-[1500px] animate-in slide-in-from-right-4 duration-300 pb-20 mx-auto">
        <button 
          onClick={() => setSelectedProjectId(null)}
          className="flex items-center text-sm font-mono tracking-widest text-gray-500 hover:text-cyan-400 transition-colors uppercase mb-6 group select-none"
        >
          <ArrowLeft size={14} className="mr-2 group-hover:-translate-x-1 transition-transform" /> Back to Projects
        </button>

        {/* Project Summary Banner */}
        <GlassPanel className="p-8 mb-6 border-l-4 border-l-cyan-500 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.6)] relative overflow-hidden group">
           <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-cyan-900/20 via-transparent to-transparent pointer-events-none blur-3xl opacity-50 group-hover:opacity-100 transition-opacity"></div>
           
           <div className="relative z-10 flex justify-between items-end">
              <div>
                 <div className="text-[10px] text-cyan-400 font-mono tracking-[0.3em] font-bold uppercase drop-shadow-[0_0_5px_#22d3ee] mb-2">Phase {Array.from(new Set(project.tasks?.map(t => t.phase) || [])).length}</div>
                 <h1 className="text-4xl text-white font-light tracking-wide drop-shadow-lg">{project.name}</h1>
                 <div className="flex space-x-4 mt-6">
                    <div className="flex flex-col space-y-1 bg-black/40 px-4 py-2 rounded border border-white/5">
                      <span className="text-[9px] text-gray-500 font-mono uppercase tracking-widest">ASSIGNMENTS</span>
                      <span className="text-xs text-gray-300 font-mono">
                         {Array.from(new Set(project.tasks?.map(t => t.assignedAgent) || [])).join(', ') || 'Unassigned'}
                      </span>
                    </div>
                    <div className="flex flex-col space-y-1 bg-black/40 px-4 py-2 rounded border border-white/5">
                      <span className="text-[9px] text-gray-500 font-mono uppercase tracking-widest">COMPLETION</span>
                      <span className="text-xs text-green-400 font-mono tracking-wider drop-shadow-[0_0_5px_#4ade80]">{project.completedCount} / {project.taskCount} TASKS</span>
                    </div>
                    <div className="flex flex-col space-y-1 bg-black/40 px-4 py-2 rounded border border-white/5">
                      <span className="text-[9px] text-gray-500 font-mono uppercase tracking-widest">TOTAL COST</span>
                      <span className="text-xs text-amber-400 font-mono tracking-wider">${project.totalCost?.toFixed(2)}</span>
                    </div>
                 </div>
                 
                 <div className="mt-8">
                    <AddPhaseButton projectId={selectedProjectId} onAddPhase={props.actions?.addPhase} />
                 </div>
              </div>
           </div>
        </GlassPanel>

        {/* Phase Notes Markdown Area Mock */}
        <details className="mb-6 group bg-gray-900/40 backdrop-blur-md rounded border border-white/5 overflow-hidden">
           <summary className="p-4 cursor-pointer select-none font-mono text-xs text-gray-400 uppercase tracking-widest flex items-center hover:bg-white/5 transition-colors">
              <PenTool size={14} className="mr-2 text-purple-400" /> Phase Execution Notes <span className="ml-3 text-[9px] text-gray-600 bg-black/50 px-2 py-0.5 rounded border border-white/5 inline-block normal-case tracking-normal">PHASE-README.md</span>
           </summary>
           <div className="p-6 border-t border-white/5 bg-black/20 text-sm text-gray-300 font-sans leading-relaxed prose prose-invert max-w-none">
              <p className="text-gray-500 italic">No phase notes available.</p>
           </div>
        </details>

        {/* Task Breakdown 4-Level Accordion */}
        <ProjectDetailAccordion 
            projectId={selectedProjectId}
            tasks={project.tasks || []} 
            phases={project.phases || []}
            actions={props.actions} 
            onCreateTask={(phaseNum: number) => {
               setActivePhase(phaseNum);
               setTaskModalOpen(true);
            }} 
        />

        <CreateTaskModal 
           open={isTaskModalOpen} 
           onClose={() => setTaskModalOpen(false)} 
           onSubmit={(title, desc) => { 
              props.actions?.createTask(title, desc, selectedProjectId, activePhase || 1); 
           }} 
        />
      </div>
    );
  }

  // --- STANDARD PIPELINE LIST VIEW ---
  return (
    <div className="space-y-6 w-[1500px] animate-in fade-in duration-500 mx-auto">
      <div className="flex justify-between items-center">
        <h2 className="text-xl tracking-widest text-white font-light">PROJECT PIPELINE</h2>
        <button 
           onClick={() => setProjectModalOpen(true)}
           className="bg-cyan-900/40 text-cyan-400 hover:bg-cyan-900/60 border border-cyan-500/30 px-4 py-2 rounded text-[10px] uppercase tracking-widest font-mono transition-colors shadow-inner drop-shadow-sm"
        >
          Initialize Project
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {props.projects?.map((p: ProjectData) => (
          <ProjectCard 
             key={p.id} 
             project={p} 
             onClick={() => setSelectedProjectId(p.id)} 
             onDelete={(id) => props.actions?.deleteProject(id)} 
          />
        ))}
      </div>
      
      {(!props.projects || props.projects.length === 0) && (
        <EmptyState title="No Active Projects" subtitle="Orchestration queue is empty." />
      )}
      <CreateProjectModal open={isProjectModalOpen} onClose={() => setProjectModalOpen(false)} agents={props.agents} onSubmit={(name, desc, reviewer) => props.actions?.createProject(name, desc, reviewer)} />
    </div>
  );
}
