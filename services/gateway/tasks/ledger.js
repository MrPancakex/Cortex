/**
 * Ledger file helpers — pure filesystem I/O for the 7-file ledger schema.
 *
 * Implements the helpers defined in LEDGER-SCHEMA.md §2 for every one of:
 *   project.json, phase.json, task.json, summary.md,
 *   runs.jsonl, verification.json, ledger.jsonl
 *
 * Rules:
 *  - NO DB imports. Pure node:fs + node:path only.
 *  - Reads swallow I/O and parse errors; return null on failure.
 *  - Writes for rewritten files THROW on failure (required for C3 dual-write
 *    contract, §3.1 line 547: an exception inside the transaction body causes
 *    SQLite to roll back both the task mutation and the audit_log insert).
 *  - Append operations also throw on failure (same contract for ledger.jsonl).
 *  - Atomic writes: .tmp + renameSync — prevents torn reads on crash.
 *  - Append-only JSONL: appendFileSync is atomic for writes ≤ PIPE_BUF
 *    (typically 4 KB on Linux) on most local filesystems; no extra
 *    atomicity layer needed for single-line JSON objects of this size.
 */
import path from 'node:path';
import fs from 'node:fs';
import { swallow } from '@cortex/sdk/errors';
import { writeFileAtomic, writeJsonAtomic } from '@cortex/sdk/fs';

// -- internal helpers -------------------------------------------------------

/** Ensure parent directory exists before any write. */
function mkParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o770 });
}

const LEDGER_WRITE_OPTIONS = Object.freeze({
  mode: 0o660,
  dirMode: 0o770,
});
const LEDGER_JSON_WRITE_OPTIONS = Object.freeze({
  ...LEDGER_WRITE_OPTIONS,
  trailingNewline: true,
});

function writeLedgerJson(filePath, value) {
  writeJsonAtomic(filePath, value, LEDGER_JSON_WRITE_OPTIONS);
}

function writeLedgerText(filePath, content) {
  writeFileAtomic(filePath, content, LEDGER_WRITE_OPTIONS);
}

/** Read a file; return raw string or null on any I/O failure. */
function readRaw(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    swallow('ledger.read_failed', err);
    return null;
  }
}

/** Parse JSON string; return object or null on parse failure. */
function parseJson(raw, filePath) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    swallow('ledger.parse_failed', err);
    void filePath; // retain for future debug context
    return null;
  }
}

/** Read and parse a JSON file; return object or null. */
function readJson(filePath) {
  const raw = readRaw(filePath);
  if (raw === null) return null;
  return parseJson(raw, filePath);
}

// -- project.json -----------------------------------------------------------

export function readProjectJson(projectDir) {
  return readJson(path.join(projectDir, 'project.json'));
}

export function writeProjectJson(projectDir, obj) {
  writeLedgerJson(path.join(projectDir, 'project.json'), obj);
}

// -- phase.json -------------------------------------------------------------

export function readPhaseJson(phaseDir) {
  return readJson(path.join(phaseDir, 'phase.json'));
}

export function writePhaseJson(phaseDir, obj) {
  writeLedgerJson(path.join(phaseDir, 'phase.json'), obj);
}

// -- task.json --------------------------------------------------------------

export function readTaskJson(taskDir) {
  return readJson(path.join(taskDir, 'task.json'));
}

export function writeTaskJson(taskDir, obj) {
  writeLedgerJson(path.join(taskDir, 'task.json'), obj);
}

// -- summary.md -------------------------------------------------------------

const SUMMARY_MAX_BYTES = 2048;

export function readSummary(taskDir) {
  return readRaw(path.join(taskDir, 'summary.md'));
}

export function writeSummary(taskDir, markdown) {
  if (Buffer.byteLength(markdown, 'utf8') > SUMMARY_MAX_BYTES) {
    throw new Error('summary_too_large');
  }
  writeLedgerText(path.join(taskDir, 'summary.md'), markdown);
}

