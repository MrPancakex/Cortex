import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { swallow } from '../errors/index.js';

export function listenUnix(socketPath, onConnection) {
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('unix.unlink_failed', err);
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer(onConnection);
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (err) {
      swallow('unix.chmod_failed', err);
    }
  });
  return server;
}

export function dialUnix(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}
