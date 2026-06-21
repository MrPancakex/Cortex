import type { z } from 'zod';
import type { BridgeSendSchema, BridgeInboxSchema } from '../schemas/bridge.js';

export type BridgeSend = z.infer<typeof BridgeSendSchema>;
export type BridgeInbox = z.infer<typeof BridgeInboxSchema>;
export type BridgeKind = BridgeSend['kind'];
