import type { z } from 'zod';
import type { ProgressStatusSchema, ProgressReportSchema } from '../schemas/progress.js';

export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;
export type ProgressReport = z.infer<typeof ProgressReportSchema>;
