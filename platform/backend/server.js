import express from 'express';
import path from 'node:path';
import corsMiddleware from './middleware/cors.js';
import systemRoutes from './routes/system.js';
import dashboardRoutes from './routes/dashboard.js';
import gatewayProxyRoutes from './routes/gateway-proxy.js';
import { loadConfig } from './lib/config.js';

const app = express();
const config = loadConfig();

app.use(corsMiddleware);
app.use(express.json({ limit: '2mb' }));

// Routes
app.use('/api/system', systemRoutes);
app.use('/api', gatewayProxyRoutes);
app.use('/', dashboardRoutes);

const PORT = config.ports?.backend || 4830;

app.listen(PORT, () => {
  console.log(`[Backend] Server listening on port ${PORT}`);
});
