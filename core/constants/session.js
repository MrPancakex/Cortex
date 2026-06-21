/**
 * Session lease + poison-sweep tunables. Live here so the reaper and the
 * session module agree on timing without a cross-import.
 *
 * POISON_SWEEP_MS is the *reaper cadence* — how often the background
 * session reaper runs its pass. LEASE_POISON_MAX_AGE_MS is the distinct
 * *age threshold* at which an unparseable lease file is classified as
 * crashed-writer debris and swept. The threshold is deliberately set
 * 2× the reaper cadence so a lease written mid-sweep isn't mistaken
 * for debris on the next pass.
 */
export const POISON_SWEEP_MS = 30_000;           // reaper interval
export const LEASE_POISON_MAX_AGE_MS = 60_000;   // unparseable-lease debris threshold
export const LEASE_DEFAULT_MS = 120_000;         // 2 min initial lease
export const LEASE_MAX_MS = 15 * 60_000;         // 15 min ceiling
export const LEASE_SUFFIX = '.lease';            // filesystem lease marker
export const HEARTBEAT_GRACE_MS = 90_000;        // missed-HB → stale
export const STALE_TO_ORPHAN_MS = 10 * 60_000;   // stale → orphaned after 10 min

export const SESSION_DEFAULTS = Object.freeze({
  poison_sweep_ms: POISON_SWEEP_MS,
  lease_poison_max_age_ms: LEASE_POISON_MAX_AGE_MS,
  lease_default_ms: LEASE_DEFAULT_MS,
  lease_max_ms: LEASE_MAX_MS,
  heartbeat_grace_ms: HEARTBEAT_GRACE_MS,
  stale_to_orphan_ms: STALE_TO_ORPHAN_MS,
});
