import type { z } from 'zod';
import type {
  PluginManifestSchema,
  PluginKindSchema,
  PluginRuntimeSchema,
} from '../schemas/plugin-manifest.js';

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginKind = z.infer<typeof PluginKindSchema>;
export type PluginRuntime = z.infer<typeof PluginRuntimeSchema>;
