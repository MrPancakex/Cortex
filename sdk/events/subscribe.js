/**
 * Public subscribe() wrapper over the bus. Exists as its own file so
 * consumers can reason about the subscription API in isolation from the
 * bus internals, and so transports (transport-ws / transport-cursor)
 * have a stable entry point.
 */

import { bus } from './bus.js';

/**
 * @param {string} subjectGlob  exact subject, `namespace.*`, or `*`
 * @param {(event: unknown) => void | Promise<void>} handler
 * @param {{ maxQueue?: number, id?: string }} [opts]
 * @returns {() => void}  unsubscribe function
 */
export function subscribe(subjectGlob, handler, opts = {}) {
  return bus.register(subjectGlob, handler, opts);
}