// -- runs.jsonl -------------------------------------------------------------

export function appendRun(taskDir, runObject) {
  const filePath = path.join(taskDir, 'runs.jsonl');
  mkParent(filePath);
  fs.appendFileSync(filePath, JSON.stringify(runObject) + '\n');
}

// -- verification.json ------------------------------------------------------

export function readVerification(taskDir) {
  return readJson(path.join(taskDir, 'verification.json'));
}

export function writeVerification(taskDir, obj) {
  writeLedgerJson(path.join(taskDir, 'verification.json'), obj);
}

// -- ledger.jsonl -----------------------------------------------------------

export function appendLedger(projectDir, eventObject) {
  const filePath = path.join(projectDir, 'ledger.jsonl');
  mkParent(filePath);
  fs.appendFileSync(filePath, JSON.stringify(eventObject) + '\n');
}

// -- events.jsonl (per-task) -------------------------------------------------
//
// Plane-transition Phase 1b: the going-forward append target. One JSON object
// per line, byte-for-byte the same shape as the per-project ledger.jsonl line
// (the locked Phase-1a schema: {ts,task_id,project_id,actor,event_type,
// from_status,to_status,data}) so a new transition seamlessly extends the
// events.jsonl that 1a backfilled for the same task. Mirrors appendLedger:
// same atomicity contract (appendFileSync, single-line JSON ≤ PIPE_BUF) and
// the same throw-on-failure semantics so a failed append inside the C3
// dual-write transaction rolls back the whole transition.

export function appendTaskEvents(taskDir, eventObject) {
  const filePath = path.join(taskDir, 'events.jsonl');
  mkParent(filePath);
  fs.appendFileSync(filePath, JSON.stringify(eventObject) + '\n');
}

// -- compensated dual append (Plane-transition Phase 1b rework) --------------
//
// BUG A (findings 2/3/9): the two filesystem appends (ledger.jsonl +
// events.jsonl) live INSIDE the C3 dual-write SQLite transaction, but the
// filesystem is not transactional. If one append throws after the other
// already wrote its line, SQLite rolls back the row / audit / fs_version —
// but the appended line is already on disk and SQLite cannot undo it. That
// phantom one-sided transition breaks the audit↔ledger↔events parity this
// phase exists to protect.
//
// FIX: capture each file's pre-append byte length (or "did not exist") BEFORE
// either append, perform the appends, and if either throws, compensate by
// restoring the touched files back to their captured pre-append byte lengths
// (or unlinking a file that did not exist before) BEFORE rethrowing. The
// rethrow still triggers the SQLite rollback.
//
// R3 STAGED WRITES (R2 #2, reviewer-acked design): the gateway runbook
// expects ledger.jsonl to be chattr +a append-only (composer.js gate.f07), so
// a ledger line can be IMPOSSIBLE to compensate by truncation. Therefore:
//   (a) events.jsonl is appended FIRST — a plain file, always
//       truncate-compensable; the undo-handle mechanism is kept;
//   (b) the ledger.jsonl append is the LAST fallible FILE operation before
//       the SQLite commit — after it, NO task-folder/event filesystem work of
//       any kind happens in any caller (transitions.js / orphan.js append it
//       as the final statement of their transaction; the approved-delete path
//       runs only the DB-only guarded hardDeleteTask after it);
//   (c) restore/compensation failures are NO LONGER swallowed — they raise a
//       hard 'ledger_compensation_failed' error plus a structured recovery
//       line (see restoreLen);
//   (d) the ONLY accepted residue class: ledger line appended + the SQLite
//       commit then fails on an append-only ledger. The boot parity check
//       (reconciler.js step 6 — ledger.jsonl lines vs audit_log rows) detects
//       exactly this class and is the recovery path. Documented in
//       WRITERS-INVENTORY.md §2b. Moving the ledger append post-commit was
//       explicitly rejected in review (it would un-anchor the EVENT from the
//       transaction entirely).
//
// Byte length (not line count) is used deliberately: a torn/partial write of a
// single line is also undone by truncating to the captured length.

