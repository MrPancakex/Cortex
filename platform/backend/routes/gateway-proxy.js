import { Router } from 'express';
import { loadConfig } from '../lib/config.js';
import { getAdminToken } from '../middleware/auth.js';
import fs from 'node:fs';
import path from 'node:path';

const router = Router();

async function proxyToGateway(route, req, res) {
  const config = loadConfig();
  const gatewayUrl = `http://127.0.0.1:${config.ports.gateway}${route}`;
  const token = getAdminToken();

  try {
    const fRes = await fetch(gatewayUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Cortex-Token': token } : {})
      },
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: JSON.stringify(req.body) } : {})
    });
    
    const data = await fRes.json();
    res.status(fRes.status).json(data);
  } catch (err) {
    res.status(503).json({ error: 'gateway_offline', detail: err.message });
  }
}

// === READ routes ===
router.get('/gateway/health', (req, res) => proxyToGateway('/health', req, res));
router.get('/gateway/agents', (req, res) => proxyToGateway('/api/agents', req, res));
router.get('/gateway/logs', (req, res) => proxyToGateway('/api/gateway/logs', req, res));
router.get('/gateway/stats', (req, res) => proxyToGateway('/api/stats', req, res));
router.get('/projects', (req, res) => proxyToGateway('/api/projects', req, res));
router.get('/projects/:id', (req, res) => proxyToGateway(`/api/projects/${req.params.id}`, req, res));
router.get('/projects/:id/summary', (req, res) => proxyToGateway(`/api/projects/${req.params.id}/summary`, req, res));
router.get('/projects/:id/phases', (req, res) => proxyToGateway(`/api/projects/${req.params.id}/phases`, req, res));
router.get('/tasks', (req, res) => proxyToGateway('/api/tasks', req, res));
// Delete request routes must come before :id routes
router.get('/tasks/delete-requests', (req, res) => proxyToGateway('/api/tasks/delete-requests', req, res));
router.post('/tasks/delete-requests/approve-all', (req, res) => proxyToGateway('/api/tasks/delete-requests/approve-all', req, res));
router.post('/tasks/delete-requests/deny-all', (req, res) => proxyToGateway('/api/tasks/delete-requests/deny-all', req, res));
router.get('/tasks/:id', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}`, req, res));
router.get('/tasks/:id/audit', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/audit`, req, res));
router.patch('/projects/:id', (req, res) => proxyToGateway(`/api/projects/${req.params.id}`, req, res));
router.patch('/agents/:id', (req, res) => proxyToGateway(`/api/agents/${req.params.id}`, req, res));
router.get('/bridge/inbox', (req, res) => proxyToGateway('/api/bridge/inbox', req, res));
router.get('/bridge/inbox/:agent', (req, res) => proxyToGateway(`/api/bridge/inbox/${req.params.agent}`, req, res));
router.get('/stats', (req, res) => proxyToGateway('/api/stats', req, res));
router.get('/costs/:agent', (req, res) => proxyToGateway(`/api/costs/${req.params.agent}`, req, res));

