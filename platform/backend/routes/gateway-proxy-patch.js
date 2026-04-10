// Task write operations
router.post('/tasks', (req, res) => proxyToGateway('/api/tasks', req, res));
router.post('/tasks/:id/claim', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/claim`, req, res));
router.post('/tasks/:id/submit', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/submit`, req, res));
router.post('/tasks/:id/approve', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/approve`, req, res));
router.post('/tasks/:id/reject', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/reject`, req, res));
router.post('/tasks/:id/release', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/release`, req, res));
router.post('/tasks/:id/reassign', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/reassign`, req, res));
router.post('/tasks/:id/reopen', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}/reopen`, req, res));
router.delete('/tasks/:id', (req, res) => proxyToGateway(`/api/tasks/${req.params.id}`, req, res));

// Project write operations
router.post('/projects', (req, res) => proxyToGateway('/api/projects', req, res));
router.delete('/projects/:id', (req, res) => proxyToGateway(`/api/projects/${req.params.id}`, req, res));
router.post('/projects/:id/phases', (req, res) => proxyToGateway(`/api/projects/${req.params.id}/phases`, req, res));

// Bridge write operations
router.post('/bridge/send', (req, res) => proxyToGateway('/api/bridge/send', req, res));
router.post('/bridge/reply/:id', (req, res) => proxyToGateway(`/api/bridge/reply/${req.params.id}`, req, res));