/** Capture the current byte length of a file, or null if it does not exist. */
function captureLen(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (err) {
    swallow('ledger.capture_len_missing', err);
    return null; // did not exist
  }
}

/**
 * Restore a file to a captured pre-append state: truncate to len, or unlink
 * if it did not exist before (len === null). No-op when the file already
 * matches the captured state (so a failed append that wrote nothing never
 * triggers a pointless truncate on an append-only file).
 *
 * R3 (R2 #2c): compensation failures are NO LONGER swallowed. When the
 * restore cannot be applied (e.g. ledger.jsonl is chattr +a append-only and
 * truncate throws EPERM), a structured recovery line is logged and a hard
 * 'ledger_compensation_failed' error is thrown — the residue surfaces LOUD
 * at the call site, and the boot parity check (reconciler.js step 6:
 * ledger.jsonl lines vs audit_log rows) is the recovery path that detects it.
 */
function restoreLen(filePath, len) {
  try {
    if (captureLen(filePath) === len) return; // already at pre-append state
    if (len === null) {
      // File did not exist before the append; remove whatever was created.
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      return;
    }
    fs.truncateSync(filePath, len);
  } catch (err) {
    swallow('ledger.compensation_failed', err);
    // Structured recovery/parity line — operators (and the boot parity
    // check) recover from exactly this residue class.
    console.error('[ledger.compensation_failed] ' + JSON.stringify({
      file: filePath,
      restore_to_bytes: len,
      error: err.message,
      code: err.code ?? null,
      recovery: 'boot parity check (reconciler step 6): audit_log rows vs ledger.jsonl lines',
    }));
    const hard = new Error(`ledger_compensation_failed: ${filePath}: ${err.message}`);
    hard.code = 'LEDGER_COMPENSATION_FAILED';
    hard.cause = err;
    throw hard;
  }
}

/**
 * Append the SAME locked-schema line to the per-task events.jsonl and the
 * per-project ledger.jsonl as a compensated, STAGED unit. Either both lines
 * land or neither does (the touched files are restored to their pre-append
 * byte lengths and the error is rethrown so the surrounding SQLite
 * transaction also rolls back).
 *
 * R3 staging (R2 #2): events.jsonl FIRST (plain file, truncate-
 * compensable), ledger.jsonl LAST — the final fallible FILE operation before
 * the SQLite commit. A failure of the events append touches nothing else; a
 * failure of the ledger append restores only what actually changed
 * (restoreLen no-ops on an unchanged file, so an append-only ledger whose
 * append failed cleanly is never pointlessly truncated). Because the ledger
 * append is last, the internal compensation path never has to truncate a
 * SUCCESSFULLY-appended ledger line — only the undo handle (late
 * in-transaction failures) can hit that, where a failure surfaces LOUD
 * (restoreLen throws 'ledger_compensation_failed').
 *
 * Task 120 R1 (findings 2/4): on SUCCESS the function returns an `undo`
 * handle that restores both files to their captured pre-append byte lengths
 * (events first, then ledger — so when the ledger restore is impossible on an
 * append-only file, the residue is exactly the single documented class: the
 * ledger line). Callers whose transaction continues PAST this append (the
 * approved-delete path runs the guarded DB-only hardDeleteTask after it) must
 * hold the handle and invoke it in their outer catch.
 *
 * @param {string}      projectDir  per-project ledger dir (ledger.jsonl lives here)
 * @param {string|null} taskDir     per-task dir (events.jsonl); null → events skipped
 * @param {object}      line        the locked-schema event object
 * @returns {{ undo: () => void }} restore-to-captured-lengths handle (LOUD on
 *          restore failure — throws 'ledger_compensation_failed')
 * @throws rethrows the first append failure AFTER compensating the touched files
 */
