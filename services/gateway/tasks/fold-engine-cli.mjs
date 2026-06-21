#!/usr/bin/env bun
/**
 * fold-engine-cli.mjs — CLI entry for the Phase-2 fold engine
 * (phase2-fold-engine-spec.md §2/§6; runbook phase2-gate-runbook.md).
 *
 * Usage:
 *   bun fold-engine-cli.mjs \
 *     --baseline <tasks-dump.json> \
 *     --projects-root <dir> \
 *     --report <out-prefix> \
 *     [--exempt-corrupt <ids,csv>] \
 *     [--allow-stale <ids,csv>] \
 *     [--now <ISO ts>]            (freeze-time for the A5 lease assertion;
 *                                  defaults to the current time)
 *
 * Writes <out-prefix>.json + <out-prefix>.md and prints, as the FINAL stdout
 * line, EXACTLY:
 *   GATE: tasks=<n> match=<n> drift=<n> exempt=<n> out_of_scope=<n> hard_errors=<n>
 *
 * Exempt + stale sets are EXPLICIT ID ALLOWLISTS (signed A4 — enumerated
 * task ids, never patterns). --exempt-corrupt DEFAULTS to the 3 known
 * corrupt rows (DEFAULT_EXEMPT_CORRUPT in fold-engine.js):
 *   aaaaaaaa-0000-0000-0000-000000000001
 *   bbbbbbbb-0000-0000-0000-000000000002
 *   cccccccc-0000-0000-0000-000000000003
 * Passing --exempt-corrupt REPLACES the defaults (pass an empty value to
 * exempt nothing). --allow-stale defaults to the empty list.
 *
 * Exit code: 0 ⇔ gate green (drift=0 AND hard_errors=0 per signed A3, AND
 * no active leases in the baseline per signed A5); 1 otherwise. The engine
 * itself is READ-ONLY — the only writes this process performs are the two
 * report files.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { foldAll, DEFAULT_EXEMPT_CORRUPT } from './fold-engine.js';

function usageDie(msg) {
  console.error(`fold-engine-cli: ${msg}`);
  console.error(
    'usage: fold-engine-cli.mjs --baseline <tasks-dump.json> --projects-root <dir> '
    + '--report <out-prefix> [--exempt-corrupt <ids,csv>] [--allow-stale <ids,csv>] [--now <ISO ts>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) usageDie(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (!['baseline', 'projects-root', 'report', 'exempt-corrupt', 'allow-stale', 'now'].includes(key)) {
      usageDie(`unknown flag: ${a}`);
    }
    const val = argv[i + 1];
    if (val === undefined) usageDie(`missing value for ${a}`);
    args[key] = val;
    i += 1;
  }
  return args;
}

function csvIds(v) {
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function mdEscape(v) {
  return String(v ?? 'null').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 200);
}

function renderMd(report) {
  const t = report.totals;
  const lines = [];
  lines.push('# Phase-2 fold report');
  lines.push('');
  lines.push(`- generated_at: ${report.generated_at}`);
  lines.push(`- projects_root: ${report.projects_root}`);
  lines.push(`- baseline rows: ${report.baseline_count} · disk task folders: ${report.disk_count}`);
  lines.push(`- gate_green: **${report.gate_green}** (green ⇔ drift=0 AND hard_errors=0 [A3] AND no active leases [A5])`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`| tasks | match | drift | exempt | out_of_scope | hard_errors |`);
  lines.push(`|---|---|---|---|---|---|`);
  lines.push(`| ${t.tasks} | ${t.match} | ${t.drift} | ${t.exempt} | ${t.out_of_scope} | ${t.hard_errors} |`);
  lines.push('');
  lines.push('## Pre-declared dispositions (§5 — carried in, never discovered)');
  lines.push('');
  for (const note of report.disposition_notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push(`## Allowlists (explicit ids — signed A4)`);
  lines.push('');
  lines.push(`- exempt-corrupt (${report.allowlists.exempt_corrupt.length}): ${report.allowlists.exempt_corrupt.join(', ') || '(none)'}`);
  lines.push(`- allow-stale (${report.allowlists.allow_stale.length}): ${report.allowlists.allow_stale.join(', ') || '(none)'}`);
  lines.push('');

  lines.push(`## DRIFT (${report.drifts.length})`);
  lines.push('');
  if (report.drifts.length === 0) {
    lines.push('None.');
  } else {
    for (const d of report.drifts) {
      lines.push(`### ${d.id} — ${mdEscape(d.title)}`);
      lines.push('');
      lines.push('| field | fold value | baseline value |');
      lines.push('|---|---|---|');
      for (const f of d.fields) {
        lines.push(`| ${f.field} | ${mdEscape(f.fold_value)} | ${mdEscape(f.baseline_value)} |`);
      }
      lines.push('');
    }
  }

  lines.push(`## HARD ERRORS (${report.hard_errors.length}) — gate-blocking (signed A3)`);
  lines.push('');
  if (report.hard_errors.length === 0) {
    lines.push('None.');
  } else {
    for (const h of report.hard_errors) {
      lines.push(`- ${h.id ?? '(no id)'} — \`${h.code}\` ${mdEscape(JSON.stringify(h.detail))}`);
    }
  }
  lines.push('');

  lines.push(`## ACTIVE LEASE ASSERTIONS (${report.active_lease_assertions.length}) — gate-blocking (signed A5)`);
  lines.push('');
  if (report.active_lease_assertions.length === 0) {
    lines.push('None — no active (unexpired) leases in the baseline.');
  } else {
    for (const l of report.active_lease_assertions) {
      lines.push(`- ${l.id} — lease_expires_at=${l.lease_expires_at} — ${l.disposition}`);
    }
  }
  lines.push('');

  lines.push(`## EXEMPT (${report.exempts.length})`);
  lines.push('');
  if (report.exempts.length === 0) {
    lines.push('None.');
  } else {
    for (const e of report.exempts) {
      lines.push(`- ${e.id} — ${e.reason} — ${e.note}`);
      if (e.impossible_fields) {
        lines.push(`  - impossible fields: \`${JSON.stringify(e.impossible_fields)}\``);
      }
      if (e.fields) {
        for (const f of e.fields) {
          lines.push(`  - ${f.field}: fold=${mdEscape(f.fold_value)} baseline=${mdEscape(f.baseline_value)}`);
        }
      }
    }
  }
  lines.push('');

  lines.push(`## OUT-OF-SCOPE (${report.out_of_scope.length})`);
  lines.push('');
  const cutover = report.out_of_scope.filter((o) => o.reason === 'cutover_excluded');
  const orphans = report.out_of_scope.filter((o) => o.reason === 'db_only_orphan');
  lines.push(`### cutover_excluded (${cutover.length})`);
  for (const o of cutover) lines.push(`- ${o.id} — ${mdEscape(o.title)}`);
  lines.push('');
  lines.push(`### db_only_orphan (${orphans.length}) — reconciler Case-C policy: report, never delete`);
  for (const o of orphans) lines.push(`- ${o.id} — ${mdEscape(o.title)}`);
  lines.push('');

  lines.push(`## FS-ONLY tasks (${report.fs_only.length}) — on disk, absent from the baseline (parity note)`);
  lines.push('');
  if (report.fs_only.length === 0) {
    lines.push('None.');
  } else {
    for (const f of report.fs_only) lines.push(`- ${f.id} — ${f.project} — ${f.taskDir}`);
  }
  lines.push('');

  lines.push(`## MATCH (${report.matches.length})`);
  lines.push('');
  for (const m of report.matches) lines.push(`- ${m.id} (${m.events} events)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('```');
  lines.push(report.gate_line);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseline) usageDie('--baseline is required');
  if (!args['projects-root']) usageDie('--projects-root is required');
  if (!args.report) usageDie('--report is required');

  const baselinePath = path.resolve(args.baseline);
  const projectsRoot = path.resolve(args['projects-root']);
  const reportPrefix = path.resolve(args.report);

  let baselineRows;
  try {
    baselineRows = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    console.error(`fold-engine-cli: cannot read baseline ${baselinePath}: ${err.message}`);
    process.exit(2);
  }
  if (!Array.isArray(baselineRows)) {
    console.error('fold-engine-cli: baseline is not a JSON array of task rows');
    process.exit(2);
  }

  const exemptCorrupt = args['exempt-corrupt'] !== undefined
    ? csvIds(args['exempt-corrupt'])
    : [...DEFAULT_EXEMPT_CORRUPT]; // defaults — the 3 known corrupt rows (see header)
  const allowStale = args['allow-stale'] !== undefined ? csvIds(args['allow-stale']) : [];

  const report = foldAll(projectsRoot, baselineRows, {
    exemptCorrupt,
    allowStale,
    ...(args.now !== undefined ? { now: args.now } : {}),
  });

  fs.writeFileSync(`${reportPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${reportPrefix}.md`, renderMd(report));

  console.log(`report written: ${reportPrefix}.json + ${reportPrefix}.md`);
  if (report.active_lease_assertions.length > 0) {
    console.log(`WARNING: ${report.active_lease_assertions.length} ACTIVE lease(s) in baseline — gate-blocking (A5)`);
  }
  // FINAL stdout line — EXACT format (spec §6 + A3 hard_errors term).
  console.log(report.gate_line);
  process.exit(report.gate_green ? 0 : 1);
}

main();
