/**
 * provider.* event payload schemas. Provider registry changes.
 */
import { z } from 'zod';

// ISO datetime string — provider registry uses ISO timestamps for loaded_at
// because it is set externally by the registry loader (not the event bus epoch).
const IsoDateSchema = z.string().datetime();

export const ProviderRegistryReloadedSchema = z.object({
  provider_count: z.number().int().nonnegative(),
  // `profile` is an opaque string identifier for the provider profile/config
  // name (e.g. "openai-gpt4o", "codex-cli-default"). The full profile object
  // lives in the registry; this field is a lightweight reference only.
  providers: z.array(
    z.object({
      id: z.string().min(1),
      profile: z.string().min(1),
    }).strict(),
  ),
  loaded_at: IsoDateSchema,
  last_error: z.string().nullable(),
}).strict();

export const ProviderEventPayloadMap = {
  'provider.registry_reloaded': ProviderRegistryReloadedSchema,
};