export function appendLedgerAndEvents(projectDir, taskDir, line) {
  const ledgerPath = path.join(projectDir, 'ledger.jsonl');
  const eventsPath = taskDir ? path.join(taskDir, 'events.jsonl') : null;
  // Capture pre-append state of BOTH files before touching either.
  const ledgerLen = captureLen(ledgerPath);
  const eventsLen = eventsPath ? captureLen(eventsPath) : null;
  // STAGE 1 — events.jsonl (plain file). A failure here has touched nothing
  // else; restore undoes a possible torn line and the error rethrows into
  // the SQLite rollback.
  if (taskDir) {
    try {
      appendTaskEvents(taskDir, line);
    } catch (err) {
      restoreLen(eventsPath, eventsLen);
      throw err;
    }
  }
  // STAGE 2 — ledger.jsonl: the LAST fallible FILE operation before the
  // SQLite commit. No task-folder/event filesystem work of any kind happens
  // after this append (structural test: ledger.staged-writes.test.js).
  try {
    appendLedger(projectDir, line);
  } catch (err) {
    // The ledger append itself failed — restore in events-FIRST order so the
    // residue class is minimized and predictable even when one restore fails.
    //
    // R4 (R3 #3): restore events.jsonl FIRST (plain file, always
    // truncate-compensable), then attempt ledger restore, and attempt BOTH
    // even if the first restore throws — collect both sub-errors and include
    // them in the loud final throw. Ordering rationale: if the ledger restore
    // fails (append-only/EPERM), the ONLY residue is the ledger line (the
    // single accepted residue class). Restoring events first ensures no
    // events.jsonl line is left dangling when the ledger restore is impossible.
    let eventsRestoreErr = null;
    let ledgerRestoreErr = null;
    if (eventsPath) {
      try {
        restoreLen(eventsPath, eventsLen);
      } catch (restoreErr) {
        eventsRestoreErr = restoreErr;
      }
    }
    try {
      restoreLen(ledgerPath, ledgerLen);
    } catch (restoreErr) {
      ledgerRestoreErr = restoreErr;
    }
    // If either restore failed, prefer the compensation error (LOUD) so the
    // operator sees recovery is required; include the original append error
    // and any events-restore sub-error in the thrown object.
    const compErr = ledgerRestoreErr || eventsRestoreErr;
    if (compErr) {
      compErr.appendErr = err;
      if (eventsRestoreErr && compErr !== eventsRestoreErr) {
        compErr.eventsRestoreErr = eventsRestoreErr;
      }
      throw compErr;
    }
    throw err;
  }
  return {
    undo: () => {
      // Mirror the ledger-append catch path: attempt BOTH restores
      // independently (events first), collect sub-errors, and throw ONE
      // loud structured compensation error only AFTER both are attempted.
      // This prevents the ledger restore from being silently skipped when
      // the events restore throws (leaving BOTH files with residue).
      //
      // R5 (R4 undo-handle): same dual-independent-restore + collect
      // + loud-throw logic as the catch path above (~:316-341).
      let eventsRestoreErr = null;
      let ledgerRestoreErr = null;
      if (eventsPath) {
        try {
          restoreLen(eventsPath, eventsLen);
        } catch (restoreErr) {
          eventsRestoreErr = restoreErr;
        }
      }
      try {
        restoreLen(ledgerPath, ledgerLen);
      } catch (restoreErr) {
        ledgerRestoreErr = restoreErr;
      }
      // Prefer the ledger compensation error (LOUD) as the primary; attach
      // both sub-errors to the thrown object — same shape as the catch path.
      const compErr = ledgerRestoreErr || eventsRestoreErr;
      if (compErr) {
        if (eventsRestoreErr && compErr !== eventsRestoreErr) {
          compErr.eventsRestoreErr = eventsRestoreErr;
        }
        if (ledgerRestoreErr && compErr !== ledgerRestoreErr) {
          compErr.ledgerRestoreErr = ledgerRestoreErr;
        }
        throw compErr;
      }
    },
  };
}
