import { useState } from 'react';
import { Modal, CustomSelect } from './Primitives';

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

export interface CreateTaskFields {
  title: string;
  desc: string;
  section?: string;
  node?: string;
  reviewer?: string;
  priority?: string;
}

export const CreateTaskModal = ({ open, onClose, onSubmit }: { open: boolean; onClose: () => void, onSubmit?: (fields: CreateTaskFields) => void }) => {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [section, setSection] = useState('');
  const [node, setNode] = useState('nova');
  const [reviewer, setReviewer] = useState('human');
  const [priority, setPriority] = useState('normal');

  // Values are lowercase identifiers the gateway accepts; labels stay
  // human-readable for the UI.
  const nodeOptions = [
    { value: 'nova', label: 'Nova (Opus 4.6)' },
    { value: 'scout', label: 'Scout (GPT-5.4)' },
    { value: 'orion', label: 'Orion (Sonnet 4.6)' },
    { value: 'pioneer', label: 'Pioneer (Hermes)' },
  ];

  const reviewerOptions = [
    { value: 'human', label: 'HUMAN (Gateway Pause)' },
    { value: 'autonomous', label: 'AUTONOMOUS (No Block)' },
    { value: 'scout', label: 'Scout (reviewer)' },
    { value: 'nova', label: 'Nova (reviewer)' },
  ];

  const priorityOptions = [
    { value: 'low', label: 'Low' },
    { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'High' },
    { value: 'critical', label: 'Critical' },
  ];

  return (
    <Modal open={open} onClose={onClose} title="DEFINE TASK DIRECTIVE">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Task Title</label>
            <input type="text" value={title} onChange={e=>setTitle(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-purple-500/50 outline-none transition-colors" placeholder="e.g. Refactor Auth" />
          </div>
          <div>
            <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Section (Optional)</label>
            <input type="text" value={section} onChange={e=>setSection(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-purple-500/50 outline-none transition-colors" placeholder="e.g. Database Setup" />
          </div>
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
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Priority</label>
          <CustomSelect
            value={priority}
            onChange={setPriority}
            options={priorityOptions}
            accentColor="purple"
          />
        </div>
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Directive Context</label>
          <textarea rows={3} value={desc} onChange={e=>setDesc(e.target.value)} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-purple-500/50 outline-none transition-colors" placeholder="Provide system prompt overrides..."></textarea>
        </div>
        <div className="pt-4 flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-[10px] font-mono uppercase tracking-widest text-gray-500 hover:text-white transition-colors">Abort</button>
          <button
            onClick={() => {
              onSubmit?.({ title, desc, section: section || undefined, node: node || undefined, reviewer: reviewer || undefined, priority: priority || undefined });
              // Reset state so the next open starts clean instead of
              // inheriting stale selections from a previous task.
              setTitle('');
              setDesc('');
              setSection('');
              onClose();
            }}
            className="px-6 py-2 rounded text-[10px] font-mono uppercase tracking-widest bg-purple-900/40 text-purple-400 border border-purple-500/30 hover:bg-purple-900/60 transition-colors shadow-[0_0_15px_rgba(168,85,247,0.2)]"
          >Dispatch</button>
        </div>
      </div>
    </Modal>
  );
};

export const CreateSectionModal = ({ open, onClose, onSubmit }: { open: boolean; onClose: () => void, onSubmit?: (name: string) => void }) => {
  const [name, setName] = useState('');

  return (
    <Modal open={open} onClose={onClose} title="DEFINE NEW SECTION">
      <div className="space-y-4">
        <div>
          <label className="block text-[10px] font-mono tracking-widest text-gray-500 uppercase mb-2">Section Name</label>
          <input type="text" value={name} onChange={e=>setName(e.target.value)} onKeyDown={(e) => { if(e.key === 'Enter') { onSubmit?.(name); setName(''); onClose(); } }} className="w-full bg-black/50 border border-white/10 rounded px-4 py-2 text-sm text-white focus:border-purple-500/50 outline-none transition-colors" placeholder="e.g. Database Refactor" autoFocus />
        </div>
        <div className="pt-4 flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-[10px] font-mono uppercase tracking-widest text-gray-500 hover:text-white transition-colors">Abort</button>
          <button onClick={() => { onSubmit?.(name); setName(''); onClose(); }} className="px-6 py-2 rounded text-[10px] font-mono uppercase tracking-widest bg-purple-900/40 text-purple-400 border border-purple-500/30 hover:bg-purple-900/60 transition-colors shadow-[0_0_15px_rgba(168,85,247,0.2)]">Execute</button>
        </div>
      </div>
    </Modal>
  );
};
