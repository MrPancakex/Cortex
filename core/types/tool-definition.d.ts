import type { z } from 'zod';
import type { ToolDefinitionSchema } from '../schemas/tool-definition.js';

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolPermission = ToolDefinition['permission'];
