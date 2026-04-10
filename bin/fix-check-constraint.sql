BEGIN;

CREATE TABLE cortex_tasks_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','claimed','in_progress','submitted','review','approved','rejected','cancelled','failed')),
  assigned_agent TEXT,
  assigned_platform TEXT,
  claimed_at INTEGER,
  submitted_at INTEGER,
  verified_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  result_summary TEXT,
  reviewer_agent TEXT,
  review_feedback TEXT,
  source TEXT DEFAULT 'human',
  created_by TEXT,
  project_id TEXT,
  priority TEXT DEFAULT 'medium',
  tags TEXT DEFAULT '[]',
  approved_at INTEGER,
  rejected_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  cancelled_by TEXT,
  updated_at INTEGER DEFAULT (unixepoch()),
  phase_number INTEGER DEFAULT 1,
  rejection_count INTEGER DEFAULT 0
);

INSERT INTO cortex_tasks_new SELECT * FROM cortex_tasks;
DROP TABLE cortex_tasks;
ALTER TABLE cortex_tasks_new RENAME TO cortex_tasks;
CREATE INDEX IF NOT EXISTS idx_cortex_tasks_status ON cortex_tasks(status);
CREATE INDEX IF NOT EXISTS idx_cortex_tasks_platform ON cortex_tasks(assigned_platform, status);

COMMIT;
