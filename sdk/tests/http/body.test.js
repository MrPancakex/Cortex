import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readBody, readJsonBody } from '../../http/body.js';

/**
 * Helpers to build mock req streams that behave like Node's IncomingMessage.
 */
function makeReq(chunks = [], opts = {}) {
  const em = new EventEmitter();
  em.destroy = opts.destroy || (() => {});
  process.nextTick(() => {
    for (const chunk of chunks) {
      em.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    em.emit('end');
  });
  return em;
}

function makeErrReq(error) {
  const em = new EventEmitter();
  em.destroy = () => {};
  process.nextTick(() => em.emit('error', error));
  return em;
}

// ---------------------------------------------------------------------------
// readBody
// ---------------------------------------------------------------------------

describe('readBody', () => {
  test('should accumulate chunks and resolve with full Buffer when body is valid', async () => {
    const req = makeReq(['hello', ' ', 'world']);
    const buf = await readBody(req);
    expect(buf.toString()).toBe('hello world');
  });

  test('should resolve with empty Buffer when body is empty', async () => {
    const req = makeReq([]);
    const buf = await readBody(req);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(0);
  });

  test('should reject with statusCode 413 when body exceeds max', async () => {
    const destroyed = [];
    const em = new EventEmitter();
    em.destroy = () => destroyed.push(true);
    process.nextTick(() => {
      em.emit('data', Buffer.alloc(10));
      // will never emit end — reject fires first
    });
    const err = await readBody(em, { max: 5 }).catch((e) => e);
    expect(err.statusCode).toBe(413);
    expect(err.message).toMatch(/payload too large/);
    expect(destroyed).toHaveLength(1);
  });

  test('should reject when request emits an error', async () => {
    const req = makeErrReq(new Error('socket hangup'));
    const err = await readBody(req).catch((e) => e);
    expect(err.message).toBe('socket hangup');
  });

  test('should respect custom max option when it is a tight boundary', async () => {
    const req = makeReq([Buffer.alloc(50)]);
    const buf = await readBody(req, { max: 100 });
    expect(buf.length).toBe(50);
  });

  test('should reject exactly at the byte limit (> not >=)', async () => {
    // 5-byte chunk with max 4 must reject
    const em = new EventEmitter();
    em.destroy = () => {};
    process.nextTick(() => em.emit('data', Buffer.alloc(5)));
    const err = await readBody(em, { max: 4 }).catch((e) => e);
    expect(err.statusCode).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// readJsonBody
// ---------------------------------------------------------------------------

describe('readJsonBody', () => {
  test('should return null when body is empty', async () => {
    const req = makeReq([]);
    const result = await readJsonBody(req);
    expect(result).toBeNull();
  });

  test('should parse and return valid JSON object', async () => {
    const req = makeReq([JSON.stringify({ task_id: 'abc', n: 42 })]);
    const result = await readJsonBody(req);
    expect(result).toEqual({ task_id: 'abc', n: 42 });
  });

  test('should parse valid JSON array', async () => {
    const req = makeReq([JSON.stringify([1, 2, 3])]);
    const result = await readJsonBody(req);
    expect(result).toEqual([1, 2, 3]);
  });

  test('should throw with statusCode 400 when JSON is malformed', async () => {
    const req = makeReq(['{not valid json']);
    const err = await readJsonBody(req).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('invalid json');
    expect(err.detail).toBeDefined();
  });

  test('should propagate 413 when oversized before JSON parse', async () => {
    const em = new EventEmitter();
    em.destroy = () => {};
    process.nextTick(() => em.emit('data', Buffer.alloc(10)));
    const err = await readJsonBody(em, { max: 5 }).catch((e) => e);
    expect(err.statusCode).toBe(413);
  });

  test('should handle multi-chunk JSON body correctly', async () => {
    const body = JSON.stringify({ a: 1, b: 'hello' });
    const mid = Math.floor(body.length / 2);
    const req = makeReq([body.slice(0, mid), body.slice(mid)]);
    const result = await readJsonBody(req);
    expect(result).toEqual({ a: 1, b: 'hello' });
  });

  test('should parse JSON primitives (string)', async () => {
    const req = makeReq(['"just a string"']);
    const result = await readJsonBody(req);
    expect(result).toBe('just a string');
  });
});
