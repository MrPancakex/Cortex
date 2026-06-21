// TypeScript shim for shared/constants.js so the frontend can import the
// enum tables with strict type info. Phase 3 may replace this with a
// full .ts source once the schema layer lands.

export const PORTS: {
  readonly BACKEND: number;
  readonly GATEWAY: number;
  readonly WEBSOCKET: number;
};

export const SYSTEM: {
  readonly VERSION: string;
};

export const STATUS: {
  readonly PENDING: 'pending';
  readonly CLAIMED: 'claimed';
  readonly IN_PROGRESS: 'in_progress';
  readonly SUBMITTED: 'submitted';
  readonly REVIEW: 'review';
  readonly APPROVED: 'approved';
  readonly REJECTED: 'rejected';
  readonly FAILED: 'failed';
  readonly CANCELLED: 'cancelled';
};

/**
 * Canonical task status tuple — must stay aligned with
 * `core/schemas/task.js TaskStatusSchema` (the SSOT).
 * Includes 'orphaned' (Phase 5 session-reaper state).
 */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'submitted'
  | 'review'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'orphaned';

export const TASK_STATUSES: readonly [
  'pending',
  'claimed',
  'in_progress',
  'submitted',
  'review',
  'approved',
  'rejected',
  'cancelled',
  'failed',
  'orphaned',
];

export const AGENT_STATUSES: readonly ['ACTIVE', 'IDLE', 'OFFLINE'];
