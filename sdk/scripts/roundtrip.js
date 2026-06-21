#!/usr/bin/env bun
/**
 * Phase 2 build-time smoke. Imports every sub-module barrel under sdk/ to
 * prove the module graph resolves cleanly. Does NOT open the DB (that's a
 * runtime concern — a separate smoke test covers migrations).
 */
import * as sdk from '../index.js';
import * as errors from '../errors/index.js';
import * as fsmod from '../fs/index.js';
import * as http from '../http/index.js';
import * as logging from '../logging/index.js';
import * as socket from '../socket/index.js';
import * as db from '../db/index.js';
import * as auth from '../auth/index.js';
import * as sessions from '../sessions/index.js';
import * as events from '../events/index.js';

const report = {
  sdk_exports: Object.keys(sdk).length,
  errors_exports: Object.keys(errors).length,
  fs_exports: Object.keys(fsmod).length,
  http_exports: Object.keys(http).length,
  logging_exports: Object.keys(logging).length,
  socket_exports: Object.keys(socket).length,
  db_exports: Object.keys(db).length,
  auth_exports: Object.keys(auth).length,
  sessions_exports: Object.keys(sessions).length,
  events_exports: Object.keys(events).length,
  has_swallow: typeof errors.swallow === 'function',
  has_readJsonBody: typeof http.readJsonBody === 'function',
  has_validateRequired: typeof http.validateRequired === 'function',
  has_createLogger: typeof logging.createLogger === 'function',
  has_SocketRegistry: typeof socket.SocketRegistry === 'function',
  has_getDb: typeof db.getDb === 'function',
  has_signToken: typeof auth.signToken === 'function',
  has_mustGetAgentId: typeof auth.mustGetAgentId === 'function',
  has_writeActiveProject: typeof sessions.writeActiveProject === 'function',
  has_emit: typeof events.emit === 'function',
  has_subscribe: typeof events.subscribe === 'function',
  has_getCursor: typeof events.getCursor === 'function',
  has_startVacuum: typeof events.startVacuum === 'function',
};

console.log(JSON.stringify(report, null, 2));

const required = [
  'has_swallow',
  'has_readJsonBody',
  'has_validateRequired',
  'has_createLogger',
  'has_SocketRegistry',
  'has_getDb',
  'has_signToken',
  'has_mustGetAgentId',
  'has_writeActiveProject',
  'has_emit',
  'has_subscribe',
  'has_getCursor',
  'has_startVacuum',
];
for (const key of required) {
  if (!report[key]) {
    console.error(`sdk roundtrip: missing ${key}`);
    process.exit(1);
  }
}
