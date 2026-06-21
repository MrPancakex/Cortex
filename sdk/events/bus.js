/**
 * In-process pub/sub bus. `publish(event)` fans out to every subscription
 * whose subject-glob matches the event's subject. Each subscription owns
 * its own bounded delivery queue drained on a microtask — a slow handler
 * does NOT block fan-out to other subscribers, and a handler that throws
 * is isolated by a swallow() so one bad consumer cannot silence the bus.
 *
 * Subject glob matching (narrow by design — broader patterns add
 * complexity without obvious use cases today):
 *   - `"task.claimed"` matches exactly that subject
 *   - `"task.*"` matches every subject under the `task` namespace
 *   - `"*"` matches everything (audit-style consumers)
 *
 * Queue-full policy: drop the incoming event and bump the subscriber's
 * overflow counter (via sdk/events/overflow.js). Dropping rather than
 * blocking is intentional — back-pressuring the emitter would tie the
 * stability of the entire system to the slowest consumer.
 */

import { randomUUID } from 'node:crypto';
import { swallow } from '../errors/index.js';
import { bumpOverflow } from './overflow.js';

const DEFAULT_MAX_QUEUE = 1000;

function matchesGlob(glob, subject) {
  if (glob === '*' || glob === subject) return true;
  if (glob.endsWith('.*')) {
    const namespace = glob.slice(0, -2);
    return subject.startsWith(`${namespace}.`);
  }
  return false;
}

export class Bus {
  #subscribers = new Map();

  /**
   * @param {string} subjectGlob
   * @param {(event: unknown) => void | Promise<void>} handler
   * @param {{ maxQueue?: number, id?: string }} [opts]
   * @returns {() => void}  unsubscribe
   */
  register(subjectGlob, handler, opts = {}) {
    if (typeof subjectGlob !== 'string' || subjectGlob.length === 0) {
      throw new Error('Bus.register: subjectGlob must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error('Bus.register: handler must be a function');
    }
    const id = opts.id || randomUUID();
    const sub = {
      id,
      subjectGlob,
      handler,
      queue: [],
      maxQueue: opts.maxQueue ?? DEFAULT_MAX_QUEUE,
      draining: false,
    };
    this.#subscribers.set(id, sub);
    return () => this.#subscribers.delete(id);
  }

  publish(event) {
    if (!event || typeof event.subject !== 'string') return;
    for (const sub of this.#subscribers.values()) {
      if (!matchesGlob(sub.subjectGlob, event.subject)) continue;
      if (sub.queue.length >= sub.maxQueue) {
        bumpOverflow(sub.id);
        continue;
      }
      sub.queue.push(event);
      this.#scheduleDrain(sub);
    }
  }

  #scheduleDrain(sub) {
    if (sub.draining) return;
    sub.draining = true;
    queueMicrotask(() => this.#drainLoop(sub));
  }

  // Serial await per subscriber is deliberate: it preserves event order
  // the subscriber registered for, honors genuinely async handlers
  // (handler returning a Promise MUST resolve before the next event is
  // delivered), and avoids starving the event loop with a synchronous
  // drain-all-at-once. If a future profiler shows we're bound on
  // microtask hops, swap to batched-sync here — handler-as-sync is the
  // common case and N events could be drained per microtask.
  async #drainLoop(sub) {
    while (sub.queue.length > 0) {
      const event = sub.queue.shift();
      try {
        await sub.handler(event);
      } catch (err) {
        swallow('events.handler_failed', err);
      }
    }
    sub.draining = false;
  }

  subscriberCount() {
    return this.#subscribers.size;
  }

  /**
   * Returns a promise that resolves once every subscriber's in-flight
   * queue has drained. Intended for tests that previously used
   * `await new Promise((r) => setTimeout(r, 20))` between emit and
   * assertion (ultrareview lens 7 T2). Waiting a fixed 20ms is flaky
   * under CI load; this helper keeps polling microtasks until every
   * subscriber reports `draining === false` with an empty queue.
   *
   * Bounded by `maxIters` (default 200 microtask hops) so a stuck
   * subscriber cannot hang a test indefinitely.
   */
  async drainAll({ maxIters = 200 } = {}) {
    for (let i = 0; i < maxIters; i += 1) {
      let pending = false;
      for (const sub of this.#subscribers.values()) {
        if (sub.queue.length > 0 || sub.draining) {
          pending = true;
          break;
        }
      }
      if (!pending) return;
      await new Promise((r) => queueMicrotask(r));
    }
  }

  _clearForTests() {
    this.#subscribers.clear();
  }
}

// Module-scoped singleton so emit() and subscribe() share a fan-out.
export const bus = new Bus();
