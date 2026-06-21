// Progress report schema for mid-task updates.
// `status` matches the ProgressReports table's allowed values; any change
// here MUST be reflected in the DB CHECK constraint and vice-versa.
import { z } from 'zod';

export const ProgressStatusSchema = z.enum([
  'planning',
  'implementation',
  'in_progress',
  'testing',
  'reviewing',
]);

export const ProgressReportSchema = z.object({
  task_id: z.string().uuid(),
  status: ProgressStatusSchema,
  summary: z.string().min(1).max(4000),
  files_changed: z.array(z.string()).max(1024).optional(),
});
