import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { GlassPanel } from './Primitives';

const CustomSelect = ({ value, onChange, options, placeholder, accentColor = 'cyan' }: any) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption = options.find((o: any) => o.value === value);
  
  const accentHex = accentColor === 'purple' ? 'border-purple-500/50 text-purple-400 bg-purple-900/10' : 'border-cyan-500/50 text-cyan-400 bg-cyan-900/10';
  const accentText = accentColor === 'purple' ? 'text-purple-400' : 'text-cyan-400';
  const accentHover = accentColor === 'purple' ? 'hover:bg-purple-500/10 hover:text-purple-400' : 'hover:bg-cyan-500/10 hover:text-cyan-400';
  const accentActive = accentColor === 'purple' ? 'bg-purple-500/10 text-purple-400' : 'bg-cyan-500/10 text-cyan-400';

  return (
    <div className="relative">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white flex justify-between items-center outline-none transition-all duration-200 ${isOpen ? accentHex : 'hover:border-white/20'}`}
      >
        <span className={selectedOption ? 'text-white' : 'text-gray-500'}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown size={14} className={`shrink-0 ml-2 text-gray-500 transition-transform duration-200 ${isOpen ? 'rotate-180 ' + accentText : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>
          <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[#0d1117] border border-white/10 rounded shadow-[0_10px_40px_rgba(0,0,0,0.8)] max-h-48 overflow-y-auto custom-scrollbar animate-in fade-in zoom-in-95 duration-200 scrollbar-thin scrollbar-thumb-white/10">
            {options.map((option: any) => (
              <button
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-4 py-2 text-sm transition-colors ${accentHover} ${value === option.value ? accentActive : 'text-gray-300'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export const Modal = ({ open, onClose, title, children }: any) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <GlassPanel className="w-full max-w-lg p-6 border-white/10 shadow-2xl relative bg-gray-900 border-t-2 border-t-cyan-500">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-cyan-900/10 via-transparent to-transparent pointer-events-none"></div>
        <div className="flex justify-between items-center mb-6 relative z-10 border-b border-white/10 pb-4">
          <h2 className={`text-sm tracking-widest text-white uppercase font-light drop-shadow-md`}>{title}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors"><X size={18} /></button>
        </div>
        <div className="relative z-10">
          {children}
        </div>
      </GlassPanel>
    </div>
  );
};

export const CreateProjectModal = ({ open, onClose, onSubmit, agents }: { open: boolean; onClose: () => void, onSubmit?: (name: string, desc: string, reviewer?: string) => void, agents?: {name: string}[] }) => {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [reviewer, setReviewer] = useState('');

  const reviewerOptions = [
    { value: '', label: 'None (assign per task)' },
    ...(agents || []).map(a => ({ value: a.name.toLowerCase(), label: a.name }))
  ];

  return (
    <Modal open={open} onClose={onClose} title="INITIALIZE PROJECT PIPELINE">
      <div className="space-y-4">
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Project Name</label>
          <input type="text" value={name} onChange={e=>setName(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-cyan-500/50 outline-none transition-colors" placeholder="e.g. Q4 Architectural Review" />
        </div>
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Description</label>
          <input type="text" value={desc} onChange={e=>setDesc(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-cyan-500/50 outline-none transition-colors" placeholder="Scope description" />
        </div>
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Default Reviewer</label>
          <CustomSelect 
            value={reviewer} 
            onChange={setReviewer} 
            options={reviewerOptions} 
            placeholder="Select reviewer..." 
          />
        </div>
        <div className="pt-4 flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-[10px] font-mono uppercase tracking-widest text-gray-500 hover:text-white transition-colors">Cancel</button>
          <button onClick={() => { onSubmit?.(name, desc, reviewer || undefined); onClose(); }} className="px-6 py-2 rounded text-[10px] font-mono uppercase tracking-widest bg-cyan-900/40 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-900/60 transition-colors shadow-[0_0_15px_rgba(8,145,178,0.2)]">Execute</button>
        </div>
      </div>
    </Modal>
  );
};

export const CreateTaskModal = ({ open, onClose, onSubmit }: { open: boolean; onClose: () => void, onSubmit?: (title: string, desc: string) => void }) => {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [node, setNode] = useState('Atlas (Opus 4.6)');
  const [reviewer, setReviewer] = useState('HUMAN (Gateway Pause)');

  const nodeOptions = [
    { value: 'Atlas (Opus 4.6)', label: 'Atlas (Opus 4.6)' },
    { value: 'Zeus (GPT-5.4)', label: 'Zeus (GPT-5.4)' },
    { value: 'Gerald (Sonnet 4.6)', label: 'Gerald (Sonnet 4.6)' },
    { value: 'Faust (Hermes)', label: 'Faust (Hermes)' },
  ];

  const reviewerOptions = [
    { value: 'HUMAN (Gateway Pause)', label: 'HUMAN (Gateway Pause)' },
    { value: 'AUTONOMOUS (No Block)', label: 'AUTONOMOUS (No Block)' },
  ];

  return (
    <Modal open={open} onClose={onClose} title="DEFINE TASK DIRECTIVE">
      <div className="space-y-4">
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Task Title</label>
          <input type="text" value={title} onChange={e=>setTitle(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-purple-500/50 outline-none transition-colors" placeholder="e.g. Refactor Authorization Middleware" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Assign Node</label>
            <CustomSelect 
              value={node} 
              onChange={setNode} 
              options={nodeOptions} 
              accentColor="purple"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Reviewer</label>
            <CustomSelect 
              value={reviewer} 
              onChange={setReviewer} 
              options={reviewerOptions} 
              accentColor="purple"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Directive Context</label>
          <textarea rows={3} value={desc} onChange={e=>setDesc(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-purple-500/50 outline-none transition-colors" placeholder="Provide system prompt overrides..."></textarea>
        </div>
        <div className="pt-4 flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-[10px] font-mono uppercase tracking-widest text-gray-500 hover:text-white transition-colors">Abort</button>
          <button onClick={() => { onSubmit?.(title, desc); onClose(); }} className="px-6 py-2 rounded text-[10px] font-mono uppercase tracking-widest bg-purple-900/40 text-purple-400 border border-purple-500/30 hover:bg-purple-900/60 transition-colors shadow-[0_0_15px_rgba(168,85,247,0.2)]">Dispatch</button>
        </div>
      </div>
    </Modal>
  );
};
