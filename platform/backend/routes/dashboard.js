import { Router } from 'express';
import express from 'express';
import path from 'node:path';

const router = Router();
const distPath = path.resolve('platform/frontend/dist');

// Serve static files
router.use(express.static(distPath));

// Fallback for React Router
router.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

export default router;
