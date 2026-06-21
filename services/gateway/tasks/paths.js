/**
 * Path helpers for the tasks plane's on-disk folder mirror.
 *
 * Each Cortex project has a workspace directory on disk (`.../projects/<slug>/`)
 * containing `tasks/phase-<n>/<task-folder>/` trees the agent actually edits.
 * The DB row is authoritative — this mirror is a convenience for humans
 * browsing with `ls` + for the README render pipeline. All I/O from the
 * lifecycle helpers flows through swallow() so a missing / read-only
 * workspace never blocks a state transition.
 *
 * Lifted from legacy lib/task-files.js and trimmed to the functions Phase 5
 * actually needs. `resolveProjectsRoot` itself lives in @cortex/core/constants
 * so the CLI + installers share the same precedence rules.
 */
import { resolveProjectsRoot as coreResolveProjectsRoot } from '@cortex/core/constants';

export function resolveProjectsRoot() {
  return coreResolveProjectsRoot();
}

/**
 * Turn a free-form project name into a filesystem-safe slug. Lowercase,
 * strip non-[a-z0-9] to hyphens, collapse repeats, trim edges. Safe for
 * `mkdir` on every platform (no spaces, no traversal). Empty inputs return
 * `unnamed` so path joins never produce a bare separator.
 *
 * Hard-capped at 80 chars — long titles are truncated, not erroring-out,
 * because the DB title is authoritative; the folder is just a convenience.
 */
export function slugify(input) {
  if (input == null) return 'unnamed';
  const s = String(input).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 80) : 'unnamed';
}

/**
 * Sanitise a title for human-facing folder use. Replaces the filesystem-
 * forbidden chars (Windows/macOS/Linux intersection: < > : " / \\ | ? *)
 * with a dash, then collapses whitespace. Preserves mixed case + spaces so
 * the rendered folder still reads like a title.
 *
 * Rejects traversal segments by construction: the forbidden-char class
 * strips `/` and `\\`, and leading-`.` is preserved — callers that care
 * about `.. / absolute path` escapes assemble with path.basename() before
 * joining.
 */
export function sanitiseTitleForFolder(title) {
  const cleaned = String(title || 'untitled')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'untitled';
}
