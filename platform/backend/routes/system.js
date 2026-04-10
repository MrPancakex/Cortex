import { Router } from 'express';
import { loadConfig } from '../lib/config.js';
import { SYSTEM } from '../../../shared/constants.js';

const router = Router();

router.get('/status', (req, res) => {
  const config = loadConfig();
  res.json({
    status: 'ok',
    version: SYSTEM.VERSION,
    services: [
      { name: 'backend', port: config.ports.backend, status: 'ok' },
      { name: 'gateway', port: config.ports.gateway, status: 'unknown' }
    ]
  });
});

router.get('/config', (req, res) => {
  const config = loadConfig();
  // Safe subset: no secrets returned
  res.json({
    workspace: config.workspace,
    paths: config.paths,
    ports: config.ports
  });
});

export default router;