// === WRITE routes - Tasks ===
router.post('/tasks', (req, res) => proxyToGateway('/api/tasks', req, res));
router.post('/tasks/:id/claim', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/claim`, req, res));
router.post('/tasks/:id/progress', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/progress`, req, res));
router.post('/tasks/:id/submit', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/submit`, req, res));
router.post('/tasks/:id/request-review', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/request-review`, req, res));
router.post('/tasks/:id/approve', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/approve`, req, res));
router.post('/tasks/:id/reject', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/reject`, req, res));
router.post('/tasks/:id/release', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/release`, req, res));
router.post('/tasks/:id/reassign', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/reassign`, req, res));
router.post('/tasks/:id/reopen', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/reopen`, req, res));
router.post('/tasks/:id/cancel', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/cancel`, req, res));
router.post('/tasks/:id/fail', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/fail`, req, res));
router.post('/tasks/:id/request-delete', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/request-delete`, req, res));
router.post('/tasks/:id/approve-delete', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/approve-delete`, req, res));
router.post('/tasks/:id/deny-delete', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/deny-delete`, req, res));
router.delete('/tasks/:id', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}`, req, res));

// === WRITE routes - Projects ===
router.post('/projects', (req, res) => proxyToGateway('/api/projects', req, res));
router.delete('/projects/:id', (req, res) => proxyToGateway(`/api/projects/${req.params.id}`, req, res));
router.post('/projects/:id/phases', (req, res) => proxyToGateway(`/api/projects/${req.params.id}/phases`, req, res));
router.delete('/projects/:id/phases/:number', (req, res) => proxyToGateway(`/api/projects/${req.params.id}/phases/${req.params.number}`, req, res));
router.post('/projects/:id/sync', (req, res) => proxyToGateway(`/api/projects/${req.params.id}/sync`, req, res));

// === WRITE routes - Bridge ===
router.post('/bridge/send', (req, res) => proxyToGateway('/api/bridge/send', req, res));
router.post('/bridge/reply/:id', (req, res) => proxyToGateway(`/api/bridge/reply/${req.params.id}`, req, res));
router.post('/bridge/ack/:id', (req, res) => proxyToGateway(`/api/bridge/ack/${req.params.id}`, req, res));
router.post('/bridge/ack', (req, res) => proxyToGateway('/api/bridge/ack', req, res));

// === WRITE routes - Agents ===
router.post('/agents/register', (req, res) => proxyToGateway('/api/agents/register', req, res));
router.post('/agents/heartbeat', (req, res) => proxyToGateway('/api/agents/heartbeat', req, res));

// === Subagent tracking ===
router.get('/subagents', (req, res) => proxyToGateway(`/api/subagents?${new URLSearchParams(req.query).toString()}`, req, res));
router.get('/subagents/task/:taskId', (req, res) => proxyToGateway(`/api/subagents/task/${req.params.taskId}`, req, res));
router.post('/subagents/event', (req, res) => proxyToGateway('/api/subagents/event', req, res));
router.post('/subagents/complete', (req, res) => proxyToGateway('/api/subagents/complete', req, res));

// Workspace filesystem READ-ONLY
router.get('/workspace/projects', (req, res) => {
  const config = loadConfig();
  try {
    const entries = fs.readdirSync(config.paths.projects, { withFileTypes: true });
    const formatted = entries.filter(e => e.isDirectory()).map(e => ({
      name: e.name.replace(' (finished)', ''),
      slug: e.name.replace(' (finished)', '').toLowerCase().replace(/\s+/g, '-'),
      finished: e.name.endsWith(' (finished)')
    }));
    res.json(formatted);
  } catch(e) {
    res.status(404).json({ error: 'workspace_not_found', path: config.paths.projects });
  }
});

// Tactical snapshot
router.get('/tactical/snapshot', async (req, res) => {
  const config = loadConfig();
  const token = getAdminToken();
  const base = `http://127.0.0.1:${config.ports.gateway}`;
  const opts = { headers: { ...(token ? { 'X-Cortex-Token': token } : {}) } };

  const safeFetch = (url) => fetch(url, opts).then(r => r.json()).catch(() => null);

  try {
    const [health, agents, stats, tasks, projects, bridge, logs] = await Promise.all([
      safeFetch(`${base}/health`),
      safeFetch(`${base}/api/agents`),
      safeFetch(`${base}/api/stats`),
      safeFetch(`${base}/api/tasks`),
      safeFetch(`${base}/api/projects`),
      safeFetch(`${base}/api/bridge/inbox`),
      safeFetch(`${base}/api/gateway/logs`),
    ]);

    // Enrich projects with their tasks
    let enrichedProjects = null;
    if (projects?.projects && Array.isArray(projects.projects)) {
      const allTasks = tasks?.tasks || [];
      const phaseResults = await Promise.all(
        projects.projects.map(p =>
          safeFetch(`${base}/api/projects/${p.id}/phases`)
        )
      );
      enrichedProjects = projects.projects.map((p, i) => ({
        ...p,
        tasks: allTasks.filter(t => t.project_id === p.id),
        phases: phaseResults[i]?.phases || [],
      }));
    }

    res.json({ health, agents, stats, tasks, projects: enrichedProjects || projects, bridge, logs });
  } catch (e) {
    res.json({ error: 'gateway_offline', status: 'degraded' });
  }
});

export default router;
